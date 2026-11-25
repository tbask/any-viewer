/**
 * RAR archives (versions 1.5–4 and 5): the file list — names and sizes — and extraction.
 * Files are unpacked from version 5 archives (unrar5) and versions 2.9–4 (unrar3); from older ones only stored files.
 */
import { crc32 } from './zip';
import type { ArchiveEntry } from './tar';

/** Limit on the unpacked data of one solid group. */
const MAX_UNPACK = 400 * 1024 * 1024;

export class ArchivePasswordError extends Error {
  constructor() {
    super('The archive header is encrypted');
    this.name = 'PasswordError';
  }
}

const utf8 = new TextDecoder('utf-8');
const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const u32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** A RAR 3–4 file name in "packed" Unicode: name bytes in the DOS encoding, a zero, then corrections up to UTF-16. */
function decodeRar4Name(raw: Uint8Array): string {
  const zero = raw.indexOf(0);
  if (zero < 0) return utf8.decode(raw);
  const plain = raw.subarray(0, zero);
  const enc = raw.subarray(zero + 1);
  if (!enc.length) return utf8.decode(plain);
  const out: number[] = [];
  let p = 0;
  const high = enc[p++] << 8;
  let flags = 0;
  let flagBits = 0;
  while (p < enc.length) {
    if (flagBits === 0) {
      flags = enc[p++];
      flagBits = 8;
    }
    const mode = flags >> 6;
    flags = (flags << 2) & 0xff;
    flagBits -= 2;
    if (mode === 0) out.push(enc[p++]);
    else if (mode === 1) out.push(enc[p++] | high);
    else if (mode === 2) {
      out.push(enc[p] | (enc[p + 1] << 8));
      p += 2;
    } else {
      let length = enc[p++];
      if (length & 0x80) {
        const correction = enc[p++];
        for (length = (length & 0x7f) + 2; length > 0 && out.length < plain.length; length--) out.push(((plain[out.length] + correction) & 0xff) | high);
      } else {
        for (length += 2; length > 0 && out.length < plain.length; length--) out.push(plain[out.length]);
      }
    }
  }
  return String.fromCharCode(...out.filter((c) => c !== undefined && !Number.isNaN(c)));
}

function listRar4(data: Uint8Array, start: number, max: number): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let p = start;
  // Packed files in order: in a solid archive a file is unpacked only after the preceding ones.
  const packedFiles: { at: number; packed: number; size: number; stored: boolean; solid: boolean; crc: number; usable: boolean }[] = [];
  let progress: { first: number; next: number; state: import('./unrar3').Rar3State; starts: number[] } | undefined;
  const unpack = async (index: number): Promise<Uint8Array> => {
    const { Rar3State, rar3File, unrar3 } = await import('./unrar3');
    let first = index;
    while (first > 0 && packedFiles[first].solid) first--;
    if (!progress || progress.first !== first) progress = { first, next: first, state: new Rar3State(), starts: [] };
    for (; progress.next <= index; progress.next++) {
      const file = packedFiles[progress.next];
      if (!file.usable) throw new Error('The file in the RAR archive cannot be unpacked: it is encrypted, split across volumes or packed by an old RAR version');
      const st = progress.state;
      if (file.stored) {
        if (st.size + file.size > st.out.length) {
          const bigger = new Uint8Array(Math.max(st.size + file.size, st.out.length * 2));
          bigger.set(st.out.subarray(0, st.size));
          st.out = bigger;
        }
        st.out.set(data.subarray(file.at, file.at + file.size), st.size);
        progress.starts[progress.next] = st.size;
        st.size += file.size;
      } else progress.starts[progress.next] = unrar3(data.subarray(file.at, file.at + file.packed), file.size, st, progress.next > first, MAX_UNPACK);
    }
    const file = packedFiles[index];
    const bytes = rar3File(progress.state, progress.starts[index], file.size);
    if (crc32(bytes) !== file.crc) throw new Error('Checksum mismatch for the file in the RAR archive');
    return bytes;
  };
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
        const name = (flags & 0x0200 ? decodeRar4Name(raw) : utf8.decode(raw)).replace(/\\/g, '/');
        const directory = (flags & 0xe0) === 0xe0;
        const entry: ArchiveEntry = { name, size: directory ? 0 : size, directory };
        // A file without compression ("stored"), without encryption and not continued in another volume can be taken as is.
        const at = p + headSize;
        const method = data[p + 25];
        const version = data[p + 24];
        const whole = !(flags & 0x07) && at + dataSize <= data.length;
        const index = packedFiles.length;
        // Algorithm versions 2.9–3.6 are unpacked; older ones (RAR 1.5 and 2.x) are not.
        if (!directory) packedFiles.push({ at, packed: dataSize, size, stored: method === 0x30, solid: (flags & 0x10) !== 0, crc: u32(data, p + 16), usable: whole && (method === 0x30 ? dataSize === size : version === 29 || version === 36) });
        if (!directory && method === 0x30 && whole && dataSize === size) entry.read = () => data.subarray(at, at + size);
        else if (!directory && packedFiles[index]?.usable) entry.read = () => unpack(index);
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
  // Packed files in order: in a solid archive a file is unpacked only after the preceding ones.
  const packedFiles: { at: number; packed: number; size: number; method: number; solid: boolean; version: number; crc?: number; usable: boolean }[] = [];
  let progress: { first: number; next: number; state: import('./unrar5').Rar5State; starts: number[] } | undefined;
  const unpack = async (index: number): Promise<Uint8Array> => {
    const { Rar5State, rar5File, unrar5 } = await import('./unrar5');
    let first = index;
    while (first > 0 && packedFiles[first].solid) first--;
    if (!progress || progress.first !== first) progress = { first, next: first, state: new Rar5State(), starts: [] };
    for (; progress.next <= index; progress.next++) {
      const file = packedFiles[progress.next];
      if (!file.usable) throw new Error('The file in the RAR archive cannot be unpacked: it is encrypted or split across volumes');
      let start: number;
      if (file.method === 0) {
        // A stored file inside a solid group: its data still belongs to the shared history.
        const stateRef = progress.state;
        if (stateRef.size + file.size > stateRef.out.length) {
          const bigger = new Uint8Array(Math.max(stateRef.size + file.size, stateRef.out.length * 2));
          bigger.set(stateRef.out.subarray(0, stateRef.size));
          stateRef.out = bigger;
        }
        stateRef.out.set(data.subarray(file.at, file.at + file.size), stateRef.size);
        start = stateRef.size;
        stateRef.size += file.size;
      } else start = unrar5(data.subarray(file.at, file.at + file.packed), file.size, progress.state, file.version, MAX_UNPACK);
      progress.starts[progress.next] = start;
    }
    const file = packedFiles[index];
    const bytes = rar5File(progress.state, progress.starts[index], file.size);
    if (file.crc !== undefined && crc32(bytes) !== file.crc) throw new Error('Checksum mismatch for the file in the RAR archive');
    return bytes;
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
      let crc: number | undefined;
      if (fileFlags & 4) {
        crc = u32(data, p);
        p += 4;
      }
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
        const index = packedFiles.length;
        if (!directory) packedFiles.push({ at, packed: dataSize, size, method, solid: (compression & 0x40) !== 0, version: compression & 0x3f, crc, usable: whole && (method === 0 ? dataSize === size : (compression & 0x3f) <= 1) });
        if (!directory && method === 0 && whole && dataSize === size) entry.read = () => data.subarray(at, at + size);
        else if (!directory && packedFiles[index]?.usable) entry.read = () => unpack(index);
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
