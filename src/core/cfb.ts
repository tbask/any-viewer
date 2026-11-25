/**
 * Reader of the Compound File Binary container (also known as OLE2), a "file system in a file"
 * that holds the legacy Office formats: doc, xls, ppt.
 * Inside are named streams; each format reads its own ("Workbook", "WordDocument", …).
 */

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfbError';
  }
}

export interface CfbEntry {
  name: string;
  /** 1: storage, 2: stream, 5: root. */
  type: number;
  start: number;
  size: number;
  /** true: the entry lies in the container root, not inside a nested object. */
  top: boolean;
}

const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const MAX_STREAM = 512 * 1024 * 1024;

export class CfbReader {
  readonly entries: CfbEntry[] = [];
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private fat: Uint32Array = new Uint32Array(0);
  private miniFat: Uint32Array = new Uint32Array(0);
  private miniStream: Uint8Array = new Uint8Array(0);

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const v = this.view;
    if (data.length < 512 || v.getUint32(0) !== 0xd0cf11e0 || v.getUint32(4) !== 0xa1b11ae1) {
      throw new CfbError('The file is not a legacy Office (CFB) document');
    }
    const sectorShift = v.getUint16(30, true);
    const miniShift = v.getUint16(32, true);
    if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) throw new CfbError('Unsupported sector size');
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    const fatSectors = v.getUint32(44, true);
    const dirStart = v.getUint32(48, true);
    this.miniCutoff = v.getUint32(56, true) || 4096;
    const miniFatStart = v.getUint32(60, true);
    let difatSector = v.getUint32(68, true);
    const difatCount = v.getUint32(72, true);

    // DIFAT: the list of sectors that make up the FAT. The first 109 entries are in the header.
    const fatLocations: number[] = [];
    for (let i = 0; i < 109 && fatLocations.length < fatSectors; i++) {
      const s = v.getUint32(76 + i * 4, true);
      if (s !== FREE && s !== END_OF_CHAIN) fatLocations.push(s);
    }
    const perSector = this.sectorSize / 4;
    for (let n = 0; n < difatCount && difatSector !== END_OF_CHAIN && difatSector !== FREE; n++) {
      const off = this.sectorOffset(difatSector);
      for (let i = 0; i < perSector - 1 && fatLocations.length < fatSectors; i++) {
        const s = v.getUint32(off + i * 4, true);
        if (s !== FREE && s !== END_OF_CHAIN) fatLocations.push(s);
      }
      difatSector = v.getUint32(off + (perSector - 1) * 4, true);
    }

    this.fat = new Uint32Array(fatLocations.length * perSector);
    fatLocations.forEach((sector, k) => {
      const off = this.sectorOffset(sector);
      for (let i = 0; i < perSector; i++) this.fat[k * perSector + i] = v.getUint32(off + i * 4, true);
    });

    const dir = this.readChain(dirStart, MAX_STREAM);
    const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    const decoder = new TextDecoder('utf-16le');
    const byId = new Map<number, CfbEntry>();
    const links = new Map<number, [number, number, number]>();
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const type = dir[off + 66];
      if (type === 0) continue;
      const nameLen = Math.min(dv.getUint16(off + 64, true), 64);
      const entry: CfbEntry = {
        name: decoder.decode(dir.subarray(off, off + Math.max(0, nameLen - 2))),
        type,
        start: dv.getUint32(off + 116, true),
        size: dv.getUint32(off + 120, true),
        top: false,
      };
      this.entries.push(entry);
      byId.set(off / 128, entry);
      links.set(off / 128, [dv.getUint32(off + 68, true), dv.getUint32(off + 72, true), dv.getUint32(off + 76, true)]);
    }
    // Root entries: the child node of the root and all its tree "siblings". Nested objects (an Excel workbook
    // inside a Word document, say) lie deeper and must not affect format detection.
    const rootId = [...byId.entries()].find(([, e]) => e.type === 5)?.[0];
    if (rootId !== undefined) {
      const stack = [links.get(rootId)![2]];
      const seen = new Set<number>();
      while (stack.length) {
        const id = stack.pop()!;
        const entry = byId.get(id);
        if (!entry || seen.has(id)) continue;
        seen.add(id);
        entry.top = true;
        const [left, right] = links.get(id)!;
        stack.push(left, right);
      }
    } else {
      for (const e of this.entries) e.top = true;
    }

    const root = this.entries.find((e) => e.type === 5);
    if (root && miniFatStart !== END_OF_CHAIN && miniFatStart !== FREE) {
      const mf = this.readChain(miniFatStart, MAX_STREAM);
      this.miniFat = new Uint32Array(mf.length >> 2);
      const mv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
      for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mv.getUint32(i * 4, true);
      this.miniStream = this.readChain(root.start, root.size || MAX_STREAM);
    }
  }

  static async open(source: Blob | Uint8Array): Promise<CfbReader> {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
    return new CfbReader(bytes);
  }

  private sectorOffset(sector: number): number {
    const off = (sector + 1) * this.sectorSize;
    if (off + this.sectorSize > this.data.length + this.sectorSize - 1 || off < 0) throw new CfbError('The file is corrupt: sector outside the file');
    return off;
  }

  private readChain(start: number, size: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let sector = start;
    let guard = 0;
    while (sector !== END_OF_CHAIN && sector !== FREE && total < size) {
      if (sector >= this.fat.length || ++guard > this.fat.length + 1) throw new CfbError('The file is corrupt: sector chain loops');
      const off = this.sectorOffset(sector);
      const chunk = this.data.subarray(off, Math.min(off + this.sectorSize, this.data.length));
      chunks.push(chunk);
      total += chunk.length;
      sector = this.fat[sector];
    }
    const out = new Uint8Array(Math.min(total, size));
    let pos = 0;
    for (const c of chunks) {
      if (pos >= out.length) break;
      out.set(c.subarray(0, Math.min(c.length, out.length - pos)), pos);
      pos += c.length;
    }
    return out;
  }

  private readMiniChain(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let pos = 0;
    let sector = start;
    let guard = 0;
    while (sector !== END_OF_CHAIN && sector !== FREE && pos < size) {
      if (sector >= this.miniFat.length || ++guard > this.miniFat.length + 1) throw new CfbError('The file is corrupt: mini-sector chain loops');
      const off = sector * this.miniSectorSize;
      const len = Math.min(this.miniSectorSize, size - pos);
      out.set(this.miniStream.subarray(off, off + len), pos);
      pos += len;
      sector = this.miniFat[sector];
    }
    return out;
  }

  /** Finds a stream by name (case-insensitive): first in the container root, then at any level. */
  find(...names: string[]): CfbEntry | undefined {
    for (const topOnly of [true, false]) {
      for (const name of names) {
        const lower = name.toLowerCase();
        const found = this.entries.find((e) => e.type === 2 && (!topOnly || e.top) && e.name.toLowerCase() === lower);
        if (found) return found;
      }
    }
    return undefined;
  }

  /** Names of the root streams of the container, in lower case. */
  topNames(): string[] {
    return this.entries.filter((e) => e.top).map((e) => e.name.toLowerCase());
  }

  read(entry: CfbEntry): Uint8Array {
    if (entry.size > MAX_STREAM) throw new CfbError('The stream is too large');
    if (entry.size < this.miniCutoff && entry.type !== 5) return this.readMiniChain(entry.start, entry.size);
    return this.readChain(entry.start, entry.size);
  }
}
