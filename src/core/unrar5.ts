/**
 * Decompression of RAR 5 archive data (the WinRAR 5 and newer format).
 * Dictionary compression (references to already unpacked data) with Huffman codes; on top of it there may be
 * filters for executable code and a delta filter. In a solid archive files are packed as one stream:
 * to get a file, all preceding files of its group have to be unpacked.
 * The result is verified against the checksum from the file header.
 */

const NC = 306; // literals and lengths
const LDC = 16; // low bits of the distance
const RC = 44; // lengths for repeated distances
const BC = 20; // codes of code lengths

export interface Huffman {
  /** How many codes of each length, the first code of that length and the place of its symbol in the sorted list. */
  count: Uint16Array;
  first: Int32Array;
  offset: Int32Array;
  symbols: Uint16Array;
}

export function makeTable(lengths: Uint8Array | number[], from: number, size: number): Huffman {
  const count = new Uint16Array(16);
  for (let i = 0; i < size; i++) count[lengths[from + i] & 15]++;
  count[0] = 0;
  const first = new Int32Array(16);
  const offset = new Int32Array(16);
  let code = 0;
  let total = 0;
  for (let len = 1; len < 16; len++) {
    first[len] = code;
    offset[len] = total;
    code = (code + count[len]) << 1;
    total += count[len];
  }
  const symbols = new Uint16Array(total);
  const next = offset.slice();
  for (let i = 0; i < size; i++) {
    const len = lengths[from + i] & 15;
    if (len) symbols[next[len]++] = i;
  }
  return { count, first, offset, symbols };
}

interface Filter {
  /** Start and length of a region in the unpacked data of the group, filter kind and channel count (for delta). */
  start: number;
  length: number;
  type: number;
  channels: number;
}

/** Decompression state shared by the files of one solid group. */
export class Rar5State {
  out = new Uint8Array(1 << 16);
  size = 0;
  oldDist = [0, 0, 0, 0];
  lastLength = 0;
  tables: { ld: Huffman; dd: Huffman; ldd: Huffman; rd: Huffman } | null = null;
  filters: Filter[] = [];
}

export class Bits {
  /** Position in bits from the start of the data. */
  pos = 0;
  constructor(private readonly data: Uint8Array) {}
  get byte(): number {
    return this.pos >> 3;
  }
  get bit(): number {
    return this.pos & 7;
  }
  get ended(): boolean {
    return this.pos >> 3 >= this.data.length;
  }
  /** The next n bits (up to 24) without moving the position. */
  peek(n: number): number {
    const at = this.pos >> 3;
    const d = this.data;
    const word = ((d[at] ?? 0) * 0x1000000 + (((d[at + 1] ?? 0) << 16) | ((d[at + 2] ?? 0) << 8) | (d[at + 3] ?? 0))) >>> 0;
    return (word << (this.pos & 7)) >>> (32 - n);
  }
  read(n: number): number {
    if (n === 0) return 0;
    if (n > 24) {
      const high = this.read(n - 16);
      return high * 65536 + this.read(16);
    }
    const value = this.peek(n);
    this.pos += n;
    return value;
  }
  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
  decode(table: Huffman): number {
    let code = 0;
    for (let len = 1; len < 16; len++) {
      code = (code << 1) | this.read(1);
      const index = code - table.first[len];
      if (index < table.count[len]) return table.symbols[table.offset[len] + index];
    }
    throw new Error('RAR data is corrupt');
  }
}

/**
 * Unpacks one file and appends it to state.out. Returns the offset of the file start in state.out.
 * version is the algorithm version from the file header (0: RAR 5, 1: RAR 7 with a larger distance table).
 */
export function unrar5(packed: Uint8Array, unpackedSize: number, state: Rar5State, version: number, maxSize: number): number {
  const DC = version === 1 ? 80 : 64;
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
  let blockEndByte = 0;
  let blockEndBit = 0;
  let lastBlock = false;

  const readBlock = (): void => {
    bits.align();
    const flags = bits.read(8);
    const saved = bits.read(8);
    const byteCount = ((flags >> 3) & 3) + 1;
    if (byteCount === 4) throw new Error('RAR data is corrupt');
    let blockSize = 0;
    for (let i = 0; i < byteCount; i++) blockSize += bits.read(8) << (i * 8);
    if (((0x5a ^ flags ^ blockSize ^ (blockSize >> 8) ^ (blockSize >> 16)) & 0xff) !== saved) throw new Error('RAR data is corrupt');
    // A block takes blockSize bytes; the last of them has (flags & 7) + 1 significant bits.
    blockEndByte = bits.byte + blockSize - 1;
    blockEndBit = (flags & 7) + 1;
    lastBlock = (flags & 0x40) !== 0;
    if (flags & 0x80) {
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
      const total = NC + DC + LDC + RC;
      const table = new Uint8Array(total);
      for (let i = 0; i < total; ) {
        const n = bits.decode(bd);
        if (n < 16) table[i++] = n;
        else if (n < 18) {
          let repeat = n === 16 ? bits.read(3) + 3 : bits.read(7) + 11;
          if (i === 0) throw new Error('RAR data is corrupt');
          while (repeat-- > 0 && i < total) {
            table[i] = table[i - 1];
            i++;
          }
        } else {
          let repeat = n === 18 ? bits.read(3) + 3 : bits.read(7) + 11;
          while (repeat-- > 0 && i < total) table[i++] = 0;
        }
      }
      state.tables = { ld: makeTable(table, 0, NC), dd: makeTable(table, NC, DC), ldd: makeTable(table, NC + DC, LDC), rd: makeTable(table, NC + DC + LDC, RC) };
    }
    if (!state.tables) throw new Error('RAR data is corrupt');
  };
  const blockDone = () => bits.byte > blockEndByte || (bits.byte === blockEndByte && bits.bit >= blockEndBit);
  const slotToLength = (slot: number): number => {
    if (slot < 8) return 2 + slot;
    const extra = (slot >> 2) - 1;
    return 2 + ((4 | (slot & 3)) << extra) + bits.read(extra);
  };
  const copy = (length: number, distance: number): void => {
    let from = pos - distance;
    if (from < 0 || distance <= 0) throw new Error('RAR data is corrupt');
    const stop = Math.min(end, pos + length);
    while (pos < stop) out[pos++] = out[from++];
  };
  const filterNumber = (): number => {
    const count = bits.read(2) + 1;
    let value = 0;
    for (let i = 0; i < count; i++) value += bits.read(8) * 2 ** (i * 8);
    return value;
  };

  readBlock();
  while (pos < end) {
    while (blockDone()) {
      if (lastBlock || bits.ended) {
        if (pos < end) throw new Error('RAR data is truncated');
        break;
      }
      readBlock();
    }
    const t = state.tables!;
    const slot = bits.decode(t.ld);
    if (slot < 256) {
      out[pos++] = slot;
      continue;
    }
    if (slot >= 262) {
      let length = slotToLength(slot - 262);
      const distSlot = bits.decode(t.dd);
      let distance = 1;
      let distBits = 0;
      if (distSlot < 4) distance += distSlot;
      else {
        distBits = (distSlot >> 1) - 1;
        distance += (2 | (distSlot & 1)) * 2 ** distBits;
      }
      if (distBits > 0) {
        if (distBits >= 4) {
          if (distBits > 4) distance += bits.read(distBits - 4) * 16;
          distance += bits.decode(t.ldd);
        } else distance += bits.read(distBits);
      }
      if (distance > 0x100) {
        length++;
        if (distance > 0x2000) {
          length++;
          if (distance > 0x40000) length++;
        }
      }
      state.oldDist.unshift(distance);
      state.oldDist.length = 4;
      state.lastLength = length;
      copy(length, distance);
    } else if (slot === 256) {
      const filterStart = filterNumber();
      let filterLength = filterNumber();
      if (filterLength > 0x400000) filterLength = 0;
      const type = bits.read(3);
      const channels = type === 0 ? bits.read(5) + 1 : 0;
      if (state.filters.length < 100_000) state.filters.push({ start: pos + filterStart, length: filterLength, type, channels });
    } else if (slot === 257) {
      if (state.lastLength) copy(state.lastLength, state.oldDist[0]);
    } else {
      const index = slot - 258;
      const distance = state.oldDist[index];
      state.oldDist.splice(index, 1);
      state.oldDist.unshift(distance);
      const length = slotToLength(bits.decode(t.rd));
      state.lastLength = length;
      copy(length, distance);
    }
  }
  state.size = end;
  return start;
}

/**
 * A file from the unpacked data of the group: a copy of the region with filters applied.
 * Filters keep data in a transformed form (it compresses better that way); here the transform is undone.
 */
export function rar5File(state: Rar5State, start: number, size: number): Uint8Array {
  const data = state.out.slice(start, start + size);
  for (const f of state.filters) {
    if (f.start < start || f.start + f.length > start + size || f.length <= 0) continue;
    const at = f.start - start;
    const block = data.subarray(at, at + f.length);
    const fileOffset = at >>> 0;
    if (f.type === 1 || f.type === 2) {
      // x86 jump addresses (E8 and, for the second kind, E9 instructions) are restored to relative.
      const fileSize = 0x1000000;
      const second = f.type === 2 ? 0xe9 : 0xe8;
      for (let p = 0; p < block.length - 4; ) {
        const byte = block[p++];
        if (byte !== 0xe8 && byte !== second) continue;
        const offset = (p + fileOffset) % fileSize;
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
    } else if (f.type === 3) {
      // ARM branch addresses.
      for (let p = 0; p + 3 < block.length; p += 4) {
        if (block[p + 3] !== 0xeb) continue;
        const offset = ((block[p] | (block[p + 1] << 8) | (block[p + 2] << 16)) - ((fileOffset + p) >>> 2)) & 0xffffff;
        block[p] = offset & 0xff;
        block[p + 1] = (offset >> 8) & 0xff;
        block[p + 2] = (offset >> 16) & 0xff;
      }
    } else if (f.type === 0 && f.channels > 0) {
      // Delta: every channel stores differences of neighbouring values.
      const source = block.slice();
      let s = 0;
      for (let channel = 0; channel < f.channels; channel++) {
        let previous = 0;
        for (let p = channel; p < block.length; p += f.channels) {
          previous = (previous - source[s++]) & 0xff;
          block[p] = previous;
        }
      }
    }
  }
  return data;
}
