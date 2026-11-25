/**
 * An own ZIP archive reader.
 *
 * Works on top of a Blob: reads only the central directory and the entries that are requested,
 * so a large docx/xlsx is not loaded into memory as a whole.
 * Supports methods 0 (stored), 8 (deflate), 12 (BZip2) and 14 (LZMA), ZIP64 and CRC-32 verification.
 */
import { inflateRaw } from './inflate';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  crc32: number;
  isDirectory: boolean;
  encrypted: boolean;
  /** Offset of the entry's local header. */
  headerOffset: number;
}

export interface ZipOptions {
  /** Maximum unpacked size of one entry (a guard against zip bombs). Default: 256 MB. */
  maxEntrySize?: number;
  /** Maximum number of entries in an archive. Default: 100,000. */
  maxEntries?: number;
  /** Whether to verify the CRC-32 of unpacked data. Default: true. */
  verifyCrc?: boolean;
  /** Do not use DecompressionStream even when present (for tests). */
  forceJsInflate?: boolean;
  /** Do not try to read a truncated archive by local headers. */
  noRecovery?: boolean;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBlob(data: Blob | Uint8Array | ArrayBuffer): Blob {
  if (data instanceof Blob) return data;
  return new Blob([data as BlobPart]);
}

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function u64(view: DataView, offset: number): number {
  const v = view.getBigUint64(offset, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('The archive is too large');
  return Number(v);
}

const utf8 = new TextDecoder('utf-8');
let legacyDecoder: TextDecoder | null | undefined;

/** An entry name: UTF-8 when flagged or valid, otherwise the DOS code page of old archives with Cyrillic names. */
export function decodeName(bytes: Uint8Array, isUtf8: boolean): string {
  if (isUtf8) return utf8.decode(bytes);
  let ascii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) return utf8.decode(bytes);
  // Names without the UTF-8 flag: first try UTF-8 (many archivers do that),
  // then cp866, the typical encoding of old archives with Cyrillic names.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (legacyDecoder === undefined) {
      try {
        legacyDecoder = new TextDecoder('ibm866');
      } catch {
        legacyDecoder = null;
      }
    }
    return (legacyDecoder ?? utf8).decode(bytes);
  }
}

async function inflateWithStream(data: Uint8Array, maxSize: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxSize) {
      await reader.cancel();
      throw new ZipError('The unpacked data exceeds the size limit');
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export class ZipReader {
  readonly entries: ZipEntry[];
  /** true: the central directory was not found (the file is truncated); entries were collected from local headers. */
  recovered = false;
  private readonly blob: Blob;
  private readonly byName: Map<string, ZipEntry>;
  private readonly options: Required<ZipOptions>;

  private constructor(blob: Blob, entries: ZipEntry[], options: Required<ZipOptions>) {
    this.blob = blob;
    this.entries = entries;
    this.options = options;
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  static async open(data: Blob | Uint8Array | ArrayBuffer, options: ZipOptions = {}): Promise<ZipReader> {
    try {
      return await ZipReader.openStrict(data, options);
    } catch (err) {
      if (!(err instanceof ZipError) || options.noRecovery) throw err;
      const zip = await ZipReader.recover(data, options);
      if (!zip) throw err;
      return zip;
    }
  }

  /**
   * Truncated archive: the central directory lies at the end of the file and is lost, but every file has its own header.
   * Walk them from the start and collect everything that survived whole.
   */
  private static async recover(data: Blob | Uint8Array | ArrayBuffer, options: ZipOptions): Promise<ZipReader | null> {
    const blob = toBlob(data);
    if (blob.size > 512 * 1024 * 1024) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries: ZipEntry[] = [];
    let p = 0;
    while (p + 30 <= bytes.length && view.getUint32(p, true) === SIG_LOCAL) {
      const flags = view.getUint16(p + 6, true);
      const method = view.getUint16(p + 8, true);
      const compressedSize = view.getUint32(p + 18, true);
      const size = view.getUint32(p + 22, true);
      const nameLen = view.getUint16(p + 26, true);
      const extraLen = view.getUint16(p + 28, true);
      // Sizes after the data (bit 3) or ZIP64 cannot be recovered without the central directory.
      if (flags & 0x08 || compressedSize === 0xffffffff) break;
      const end = p + 30 + nameLen + extraLen + compressedSize;
      if (end > bytes.length) break;
      const name = decodeName(bytes.subarray(p + 30, p + 30 + nameLen), (flags & 0x800) !== 0);
      entries.push({ name, size, compressedSize, method, crc32: view.getUint32(p + 14, true), isDirectory: name.endsWith('/'), encrypted: (flags & 1) !== 0, headerOffset: p });
      p = end;
    }
    if (!entries.length) return null;
    const zip = new ZipReader(blob, entries, {
      maxEntrySize: options.maxEntrySize ?? 256 * 1024 * 1024,
      maxEntries: options.maxEntries ?? 100_000,
      verifyCrc: options.verifyCrc ?? true,
      forceJsInflate: options.forceJsInflate ?? false,
      noRecovery: false,
    });
    zip.recovered = true;
    return zip;
  }

  private static async openStrict(data: Blob | Uint8Array | ArrayBuffer, options: ZipOptions = {}): Promise<ZipReader> {
    const opts: Required<ZipOptions> = {
      maxEntrySize: options.maxEntrySize ?? 256 * 1024 * 1024,
      maxEntries: options.maxEntries ?? 100_000,
      verifyCrc: options.verifyCrc ?? true,
      forceJsInflate: options.forceJsInflate ?? false,
      noRecovery: options.noRecovery ?? false,
    };
    const blob = toBlob(data);
    const size = blob.size;
    if (size < 22) throw new ZipError('The file is not a ZIP archive');

    // The end of central directory (EOCD) is searched in the file tail: 22 bytes + a comment of up to 65535 bytes.
    const tailStart = Math.max(0, size - (22 + 0xffff));
    const tail = await readRange(blob, tailStart, size);
    const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('ZIP central directory not found');

    let total = tv.getUint16(eocd + 10, true);
    let cdSize = tv.getUint32(eocd + 12, true);
    let cdOffset = tv.getUint32(eocd + 16, true);

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tv.getUint32(loc, true) !== SIG_EOCD64_LOCATOR) throw new ZipError('Corrupt ZIP64 header');
      const eocd64Offset = u64(tv, loc + 8);
      const rec = await readRange(blob, eocd64Offset, eocd64Offset + 56);
      const rv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
      if (rec.length < 56 || rv.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('Corrupt ZIP64 header');
      total = u64(rv, 32);
      cdSize = u64(rv, 40);
      cdOffset = u64(rv, 48);
    }

    if (total > opts.maxEntries) throw new ZipError('The archive has too many files');
    if (cdOffset + cdSize > size) throw new ZipError('The ZIP central directory extends beyond the file');

    const cd = await readRange(blob, cdOffset, cdOffset + cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError('Corrupt ZIP central directory');
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      const crc = cv.getUint32(p + 16, true);
      let compressedSize = cv.getUint32(p + 20, true);
      let uncompressedSize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let headerOffset = cv.getUint32(p + 42, true);
      const nameStart = p + 46;
      if (nameStart + nameLen + extraLen + commentLen > cd.length) throw new ZipError('Corrupt ZIP central directory');
      const name = decodeName(cd.subarray(nameStart, nameStart + nameLen), (flags & 0x800) !== 0);

      // The ZIP64 extra field (id 0x0001) holds only the values that overflowed.
      let e = nameStart + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cv.getUint16(e, true);
        const len = cv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff && q + 8 <= extraEnd) {
            uncompressedSize = u64(cv, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff && q + 8 <= extraEnd) {
            compressedSize = u64(cv, q);
            q += 8;
          }
          if (headerOffset === 0xffffffff && q + 8 <= extraEnd) headerOffset = u64(cv, q);
        }
        e += 4 + len;
      }

      entries.push({
        name,
        size: uncompressedSize,
        compressedSize,
        method,
        crc32: crc,
        isDirectory: name.endsWith('/'),
        encrypted: (flags & 0x1) !== 0,
        headerOffset,
      });
      p = extraEnd + commentLen;
    }
    return new ZipReader(blob, entries, opts);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** Reads and unpacks an entry as a whole. */
  async read(entryOrName: ZipEntry | string): Promise<Uint8Array> {
    const entry = typeof entryOrName === 'string' ? this.byName.get(entryOrName) : entryOrName;
    if (!entry) throw new ZipError(`No file "${String(entryOrName)}" in the archive`);
    if (entry.encrypted) throw new ZipError('The archive is encrypted');
    const max = this.options.maxEntrySize;
    if (entry.size > max) throw new ZipError('The file inside the archive is too large');

    const head = await readRange(this.blob, entry.headerOffset, entry.headerOffset + 30);
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('Corrupt local file header');
    const dataStart = entry.headerOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const compressed = await readRange(this.blob, dataStart, dataStart + entry.compressedSize);
    if (compressed.length !== entry.compressedSize) throw new ZipError('The archive is truncated');

    let data: Uint8Array;
    if (entry.method === 0) {
      data = compressed;
    } else if (entry.method === 8) {
      if (!this.options.forceJsInflate && typeof DecompressionStream !== 'undefined') {
        try {
          data = await inflateWithStream(compressed, max);
        } catch (err) {
          if (err instanceof ZipError) throw err;
          // Some implementations do not know 'deflate-raw' or are stricter about the stream tail.
          data = inflateRaw(compressed, entry.size, max);
        }
      } else {
        data = inflateRaw(compressed, entry.size, max);
      }
    } else if (entry.method === 12) {
      // BZip2 and LZMA are rare in zip: their decompressors are loaded only on demand.
      data = (await import('./bzip2')).bzip2Decode(compressed, max);
    } else if (entry.method === 14 && compressed.length > 9) {
      // LZMA: version (2 bytes), properties length (2 bytes), properties, then the stream itself.
      const propsSize = compressed[2] | (compressed[3] << 8);
      data = (await import('./lzma')).lzmaDecode(compressed.subarray(4 + propsSize), compressed.subarray(4, 4 + propsSize), entry.size);
    } else {
      throw new ZipError(`Unsupported compression method (${entry.method})`);
    }

    if (data.length !== entry.size) throw new ZipError('The unpacked size does not match the central directory');
    if (this.options.verifyCrc && crc32(data) !== entry.crc32) throw new ZipError('Checksum error: the archive is corrupt');
    return data;
  }

  async readText(entryOrName: ZipEntry | string): Promise<string> {
    return utf8.decode(await this.read(entryOrName));
  }
}
