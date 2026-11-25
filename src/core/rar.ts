/**
 * RAR archives (versions 1.5–4 and 5): the file list — names and sizes.
 *
 * Only the archive container is read, as RARLAB documents it: "RAR 5.0 archive format"
 * (https://www.rarlab.com/technote.htm) and the technote.txt distributed with RAR 3–4.
 * RAR compression is proprietary and has no public specification. It is not implemented here and no UnRAR
 * code is used, so compressed files are listed but cannot be opened. Files kept without compression
 * ("stored") are returned as they are.
 */
import { decodeName } from './zip';
import type { ArchiveEntry } from './tar';

/** What a click on a compressed file ends with: the viewer shows its "cannot open the file from the archive" notice. */
const notExtractable = (): never => {
  throw new Error('Files compressed with RAR cannot be extracted: RAR decompression is not implemented');
};

export class ArchivePasswordError extends Error {
  constructor() {
    super('The archive header is encrypted');
    this.name = 'PasswordError';
  }
}

const utf8 = new TextDecoder('utf-8');
const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const u32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/**
 * A RAR 1.5–4 file name. With flag 0x0200 the field holds the usual name, a zero byte and a Unicode name in an
 * encoding the format documentation does not describe, so the usual name is taken: UTF-8 in archives made on
 * Unix and macOS, the DOS code page in archives made on Windows.
 */
function rar4Name(raw: Uint8Array, hasUnicodePart: boolean): string {
  const zero = hasUnicodePart ? raw.indexOf(0) : -1;
  return decodeName(zero < 0 ? raw : raw.subarray(0, zero), false);
}

function listRar4(data: Uint8Array, start: number, max: number): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let p = start;
  let sawMain = false;
  while (p + 7 <= data.length && entries.length < max) {
    const type = data[p + 2];
    const flags = u16(data, p + 3);
    const headSize = u16(data, p + 5);
    if (headSize < 7) throw new Error('The RAR archive is corrupt');
    if (type === 0x73) {
      sawMain = true;
      if (flags & 0x0080) throw new ArchivePasswordError();
    } else if (!sawMain) throw new Error('The RAR archive is corrupt');
    if (type === 0x7b) break;
    let dataSize = 0;
    if (type === 0x74 || type === 0x7a) {
      if (p + 32 > data.length) break;
      dataSize = u32(data, p + 7);
      let size = u32(data, p + 11);
      const nameSize = u16(data, p + 26);
      let nameAt = p + 32;
      if (flags & 0x0100) {
        dataSize += u32(data, p + 32) * 2 ** 32;
        size += u32(data, p + 36) * 2 ** 32;
        nameAt += 8;
      }
      // A file continued from the previous volume is already in the list.
      if (type === 0x74 && !(flags & 0x01)) {
        const raw = data.subarray(nameAt, nameAt + nameSize);
        const name = rar4Name(raw, (flags & 0x0200) !== 0).replace(/\\/g, '/');
        const directory = (flags & 0xe0) === 0xe0;
        const entry: ArchiveEntry = { name, size: directory ? 0 : size, directory };
        // A file without compression (method 0x30, "stored"), without encryption and not continued in another volume is taken as is.
        const at = p + headSize;
        const stored = data[p + 25] === 0x30;
        const whole = !(flags & 0x07) && at + dataSize <= data.length;
        if (!directory) entry.read = stored && whole && dataSize === size ? () => data.subarray(at, at + size) : notExtractable;
        entries.push(entry);
      }
    } else if (flags & 0x8000) {
      dataSize = u32(data, p + 7);
    }
    p += headSize + dataSize;
  }
  if (!sawMain) throw new Error('The RAR archive is corrupt');
  return entries;
}

/** Extra area of a RAR5 file header: whether it has an encryption record (type 1). */
function hasEncryption(data: Uint8Array, from: number, to: number): boolean {
  let p = from;
  const vint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 63 && p < to; shift += 7) {
      const b = data[p++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  while (p < to) {
    const size = vint();
    const start = p;
    if (size <= 0 || start + size > to) return false;
    if (vint() === 1) return true;
    p = start + size;
  }
  return false;
}

function listRar5(data: Uint8Array, start: number, max: number): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let p = start;
  const vint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      if (p >= data.length) throw new Error('The RAR archive is corrupt');
      const b = data[p++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
    throw new Error('The RAR archive is corrupt');
  };
  let sawMain = false;
  while (p + 7 <= data.length && entries.length < max) {
    p += 4; // header checksum
    const headSize = vint();
    const headStart = p;
    if (!headSize || headStart + headSize > data.length) throw new Error('The RAR archive is corrupt');
    const type = vint();
    const flags = vint();
    if (flags & 1) vint(); // size of the extra area
    const dataSize = flags & 2 ? vint() : 0;
    if (type === 4) throw new ArchivePasswordError();
    if (type === 1) sawMain = true;
    else if (!sawMain) throw new Error('The RAR archive is corrupt');
    if (type === 5) break;
    if (type === 2) {
      const fileFlags = vint();
      const size = vint();
      vint(); // attributes
      if (fileFlags & 2) p += 4;
      if (fileFlags & 4) p += 4; // checksum of the file data
      const compression = vint();
      vint(); // host system
      const nameLength = vint();
      const name = utf8.decode(data.subarray(p, p + nameLength));
      const directory = (fileFlags & 1) !== 0;
      // Flag 0x08 in the common flags: continuation of a file from the previous volume.
      if (!(flags & 8)) {
        const entry: ArchiveEntry = { name, size: directory ? 0 : size, directory };
        // Compression method 0 is "stored". An encrypted file differs by its data size (service bytes are added to it).
        const at = headStart + headSize;
        const method = (compression >> 7) & 7;
        const whole = !(flags & 0x18) && at + dataSize <= data.length && !hasEncryption(data, p + nameLength, headStart + headSize);
        if (!directory) entry.read = method === 0 && whole && dataSize === size ? () => data.subarray(at, at + size) : notExtractable;
        entries.push(entry);
      }
    }
    p = headStart + headSize + dataSize;
  }
  if (!sawMain) throw new Error('The RAR archive is corrupt');
  return entries;
}

export function listRar(data: Uint8Array, maxEntries = 10_000): ArchiveEntry[] {
  // A self-extraction module may precede the archive: look for the mark at the start of the file.
  const scan = Math.min(data.length - 8, 1 << 20);
  for (let i = 0; i <= scan; i++) {
    if (data[i] !== 0x52 || data[i + 1] !== 0x61 || data[i + 2] !== 0x72 || data[i + 3] !== 0x21 || data[i + 4] !== 0x1a || data[i + 5] !== 0x07) continue;
    if (data[i + 6] === 0x00) return listRar4(data, i + 7, maxEntries);
    if (data[i + 6] === 0x01 && data[i + 7] === 0x00) return listRar5(data, i + 8, maxEntries);
  }
  throw new Error('The file is not a RAR archive');
}
