/**
 * An own implementation of DEFLATE decompression (RFC 1951).
 *
 * The main path in the library is the browser's built-in DecompressionStream('deflate-raw').
 * This module is the fallback for environments without it (old WebViews),
 * so the priority here is correctness and small size, not speed.
 */

export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InflateError';
  }
}

const MAX_BITS = 15;

interface Huffman {
  count: Uint16Array; // number of codes of each length
  symbol: Uint16Array; // symbols in canonical order
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths: Uint8Array | number[], n: number): Huffman {
  const count = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  // Check for an over-subscribed code set.
  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw new InflateError('Invalid Huffman table');
  }
  const offs = new Uint16Array(MAX_BITS + 1);
  for (let len = 1; len < MAX_BITS; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;
  }
  return { count, symbol };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedLit = buildHuffman(l, 288);
    const d = new Uint8Array(30).fill(5);
    fixedDist = buildHuffman(d, 30);
  }
  return [fixedLit, fixedDist];
}

/**
 * Decompresses a raw DEFLATE stream (without zlib/gzip headers).
 * @param src compressed data
 * @param expectedSize expected size of the result, if known (speeds up allocation)
 * @param maxSize limit on the size of the result, a guard against zip bombs
 */
export function inflateRaw(src: Uint8Array, expectedSize?: number, maxSize = 0x7fffffff): Uint8Array {
  let out = new Uint8Array(Math.min(expectedSize && expectedSize > 0 ? expectedSize : Math.max(src.length * 4, 1024), maxSize));
  let outPos = 0;
  let inPos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const ensure = (need: number) => {
    if (outPos + need <= out.length) return;
    if (outPos + need > maxSize) throw new InflateError('The unpacked data exceeds the size limit');
    let size = out.length * 2;
    while (size < outPos + need) size *= 2;
    const next = new Uint8Array(Math.min(size, maxSize));
    next.set(out.subarray(0, outPos));
    out = next;
  };

  const bits = (need: number): number => {
    let val = bitBuf;
    while (bitCnt < need) {
      if (inPos >= src.length) throw new InflateError('Unexpected end of compressed data');
      val |= src[inPos++] << bitCnt;
      bitCnt += 8;
    }
    bitBuf = val >>> need;
    bitCnt -= need;
    return val & ((1 << need) - 1);
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError('Invalid Huffman code');
  };

  const codes = (lit: Huffman, dist: Huffman) => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outPos++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new InflateError('Invalid length code');
        const len = LENGTH_BASE[sym] + bits(LENGTH_EXTRA[sym]);
        const dsym = decode(dist);
        if (dsym >= 30) throw new InflateError('Invalid distance code');
        const d = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
        if (d > outPos) throw new InflateError('Distance beyond the output');
        ensure(len);
        // Byte-by-byte copy: the regions may overlap.
        for (let i = 0; i < len; i++, outPos++) out[outPos] = out[outPos - d];
      }
    }
  };

  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored block.
      bitBuf = 0;
      bitCnt = 0;
      if (inPos + 4 > src.length) throw new InflateError('Unexpected end of compressed data');
      const len = src[inPos] | (src[inPos + 1] << 8);
      const nlen = src[inPos + 2] | (src[inPos + 3] << 8);
      inPos += 4;
      if ((len ^ 0xffff) !== nlen) throw new InflateError('Corrupt stored block');
      if (inPos + len > src.length) throw new InflateError('Unexpected end of compressed data');
      ensure(len);
      out.set(src.subarray(inPos, inPos + len), outPos);
      outPos += len;
      inPos += len;
    } else if (type === 1) {
      const [l, d] = fixedTables();
      codes(l, d);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw new InflateError('Invalid dynamic block header');
      const lengths = new Uint8Array(316);
      for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]] = bits(3);
      const lenCode = buildHuffman(lengths.subarray(0, 19), 19);
      lengths.fill(0);
      let idx = 0;
      while (idx < nlen + ndist) {
        const sym = decode(lenCode);
        if (sym < 16) {
          lengths[idx++] = sym;
        } else {
          let prev = 0;
          let rep: number;
          if (sym === 16) {
            if (idx === 0) throw new InflateError('Length repeat without a previous value');
            prev = lengths[idx - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) {
            rep = 3 + bits(3);
          } else {
            rep = 11 + bits(7);
          }
          if (idx + rep > nlen + ndist) throw new InflateError('Too many code lengths');
          while (rep--) lengths[idx++] = prev;
        }
      }
      if (lengths[256] === 0) throw new InflateError('Missing end-of-block code');
      const lit = buildHuffman(lengths.subarray(0, nlen), nlen);
      const dist = buildHuffman(lengths.subarray(nlen, nlen + ndist), ndist);
      codes(lit, dist);
    } else {
      throw new InflateError('Invalid block type');
    }
  } while (!last);

  return outPos === out.length ? out : out.slice(0, outPos);
}
