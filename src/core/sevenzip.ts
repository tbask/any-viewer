/**
 * 7z archives: the file list (names and sizes) and extraction of files.
 * The header is usually compressed (LZMA); the package has its own decompressor for it.
 */
import { bzip2Decode } from './bzip2';
import { inflateRaw } from './inflate';
import { lzma2Decode, lzmaDecode } from './lzma';
import { ArchivePasswordError } from './rar';
import type { ArchiveEntry } from './tar';

const bad = () => new Error('The 7z archive is corrupt');

class Reader {
  p = 0;
  constructor(readonly b: Uint8Array) {}
  byte(): number {
    if (this.p >= this.b.length) throw bad();
    return this.b[this.p++];
  }
  /** Variable-length number of the 7z format. */
  num(): number {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if (!(first & mask)) return value + (first & (mask - 1)) * 2 ** (8 * i);
      value += this.byte() * 2 ** (8 * i);
      mask >>= 1;
    }
    return value;
  }
  skip(n: number): void {
    this.p += n;
    if (this.p > this.b.length) throw bad();
  }
  bits(count: number): boolean[] {
    const out: boolean[] = [];
    let cur = 0;
    for (let i = 0; i < count; i++) {
      if (i % 8 === 0) cur = this.byte();
      out.push((cur & (0x80 >> (i % 8))) !== 0);
    }
    return out;
  }
  /** A set of "value is defined" flags: either all, or a bitmap. */
  defined(count: number): boolean[] {
    return this.byte() ? new Array<boolean>(count).fill(true) : this.bits(count);
  }
}

interface Coder {
  id: string;
  props: Uint8Array;
}
interface Folder {
  coders: Coder[];
  /** Index of the output stream that is the result of the whole chain. */
  mainOut: number;
  outCount: number;
  packCount: number;
  sizes: number[];
  hasCrc: boolean;
}
interface Streams {
  packPos: number;
  packSizes: number[];
  folders: Folder[];
  /** File sizes in order. */
  fileSizes: number[];
  /** How many files lie in each folder (compression block). */
  counts: number[];
}

function readFolder(r: Reader): Folder {
  const coders: Coder[] = [];
  const count = r.num();
  if (count < 1 || count > 32) throw bad();
  let ins = 0;
  let outs = 0;
  for (let i = 0; i < count; i++) {
    const flags = r.byte();
    const idSize = flags & 0x0f;
    const id = Array.from(r.b.subarray(r.p, r.p + idSize), (x) => x.toString(16).padStart(2, '0')).join('');
    r.skip(idSize);
    if (flags & 0x10) {
      ins += r.num();
      outs += r.num();
    } else {
      ins++;
      outs++;
    }
    let props: Uint8Array = new Uint8Array(0);
    if (flags & 0x20) {
      const size = r.num();
      props = r.b.subarray(r.p, r.p + size);
      r.skip(size);
    }
    coders.push({ id, props });
  }
  const bound = new Set<number>();
  for (let i = 0; i < outs - 1; i++) {
    r.num();
    bound.add(r.num());
  }
  const packCount = ins - (outs - 1);
  if (packCount > 1) for (let i = 0; i < packCount; i++) r.num();
  let mainOut = 0;
  for (let i = 0; i < outs; i++) if (!bound.has(i)) mainOut = i;
  return { coders, mainOut, outCount: outs, packCount, sizes: [], hasCrc: false };
}

function readStreams(r: Reader): Streams {
  const s: Streams = { packPos: 0, packSizes: [], folders: [], fileSizes: [], counts: [] };
  let perFolder: number[] | null = null;
  let subSizesRead = false;
  for (let id = r.byte(); id !== 0x00; id = r.byte()) {
    if (id === 0x06) {
      s.packPos = r.num();
      const n = r.num();
      for (let t = r.byte(); t !== 0x00; t = r.byte()) {
        if (t === 0x09) for (let i = 0; i < n; i++) s.packSizes.push(r.num());
        else if (t === 0x0a) r.skip(r.defined(n).filter(Boolean).length * 4);
        else throw bad();
      }
    } else if (id === 0x07) {
      if (r.byte() !== 0x0b) throw bad();
      const n = r.num();
      if (n > 100_000 || r.byte() !== 0) throw bad();
      for (let i = 0; i < n; i++) s.folders.push(readFolder(r));
      if (r.byte() !== 0x0c) throw bad();
      for (const f of s.folders) for (let i = 0; i < f.outCount; i++) f.sizes.push(r.num());
      for (let t = r.byte(); t !== 0x00; t = r.byte()) {
        if (t !== 0x0a) throw bad();
        const def = r.defined(n);
        def.forEach((d, i) => (s.folders[i].hasCrc = d));
        r.skip(def.filter(Boolean).length * 4);
      }
    } else if (id === 0x08) {
      perFolder = s.folders.map(() => 1);
      for (let t = r.byte(); t !== 0x00; t = r.byte()) {
        if (t === 0x0d) perFolder = s.folders.map(() => r.num());
        else if (t === 0x09) {
          subSizesRead = true;
          s.folders.forEach((f, i) => {
            const n = perFolder![i];
            let rest = f.sizes[f.mainOut];
            for (let k = 0; k < n - 1; k++) {
              const size = r.num();
              s.fileSizes.push(size);
              rest -= size;
            }
            if (n > 0) s.fileSizes.push(rest);
          });
        } else if (t === 0x0a) {
          let unknown = 0;
          s.folders.forEach((f, i) => {
            if (!(perFolder![i] === 1 && f.hasCrc)) unknown += perFolder![i];
          });
          r.skip(r.defined(unknown).filter(Boolean).length * 4);
        } else throw bad();
      }
    } else throw bad();
  }
  if (!subSizesRead) {
    // Without a sizes section every folder holds one file (or sizes of single files are not recorded).
    s.folders.forEach((f, i) => {
      const n = perFolder ? perFolder[i] : 1;
      if (n === 1) s.fileSizes.push(f.sizes[f.mainOut]);
    });
  }
  s.counts = s.folders.map((_, i) => (perFolder ? perFolder[i] : 1));
  return s;
}

/** Decompresses a compressed header. */
function decodeHeader(data: Uint8Array, s: Streams, maxSize: number): Uint8Array {
  const folder = s.folders[0];
  if (!folder || s.folders.length !== 1 || !s.packSizes.length) throw bad();
  if (folder.coders.some((c) => c.id === '06f10701')) throw new ArchivePasswordError();
  if (folder.coders.length !== 1) throw new Error('Unknown compression method of the 7z header');
  const size = folder.sizes[folder.mainOut];
  if (size > maxSize) throw new Error('The archive header is too large');
  const start = 32 + s.packPos;
  const packed = data.subarray(start, start + s.packSizes[0]);
  if (packed.length !== s.packSizes[0]) throw bad();
  const coder = folder.coders[0];
  if (coder.id === '030101') return lzmaDecode(packed, coder.props, size);
  if (coder.id === '21') return lzma2Decode(packed, size);
  if (coder.id === '00') return packed;
  throw new Error('Unknown compression method of the 7z header');
}

/** LZMA, LZMA2, Copy, Deflate, BZip2. */
const COMPRESSORS = ['030101', '21', '00', '040108', '040202'];
const BCJ_X86 = '03030103';

/** A folder can be unpacked: one compression method and, possibly, the x86 filter after it. */
function isUsable(folder: Folder): boolean {
  if (folder.packCount !== 1 || folder.coders.length > 2) return false;
  const main = folder.coders.filter((c) => COMPRESSORS.includes(c.id));
  return main.length === 1 && folder.coders.every((c) => COMPRESSORS.includes(c.id) || c.id === BCJ_X86);
}

/**
 * Inverse x86 filter (BCJ): before compression, addresses in jump instructions are made absolute,
 * so executables compress better; here they are restored to the original form.
 */
function bcjX86Decode(buf: Uint8Array): void {
  const allowed = [true, true, true, false, true, false, false, false];
  const bitNumber = [0, 1, 2, 2, 3, 3, 3, 3];
  const edge = (b: number) => b === 0 || b === 0xff;
  let prevMask = 0;
  let prevPos = -5;
  const limit = buf.length - 5;
  for (let i = 0; i <= limit; ) {
    if ((buf[i] & 0xfe) !== 0xe8) {
      i++;
      continue;
    }
    const offset = i - prevPos;
    prevPos = i;
    if (offset > 5) prevMask = 0;
    else for (let k = 0; k < offset; k++) prevMask = (prevMask & 0x77) << 1;
    const top = buf[i + 4];
    if (edge(top) && allowed[(prevMask >> 1) & 7] && prevMask >> 1 < 0x10) {
      let src = ((top << 24) | (buf[i + 3] << 16) | (buf[i + 2] << 8) | buf[i + 1]) >>> 0;
      let dest: number;
      for (;;) {
        dest = (src - (i + 5)) >>> 0;
        if (prevMask === 0) break;
        const index = bitNumber[prevMask >> 1];
        if (!edge((dest >>> (24 - index * 8)) & 0xff)) break;
        src = (dest ^ (2 ** (32 - index * 8) - 1)) >>> 0;
      }
      buf[i + 4] = (dest >>> 24) & 1 ? 0xff : 0;
      buf[i + 3] = (dest >>> 16) & 0xff;
      buf[i + 2] = (dest >>> 8) & 0xff;
      buf[i + 1] = dest & 0xff;
      i += 5;
      prevMask = 0;
    } else {
      i++;
      prevMask |= 1;
      if (edge(top)) prevMask |= 0x10;
    }
  }
}

/** Unpacks a folder (compression block) as a whole; undefined: the compression method is not supported. */
function decodeFolder(data: Uint8Array, s: Streams, index: number, maxSize: number): Uint8Array | undefined {
  const folder = s.folders[index];
  if (!folder || !isUsable(folder)) return undefined;
  const coderIndex = folder.coders.findIndex((c) => COMPRESSORS.includes(c.id));
  const coder = folder.coders[coderIndex];
  const size = folder.sizes[coderIndex] ?? folder.sizes[folder.mainOut];
  if (size > maxSize) throw new Error('The file in the archive is too large');
  let packIndex = 0;
  for (let i = 0; i < index; i++) packIndex += s.folders[i].packCount;
  let start = 32 + s.packPos;
  for (let i = 0; i < packIndex; i++) start += s.packSizes[i];
  const packedSize = s.packSizes[packIndex];
  if (packedSize === undefined || start + packedSize > data.length) throw bad();
  const packed = data.subarray(start, start + packedSize);
  let out =
    coder.id === '030101' ? lzmaDecode(packed, coder.props, size)
    : coder.id === '21' ? lzma2Decode(packed, size)
    : coder.id === '040108' ? inflateRaw(packed, size, maxSize)
    : coder.id === '040202' ? bzip2Decode(packed, maxSize)
    : packed;
  if (folder.coders.some((c) => c.id === BCJ_X86)) {
    if (out === packed) out = out.slice();
    bcjX86Decode(out);
  }
  return out;
}

export function list7z(data: Uint8Array, maxEntries = 10_000, maxHeaderBytes = 64 * 1024 * 1024, maxUnpack = 200 * 1024 * 1024): ArchiveEntry[] {
  if (data.length < 32) throw bad();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = Number(view.getBigUint64(12, true));
  const size = Number(view.getBigUint64(20, true));
  if (size === 0) return [];
  if (32 + offset + size > data.length) throw bad();
  let header = data.subarray(32 + offset, 32 + offset + size);
  for (let depth = 0; header[0] === 0x17; depth++) {
    if (depth > 3) throw bad();
    const r = new Reader(header);
    r.byte();
    header = decodeHeader(data, readStreams(r), maxHeaderBytes);
  }
  const r = new Reader(header);
  if (r.byte() !== 0x01) throw bad();
  let fileSizes: number[] = [];
  let main: Streams | undefined;
  let names: string[] = [];
  let emptyStream: boolean[] = [];
  let emptyFile: boolean[] = [];
  let count = 0;
  for (let id = r.byte(); id !== 0x00; id = r.byte()) {
    if (id === 0x02) {
      for (let t = r.byte(); t !== 0x00; t = r.byte()) r.skip(r.num());
    } else if (id === 0x03) {
      readStreams(r);
    } else if (id === 0x04) {
      main = readStreams(r);
      fileSizes = main.fileSizes;
    } else if (id === 0x05) {
      count = r.num();
      if (count > 10_000_000) throw bad();
      for (let t = r.byte(); t !== 0x00; t = r.byte()) {
        const length = r.num();
        const end = r.p + length;
        if (t === 0x0e) emptyStream = r.bits(count);
        else if (t === 0x0f) emptyFile = r.bits(emptyStream.filter(Boolean).length);
        else if (t === 0x11) {
          if (r.byte() !== 0) throw new Error('7z file names are stored in an external stream');
          const text = new TextDecoder('utf-16le').decode(header.subarray(r.p, end));
          names = text.split('\0');
        }
        r.p = end;
        if (r.p > header.length) throw bad();
      }
    } else throw bad();
  }
  // Place of every file: folder index and offset inside the unpacked data. Encrypted and multi-coder folders are skipped.
  const places: ({ folder: number; offset: number } | undefined)[] = [];
  if (main) {
    let stream = 0;
    main.folders.forEach((folder, index) => {
      const usable = isUsable(folder);
      let offset = 0;
      for (let k = 0; k < main!.counts[index]; k++, stream++) {
        places[stream] = usable ? { folder: index, offset } : undefined;
        offset += fileSizes[stream] ?? 0;
      }
    });
  }
  let cache: { folder: number; bytes: Uint8Array } | undefined;
  const entries: ArchiveEntry[] = [];
  let sizeIndex = 0;
  let emptyIndex = 0;
  for (let i = 0; i < count && entries.length < maxEntries; i++) {
    const name = (names[i] ?? '').replace(/\\/g, '/');
    if (emptyStream[i]) {
      const directory = !emptyFile[emptyIndex++];
      entries.push({ name, size: 0, directory });
    } else {
      const stream = sizeIndex++;
      const entry: ArchiveEntry = { name, size: fileSizes[stream] ?? 0, directory: false };
      const place = places[stream];
      const streams = main;
      if (place && streams) {
        entry.read = () => {
          // A folder is unpacked as a whole and cached: neighbouring files usually lie in the same one.
          if (!cache || cache.folder !== place.folder) {
            const bytes = decodeFolder(data, streams, place.folder, maxUnpack);
            if (!bytes) throw new Error('The compression method of this file in the 7z archive is not supported');
            cache = { folder: place.folder, bytes };
          }
          return cache.bytes.subarray(place.offset, place.offset + entry.size);
        };
      }
      entries.push(entry);
    }
  }
  return entries;
}
