/**
 * Decompression of RAR 2.9–4 archive data (the WinRAR 3 and 4 format).
 * Dictionary compression with Huffman codes; on top of it the standard filters (x86 code, delta, RGB pictures).
 * Not supported: blocks compressed with PPMd (the "text compression" mode), audio and Itanium filters.
 * The result is verified against the checksum from the file header.
 */
import { Bits, makeTable, type Huffman } from './unrar5';

const NC = 299;
const DC = 60;
const LDC = 17;
const RC = 28;
const BC = 20;
const TABLE = NC + DC + LDC + RC;

const L_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224];
const L_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5];
const SD_BASE = [0, 4, 8, 16, 32, 64, 128, 192];
const SD_BITS = [2, 2, 3, 4, 5, 6, 6, 6];
const D_BASE: number[] = [];
const D_BITS: number[] = [];
{
  const counts = [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 14, 0, 12];
  let dist = 0;
  counts.forEach((count, bitLength) => {
    for (let j = 0; j < count; j++, dist += 2 ** bitLength) {
      D_BASE.push(dist);
      D_BITS.push(bitLength);
    }
  });
}

interface Filter3 {
  start: number;
  length: number;
  /** Kind of a standard filter and its initial registers. */
  kind: string;
  regs: number[];
}

/** Decompression state shared by the files of one solid group. */
export class Rar3State {
  out = new Uint8Array(1 << 16);
  size = 0;
  oldDist = [0, 0, 0, 0];
  lastLength = 0;
  tables: { ld: Huffman; dd: Huffman; ldd: Huffman; rd: Huffman } | null = null;
  tablesRead = false;
  oldTable = new Uint8Array(TABLE);
  prevLowDist = 0;
  lowDistRepeat = 0;
  /** Filter programs met earlier (they are referred to by number) and the lengths of their last blocks. */
  programs: string[] = [];
  oldLengths: number[] = [];
  lastFilter = 0;
  filters: Filter3[] = [];
}

/** Standard filters are recognised by the length of their program. */
const PROGRAMS: Record<number, string> = { 53: 'e8', 57: 'e8e9', 120: 'itanium', 29: 'delta', 149: 'rgb', 216: 'audio' };

/** A number in a filter program record: 4 to 32 bits. */
function vmNumber(bits: Bits): number {
  const kind = bits.read(2);
  if (kind === 0) return bits.read(4);
  if (kind === 1) {
    const high = bits.read(4);
    if (high === 0) return (0xffffff00 | bits.read(8)) >>> 0;
    return (high << 4) | bits.read(4);
  }
  if (kind === 2) return bits.read(16);
  return bits.read(16) * 65536 + bits.read(16);
}

/** Unpacks one file and appends it to state.out. Returns the offset of the file start in state.out. */
export function unrar3(packed: Uint8Array, unpackedSize: number, state: Rar3State, solid: boolean, maxSize: number): number {
  if (!solid) {
    const fresh = new Rar3State();
    Object.assign(state, fresh);
  }
  const start = state.size;
  const end = start + unpackedSize;
  if (end > maxSize) throw new Error('The unpacked data is too large');
  if (end > state.out.length) {
    const bigger = new Uint8Array(Math.max(end, Math.min(maxSize, state.out.length * 2)));
    bigger.set(state.out.subarray(0, state.size));
    state.out = bigger;
  }
  const out = state.out;
  const bits = new Bits(packed);
  let pos = start;

  const readTables = (): void => {
    bits.align();
    if (bits.read(1)) throw new Error('The file is compressed with PPMd ("text compression"), which is not supported');
    if (!bits.read(1)) state.oldTable.fill(0);
    state.prevLowDist = 0;
    state.lowDistRepeat = 0;
    const lengths = new Uint8Array(BC);
    for (let i = 0; i < BC; i++) {
      const length = bits.read(4);
      if (length === 15) {
        let zeros = bits.read(4);
        if (zeros === 0) lengths[i] = 15;
        else {
          zeros += 2;
          while (zeros-- > 0 && i < BC) lengths[i++] = 0;
          i--;
        }
      } else lengths[i] = length;
    }
    const bd = makeTable(lengths, 0, BC);
    const table = new Uint8Array(TABLE);
    for (let i = 0; i < TABLE; ) {
      if (bits.ended) throw new Error('RAR data is truncated');
      const n = bits.decode(bd);
      if (n < 16) {
        // Code lengths are stored as differences from the previous table.
        table[i] = (n + state.oldTable[i]) & 15;
        i++;
      } else if (n < 18) {
        let repeat = n === 16 ? bits.read(3) + 3 : bits.read(7) + 11;
        if (i === 0) throw new Error('RAR data is corrupt');
        while (repeat-- > 0 && i < TABLE) {
          table[i] = table[i - 1];
          i++;
        }
      } else {
        let repeat = n === 18 ? bits.read(3) + 3 : bits.read(7) + 11;
        while (repeat-- > 0 && i < TABLE) table[i++] = 0;
      }
    }
    state.tables = { ld: makeTable(table, 0, NC), dd: makeTable(table, NC, DC), ldd: makeTable(table, NC + DC, LDC), rd: makeTable(table, NC + DC + LDC, RC) };
    state.oldTable.set(table);
    state.tablesRead = true;
  };
  const copy = (length: number, distance: number): void => {
    let from = pos - distance;
    if (from < 0 || distance <= 0) throw new Error('RAR data is corrupt');
    const stop = Math.min(end, pos + length);
    while (pos < stop) out[pos++] = out[from++];
  };
  const pushDist = (distance: number): void => {
    state.oldDist.unshift(distance);
    state.oldDist.length = 4;
  };
  /** End of block: true means the data of this file has ended. */
  const endOfBlock = (): boolean => {
    if (bits.read(1)) {
      readTables();
      return false;
    }
    const newTable = bits.read(1) === 1;
    state.tablesRead = !newTable;
    return true;
  };
  const readFilter = (): void => {
    const first = bits.read(8);
    let length = (first & 7) + 1;
    if (length === 7) length = bits.read(8) + 7;
    else if (length === 8) length = bits.read(16);
    const code = new Uint8Array(length);
    for (let i = 0; i < length; i++) code[i] = bits.read(8);
    const vm = new Bits(code);
    let index: number;
    if (first & 0x80) {
      index = vmNumber(vm);
      if (index === 0) {
        state.programs = [];
        state.oldLengths = [];
      } else index--;
    } else index = state.lastFilter;
    if (index > state.programs.length || index > state.oldLengths.length) throw new Error('RAR data is corrupt');
    state.lastFilter = index;
    const isNew = index === state.programs.length;
    if (isNew) {
      state.programs.push('');
      state.oldLengths.push(0);
    }
    let blockStart = vmNumber(vm);
    if (first & 0x40) blockStart += 258;
    let blockLength: number;
    if (first & 0x20) {
      blockLength = vmNumber(vm);
      state.oldLengths[index] = blockLength;
    } else blockLength = state.oldLengths[index] ?? 0;
    const regs = [0, 0, 0, 0, blockLength, 0, 0];
    if (first & 0x10) {
      const mask = vm.read(7);
      for (let i = 0; i < 7; i++) if (mask & (1 << i)) regs[i] = vmNumber(vm);
    }
    if (isNew) {
      const size = vmNumber(vm);
      if (size === 0 || size >= 0x10000) throw new Error('RAR data is corrupt');
      state.programs[index] = PROGRAMS[size] ?? 'unknown';
    }
    if (state.filters.length < 100_000) state.filters.push({ start: pos + blockStart, length: blockLength, kind: state.programs[index], regs });
  };

  if (!solid || !state.tablesRead) readTables();
  let finished = false;
  while (pos < end && !finished) {
    if (bits.ended) throw new Error('RAR data is truncated');
    const t = state.tables!;
    let n = bits.decode(t.ld);
    if (n < 256) {
      out[pos++] = n;
    } else if (n >= 271) {
      n -= 271;
      let length = L_BASE[n] + 3 + bits.read(L_BITS[n]);
      const slot = bits.decode(t.dd);
      let distance = D_BASE[slot] + 1;
      const extra = D_BITS[slot];
      if (extra > 0) {
        if (slot > 9) {
          if (extra > 4) distance += bits.read(extra - 4) * 16;
          if (state.lowDistRepeat > 0) {
            state.lowDistRepeat--;
            distance += state.prevLowDist;
          } else {
            const low = bits.decode(t.ldd);
            if (low === 16) {
              state.lowDistRepeat = 15;
              distance += state.prevLowDist;
            } else {
              distance += low;
              state.prevLowDist = low;
            }
          }
        } else distance += bits.read(extra);
      }
      if (distance >= 0x2000) {
        length++;
        if (distance >= 0x40000) length++;
      }
      pushDist(distance);
      state.lastLength = length;
      copy(length, distance);
    } else if (n === 256) {
      finished = endOfBlock();
    } else if (n === 257) {
      readFilter();
    } else if (n === 258) {
      if (state.lastLength) copy(state.lastLength, state.oldDist[0]);
    } else if (n < 263) {
      const index = n - 259;
      const distance = state.oldDist[index];
      state.oldDist.splice(index, 1);
      state.oldDist.unshift(distance);
      const slot = bits.decode(t.rd);
      const length = L_BASE[slot] + 2 + bits.read(L_BITS[slot]);
      state.lastLength = length;
      copy(length, distance);
    } else {
      n -= 263;
      const distance = SD_BASE[n] + 1 + bits.read(SD_BITS[n]);
      pushDist(distance);
      state.lastLength = 2;
      copy(2, distance);
    }
  }
  if (pos < end) throw new Error('RAR data is truncated');
  // An end mark usually follows the last byte of a file: it decides whether the tables stay valid for the next file.
  if (!finished && !bits.ended) {
    try {
      if (bits.decode(state.tables!.ld) === 256) endOfBlock();
    } catch {
      state.tablesRead = false;
    }
  }
  state.size = end;
  return start;
}

/** A file from the unpacked data: a copy of the region with filters applied. */
export function rar3File(state: Rar3State, start: number, size: number): Uint8Array {
  let data = state.out.slice(start, start + size);
  for (const f of state.filters) {
    if (f.start < start || f.start + f.length > start + size || f.length <= 0) continue;
    const at = f.start - start;
    const block = data.subarray(at, at + f.length);
    const length = f.length;
    if (f.kind === 'e8' || f.kind === 'e8e9') {
      const fileSize = 0x1000000;
      const second = f.kind === 'e8e9' ? 0xe9 : 0xe8;
      for (let p = 0; p < length - 4; ) {
        const byte = block[p++];
        if (byte !== 0xe8 && byte !== second) continue;
        const offset = (p + at) % fileSize;
        const addr = (block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24)) >>> 0;
        let value: number | undefined;
        if (addr & 0x80000000) {
          if (((addr + offset) & 0x80000000) === 0) value = (addr + fileSize) >>> 0;
        } else if ((addr - fileSize) & 0x80000000) value = (addr - offset) >>> 0;
        if (value !== undefined) {
          block[p] = value & 0xff;
          block[p + 1] = (value >>> 8) & 0xff;
          block[p + 2] = (value >>> 16) & 0xff;
          block[p + 3] = (value >>> 24) & 0xff;
        }
        p += 4;
      }
    } else if (f.kind === 'delta') {
      const channels = f.regs[0];
      if (channels < 1 || channels > 1024) throw new Error('RAR data is corrupt');
      const source = block.slice();
      let s = 0;
      for (let channel = 0; channel < channels; channel++) {
        let previous = 0;
        for (let p = channel; p < length; p += channels) {
          previous = (previous - source[s++]) & 0xff;
          block[p] = previous;
        }
      }
    } else if (f.kind === 'rgb') {
      // Uncompressed picture: every channel is predicted from the left, upper and upper-left neighbours.
      const width = f.regs[0] - 3;
      const posR = f.regs[1];
      if (width < 0 || width > length || posR < 0) throw new Error('RAR data is corrupt');
      const source = block.slice();
      let s = 0;
      for (let channel = 0; channel < 3; channel++) {
        let previous = 0;
        for (let i = channel; i < length; i += 3) {
          let predicted = previous;
          if (i >= width + 3) {
            const upper = block[i - width];
            const upperLeft = block[i - width - 3];
            predicted = previous + upper - upperLeft;
            const pa = Math.abs(predicted - previous);
            const pb = Math.abs(predicted - upper);
            const pc = Math.abs(predicted - upperLeft);
            predicted = pa <= pb && pa <= pc ? previous : pb <= pc ? upper : upperLeft;
          }
          previous = (predicted - source[s++]) & 0xff;
          block[i] = previous;
        }
      }
      for (let i = posR; i < length - 2; i += 3) {
        const g = block[i + 1];
        block[i] = (block[i] + g) & 0xff;
        block[i + 2] = (block[i + 2] + g) & 0xff;
      }
    } else throw new Error('This RAR filter is not supported');
    data = data.slice();
  }
  return data;
}
