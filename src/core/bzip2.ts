/**
 * BZip2 decompression, needed for files in 7z and zip archives packed with this method.
 * The order is the reverse of compression: Huffman codes → move-to-front and run lengths → inverse
 * Burrows–Wheeler transform → expansion of runs of equal bytes.
 */
export function bzip2Decode(src: Uint8Array, maxSize = 0x7fffffff): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  const bits = (n: number): number => {
    let value = 0;
    while (n > 0) {
      if (bitCount === 0) {
        if (pos >= src.length) throw new Error('BZip2 data is truncated');
        bitBuf = src[pos++];
        bitCount = 8;
      }
      const take = Math.min(n, bitCount);
      value = value * 2 ** take + ((bitBuf >> (bitCount - take)) & ((1 << take) - 1));
      bitCount -= take;
      n -= take;
    }
    return value;
  };
  if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) throw new Error('Not BZip2 data');
  const level = bits(8) - 0x30;
  if (level < 1 || level > 9) throw new Error('BZip2 data is corrupt');
  const blockMax = level * 100_000;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const tt = new Uint32Array(blockMax);

  for (;;) {
    const magicHigh = bits(24);
    const magicLow = bits(24);
    if (magicHigh === 0x177245 && magicLow === 0x385090) break; // end of stream
    if (magicHigh !== 0x314159 || magicLow !== 0x265359) throw new Error('BZip2 data is corrupt');
    bits(32); // block checksum
    if (bits(1)) throw new Error('Randomised (legacy) BZip2 blocks are not supported');
    const origPtr = bits(24);

    // Which bytes occur in the block.
    const used = bits(16);
    const symbols: number[] = [];
    for (let i = 0; i < 16; i++) {
      if (!(used & (0x8000 >> i))) continue;
      const row = bits(16);
      for (let j = 0; j < 16; j++) if (row & (0x8000 >> j)) symbols.push(i * 16 + j);
    }
    if (!symbols.length) throw new Error('BZip2 data is corrupt');
    const alphaSize = symbols.length + 2;
    const groupCount = bits(3);
    const selectorCount = bits(15);
    if (groupCount < 2 || groupCount > 6 || selectorCount < 1) throw new Error('BZip2 data is corrupt');
    const order = [0, 1, 2, 3, 4, 5].slice(0, groupCount);
    const selectors = new Uint8Array(selectorCount);
    for (let i = 0; i < selectorCount; i++) {
      let j = 0;
      while (bits(1)) if (++j >= groupCount) throw new Error('BZip2 data is corrupt');
      const picked = order[j];
      order.splice(j, 1);
      order.unshift(picked);
      selectors[i] = picked;
    }
    // Code tables: lengths are stored as differences.
    const limits: Int32Array[] = [];
    const bases: Int32Array[] = [];
    const perms: Uint16Array[] = [];
    const minLens: number[] = [];
    for (let g = 0; g < groupCount; g++) {
      const lengths = new Uint8Array(alphaSize);
      let length = bits(5);
      for (let i = 0; i < alphaSize; i++) {
        for (;;) {
          if (length < 1 || length > 20) throw new Error('BZip2 data is corrupt');
          if (!bits(1)) break;
          length += bits(1) ? -1 : 1;
        }
        lengths[i] = length;
      }
      let minLen = 32;
      let maxLen = 0;
      for (const l of lengths) {
        if (l > maxLen) maxLen = l;
        if (l < minLen) minLen = l;
      }
      const perm = new Uint16Array(alphaSize);
      let pp = 0;
      for (let l = minLen; l <= maxLen; l++) for (let i = 0; i < alphaSize; i++) if (lengths[i] === l) perm[pp++] = i;
      const count = new Int32Array(maxLen + 2);
      for (const l of lengths) count[l]++;
      const limit = new Int32Array(maxLen + 2);
      const base = new Int32Array(maxLen + 2);
      let code = 0;
      let index = 0;
      for (let l = minLen; l <= maxLen; l++) {
        base[l] = index - code;
        code += count[l];
        index += count[l];
        limit[l] = code - 1;
        code <<= 1;
      }
      limits.push(limit);
      bases.push(base);
      perms.push(perm);
      minLens.push(minLen);
    }

    // Symbols: zero runs and move-to-front indices.
    const mtf = symbols.slice();
    const byteCount = new Int32Array(256);
    let n = 0;
    let group = 0;
    let left = 0;
    let limit = limits[0];
    let base = bases[0];
    let perm = perms[0];
    let minLen = minLens[0];
    const nextSymbol = (): number => {
      if (left === 0) {
        if (group >= selectorCount) throw new Error('BZip2 data is corrupt');
        const g = selectors[group++];
        limit = limits[g];
        base = bases[g];
        perm = perms[g];
        minLen = minLens[g];
        left = 50;
      }
      left--;
      let length = minLen;
      let code = bits(length);
      while (length < limit.length && code > limit[length]) {
        code = (code << 1) | bits(1);
        length++;
      }
      if (length >= limit.length) throw new Error('BZip2 data is corrupt');
      return perm[code + base[length]];
    };
    const end = alphaSize - 1;
    let symbol = nextSymbol();
    while (symbol !== end) {
      if (symbol <= 1) {
        let run = 0;
        let weight = 1;
        do {
          run += symbol === 0 ? weight : weight * 2;
          weight *= 2;
          if (weight > blockMax * 2) throw new Error('BZip2 data is corrupt');
          symbol = nextSymbol();
        } while (symbol <= 1);
        const byte = mtf[0];
        if (n + run > blockMax) throw new Error('BZip2 data is corrupt');
        byteCount[byte] += run;
        while (run-- > 0) tt[n++] = byte;
        continue;
      }
      const at = symbol - 1;
      const byte = mtf[at];
      mtf.splice(at, 1);
      mtf.unshift(byte);
      if (n >= blockMax) throw new Error('BZip2 data is corrupt');
      byteCount[byte]++;
      tt[n++] = byte;
      symbol = nextSymbol();
    }
    if (origPtr >= n) throw new Error('BZip2 data is corrupt');

    // Inverse Burrows–Wheeler transform.
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = byteCount[i];
      byteCount[i] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) tt[byteCount[tt[i] & 0xff]++] |= i << 8;

    // Run expansion: four equal bytes followed by the number of extra repeats.
    let out = new Uint8Array(Math.min(Math.max(n * 2, 1024), maxSize - total + 1));
    let o = 0;
    const put = (byte: number, times: number) => {
      if (o + times > out.length) {
        const bigger = new Uint8Array(Math.max(out.length * 2, o + times));
        bigger.set(out.subarray(0, o));
        out = bigger;
      }
      for (let k = 0; k < times; k++) out[o++] = byte;
    };
    let tPos = tt[origPtr] >>> 8;
    let previous = -1;
    let repeat = 0;
    for (let i = 0; i < n; i++) {
      const entry = tt[tPos];
      const byte = entry & 0xff;
      tPos = entry >>> 8;
      if (repeat === 4) {
        put(previous, byte);
        repeat = 0;
        previous = -1;
        continue;
      }
      repeat = byte === previous ? repeat + 1 : 1;
      previous = byte;
      put(byte, 1);
    }
    total += o;
    if (total > maxSize) throw new Error('The unpacked data is too large');
    chunks.push(out.subarray(0, o));
  }
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    result.set(c, at);
    at += c.length;
  }
  return result;
}
