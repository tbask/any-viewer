/**
 * LZMA and LZMA2 decompression, for 7z archives (their header is itself compressed) and zip entries.
 * The output buffer serves as the dictionary, so the size of the result must be known in advance.
 */

const PROB_INIT = 1024;
const probs = (n: number) => new Uint16Array(n).fill(PROB_INIT);

export class LzmaDecoder {
  private input: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private range = 0;
  private code = 0;

  private lc = 3;
  private lp = 0;
  private pb = 2;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;

  private literal = probs(0);
  private isMatch = probs(0);
  private isRep = probs(0);
  private isRepG0 = probs(0);
  private isRepG1 = probs(0);
  private isRepG2 = probs(0);
  private isRep0Long = probs(0);
  private posSlot = probs(0);
  private posSpecial = probs(0);
  private align = probs(0);
  private lenProbs = probs(0);
  private repLenProbs = probs(0);

  outPos = 0;

  constructor(readonly out: Uint8Array) {}

  setProps(byte: number): void {
    if (byte >= 225) throw new Error('Invalid LZMA properties');
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
    this.resetState();
  }

  resetState(): void {
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.literal = probs(0x300 << (this.lc + this.lp));
    this.isMatch = probs(12 << 4);
    this.isRep = probs(12);
    this.isRepG0 = probs(12);
    this.isRepG1 = probs(12);
    this.isRepG2 = probs(12);
    this.isRep0Long = probs(12 << 4);
    this.posSlot = probs(4 << 6);
    this.posSpecial = probs(128);
    this.align = probs(16);
    // Length decoder: [0] choice, [1] choice-2, then low (16×8), mid (16×8), high (256).
    this.lenProbs = probs(2 + 256 + 256);
    this.repLenProbs = probs(2 + 256 + 256);
  }

  private bit(p: Uint16Array, i: number): number {
    const bound = (this.range >>> 11) * p[i];
    let result: number;
    if (this.code < bound) {
      this.range = bound;
      p[i] += (2048 - p[i]) >>> 5;
      result = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      p[i] -= p[i] >>> 5;
      result = 1;
    }
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.input[this.pos++]) >>> 0;
    }
    return result;
  }

  private direct(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i++) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      result = result * 2 + b;
      if (this.range < 0x1000000) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.input[this.pos++]) >>> 0;
      }
    }
    return result;
  }

  private tree(p: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(p, offset + m);
    return m - (1 << bits);
  }

  private reverseTree(p: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(p, offset + m);
      m = (m << 1) | b;
      symbol |= b << i;
    }
    return symbol;
  }

  private length(p: Uint16Array, posState: number): number {
    if (!this.bit(p, 0)) return this.tree(p, 2 + (posState << 3), 3);
    if (!this.bit(p, 1)) return 8 + this.tree(p, 2 + 128 + (posState << 3), 3);
    return 16 + this.tree(p, 2 + 256, 8);
  }

  /** Decompresses the stream until outLimit bytes are filled or the end mark is met. Returns the input position. */
  decode(input: Uint8Array, inPos: number, outLimit: number): number {
    this.input = input;
    this.pos = inPos + 1; // the first byte of the stream is always zero
    this.range = 0xffffffff;
    this.code = 0;
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | input[this.pos++]) >>> 0;
    const out = this.out;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    const limit = Math.min(outLimit, out.length);

    while (this.outPos < limit) {
      if (this.pos > input.length + 8) throw new Error('LZMA data is truncated');
      const posState = this.outPos & pbMask;
      if (!this.bit(this.isMatch, (this.state << 4) + posState)) {
        const prev = this.outPos > 0 ? out[this.outPos - 1] : 0;
        const base = 0x300 * (((this.outPos & lpMask) << this.lc) + (prev >>> (8 - this.lc)));
        let symbol = 1;
        if (this.state >= 7) {
          let matchByte = out[this.outPos - this.rep0 - 1];
          do {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const b = this.bit(this.literal, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | b;
            if (matchBit !== b) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) symbol = (symbol << 1) | this.bit(this.literal, base + symbol);
        out[this.outPos++] = symbol & 0xff;
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
        continue;
      }
      let len: number;
      if (this.bit(this.isRep, this.state)) {
        if (this.outPos === 0) throw new Error('Corrupt LZMA data');
        if (!this.bit(this.isRepG0, this.state)) {
          if (!this.bit(this.isRep0Long, (this.state << 4) + posState)) {
            this.state = this.state < 7 ? 9 : 11;
            out[this.outPos] = out[this.outPos - this.rep0 - 1];
            this.outPos++;
            continue;
          }
        } else {
          let dist: number;
          if (!this.bit(this.isRepG1, this.state)) dist = this.rep1;
          else {
            if (!this.bit(this.isRepG2, this.state)) dist = this.rep2;
            else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.length(this.repLenProbs, posState);
        this.state = this.state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = this.length(this.lenProbs, posState);
        this.state = this.state < 7 ? 7 : 10;
        const slot = this.tree(this.posSlot, Math.min(len, 3) << 6, 6);
        if (slot < 4) this.rep0 = slot;
        else {
          const directBits = (slot >> 1) - 1;
          let dist = (2 | (slot & 1)) * 2 ** directBits;
          if (slot < 14) dist += this.reverseTree(this.posSpecial, dist - slot, directBits);
          else {
            dist += this.direct(directBits - 4) * 16;
            dist += this.reverseTree(this.align, 0, 4);
          }
          this.rep0 = dist;
        }
        if (this.rep0 === 0xffffffff) break; // end-of-stream mark
      }
      len += 2;
      if (this.rep0 >= this.outPos) throw new Error('Corrupt LZMA data');
      const end = Math.min(this.outPos + len, limit);
      for (let src = this.outPos - this.rep0 - 1; this.outPos < end; ) out[this.outPos++] = out[src++];
    }
    return this.pos;
  }
}

/** LZMA: props are the 5 property bytes from the coder description. */
export function lzmaDecode(input: Uint8Array, props: Uint8Array, outSize: number): Uint8Array {
  const decoder = new LzmaDecoder(new Uint8Array(outSize));
  decoder.setProps(props[0]);
  decoder.decode(input, 0, outSize);
  if (decoder.outPos !== outSize) throw new Error('LZMA data is truncated');
  return decoder.out;
}

/** LZMA2: a sequence of chunks, each with its own header. */
export function lzma2Decode(input: Uint8Array, outSize: number): Uint8Array {
  const decoder = new LzmaDecoder(new Uint8Array(outSize));
  let p = 0;
  let hasProps = false;
  while (p < input.length) {
    const control = input[p++];
    if (control === 0) break;
    if (control < 0x80) {
      if (control > 2) throw new Error('Corrupt LZMA2 data');
      const size = ((input[p] << 8) | input[p + 1]) + 1;
      p += 2;
      if (decoder.outPos + size > outSize || p + size > input.length) throw new Error('Corrupt LZMA2 data');
      decoder.out.set(input.subarray(p, p + size), decoder.outPos);
      decoder.outPos += size;
      p += size;
      continue;
    }
    const unpacked = (((control & 0x1f) << 16) | (input[p] << 8) | input[p + 1]) + 1;
    const packed = ((input[p + 2] << 8) | input[p + 3]) + 1;
    p += 4;
    const reset = (control >> 5) & 3;
    if (reset >= 2) {
      decoder.setProps(input[p++]);
      hasProps = true;
    } else if (reset === 1) decoder.resetState();
    if (!hasProps) throw new Error('Corrupt LZMA2 data');
    decoder.decode(input, p, decoder.outPos + unpacked);
    p += packed;
  }
  if (decoder.outPos !== outSize) throw new Error('LZMA2 data is truncated');
  return decoder.out;
}
