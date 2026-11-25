/**
 * Cryptographic primitives for opening password-protected Office files: SHA-1, SHA-256, SHA-384, SHA-512,
 * AES decryption and the RC4 stream. An own implementation: crypto.subtle is unavailable on pages without HTTPS
 * (a WebView often is one) and lacks the ECB mode the format needs.
 */

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

function pad(data: Uint8Array, block: number, lengthBytes: number, bigEndian = true): Uint8Array {
  const total = Math.ceil((data.length + 1 + lengthBytes) / block) * block;
  const out = new Uint8Array(total);
  out.set(data);
  out[data.length] = 0x80;
  const bits = data.length * 8;
  const view = new DataView(out.buffer);
  if (bigEndian) {
    view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(total - 4, bits >>> 0);
  } else {
    view.setUint32(total - 8, bits >>> 0, true);
    view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  }
  return out;
}

export function sha1(data: Uint8Array): Uint8Array {
  const msg = pad(data, 64, 8);
  const view = new DataView(msg.buffer);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h));
  return out;
}

const K256 = new Int32Array(64);
const K512 = new Int32Array(160);
(() => {
  // The constants are fractional parts of cube roots of the first primes; computed exactly with BigInt.
  const primes: number[] = [];
  for (let n = 2; primes.length < 80; n++) if (primes.every((p) => n % p)) primes.push(n);
  const icbrt = (v: bigint): bigint => {
    let lo = 0n;
    let hi = 1n << 90n;
    while (lo < hi) {
      const mid = (lo + hi + 1n) >> 1n;
      if (mid * mid * mid <= v) lo = mid;
      else hi = mid - 1n;
    }
    return lo;
  };
  primes.forEach((p, i) => {
    const frac = icbrt(BigInt(p) << 192n) & ((1n << 64n) - 1n);
    K512[i * 2] = Number(BigInt.asIntN(32, frac >> 32n));
    K512[i * 2 + 1] = Number(BigInt.asIntN(32, frac));
    if (i < 64) K256[i] = K512[i * 2];
  });
})();

export function sha256(data: Uint8Array): Uint8Array {
  const msg = pad(data, 64, 8);
  const view = new DataView(msg.buffer);
  const h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setInt32(i * 4, x));
  return out;
}

const IV512 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
const IV384 = [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4];

const WH = new Int32Array(80);
const WL = new Int32Array(80);

function sha512core(data: Uint8Array, iv: number[], outBytes: number): Uint8Array {
  const msg = pad(data, 128, 16);
  const view = new DataView(msg.buffer);
  const h = new Int32Array(iv);
  const wh = WH;
  const wl = WL;
  for (let off = 0; off < msg.length; off += 128) {
    for (let i = 0; i < 16; i++) {
      wh[i] = view.getInt32(off + i * 8);
      wl[i] = view.getInt32(off + i * 8 + 4);
    }
    for (let i = 16; i < 80; i++) {
      const ah = wh[i - 15], al = wl[i - 15], bh = wh[i - 2], bl = wl[i - 2];
      const s0h = ((ah >>> 1) | (al << 31)) ^ ((ah >>> 8) | (al << 24)) ^ (ah >>> 7);
      const s0l = ((al >>> 1) | (ah << 31)) ^ ((al >>> 8) | (ah << 24)) ^ ((al >>> 7) | (ah << 25));
      const s1h = ((bh >>> 19) | (bl << 13)) ^ ((bl >>> 29) | (bh << 3)) ^ (bh >>> 6);
      const s1l = ((bl >>> 19) | (bh << 13)) ^ ((bh >>> 29) | (bl << 3)) ^ ((bl >>> 6) | (bh << 26));
      const lo = (wl[i - 16] >>> 0) + (s0l >>> 0) + (wl[i - 7] >>> 0) + (s1l >>> 0);
      wl[i] = lo | 0;
      wh[i] = (wh[i - 16] + s0h + wh[i - 7] + s1h + Math.floor(lo / 4294967296)) | 0;
    }
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let i = 0; i < 80; i++) {
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      const t1lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[i * 2 + 1] >>> 0) + (wl[i] >>> 0);
      const t1l = t1lo | 0;
      const t1h = (hh + S1h + chh + K512[i * 2] + wh[i] + Math.floor(t1lo / 4294967296)) | 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const ml = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2lo = (S0l >>> 0) + (ml >>> 0);
      const t2h = (S0h + mh + Math.floor(t2lo / 4294967296)) | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      const elo = (dl >>> 0) + (t1l >>> 0);
      el = elo | 0;
      eh = (dh + t1h + Math.floor(elo / 4294967296)) | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      const alo = (t1l >>> 0) + (t2lo % 4294967296);
      al = alo | 0;
      ah = (t1h + t2h + Math.floor(alo / 4294967296)) | 0;
    }
    const add = (i: number, hi: number, lo: number) => {
      const s = (h[i + 1] >>> 0) + (lo >>> 0);
      h[i + 1] = s | 0;
      h[i] = (h[i] + hi + Math.floor(s / 4294967296)) | 0;
    };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setInt32(i * 4, x));
  return out.subarray(0, outBytes);
}

export const sha512 = (data: Uint8Array) => sha512core(data, IV512, 64);
export const sha384 = (data: Uint8Array) => sha512core(data, IV384, 48);

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

/** MD5: needed only for the legacy RC4 encryption in doc and xls. */
export function md5(data: Uint8Array): Uint8Array {
  const msg = pad(data, 64, 8, false);
  const view = new DataView(msg.buffer);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const m = new Int32Array(16);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      f = (f + a + MD5_K[i] + m[g]) | 0;
      a = d; d = c; c = b;
      b = (b + rotl(f, MD5_S[((i >> 4) << 2) | (i & 3)])) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
  return out;
}

export type HashName = 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512';
export function hashFunction(name: string): (data: Uint8Array) => Uint8Array {
  const n = name.toUpperCase().replace('-', '');
  if (n === 'SHA1') return sha1;
  if (n === 'SHA256') return sha256;
  if (n === 'SHA384') return sha384;
  if (n === 'SHA512') return sha512;
  throw new Error(`Unknown hash algorithm: ${name}`);
}

// ----- AES (decryption only) -----

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
const mul = (a: number, b: number) => {
  let r = 0;
  for (; b; b >>= 1) {
    if (b & 1) r ^= a;
    a = (a << 1) ^ (a & 0x80 ? 0x11b : 0);
  }
  return r;
};
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();
const M9 = new Uint8Array(256), M11 = new Uint8Array(256), M13 = new Uint8Array(256), M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  M9[i] = mul(i, 9); M11[i] = mul(i, 11); M13[i] = mul(i, 13); M14[i] = mul(i, 14);
}

export class AesDecryptor {
  private readonly rk: Uint8Array;
  private readonly rounds: number;

  constructor(key: Uint8Array) {
    const nk = key.length / 4;
    if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('Invalid AES key length');
    this.rounds = nk + 6;
    const rk = new Uint8Array(16 * (this.rounds + 1));
    rk.set(key);
    let rcon = 1;
    for (let i = key.length; i < rk.length; i += 4) {
      let t0 = rk[i - 4], t1 = rk[i - 3], t2 = rk[i - 2], t3 = rk[i - 1];
      if ((i / 4) % nk === 0) {
        const s = SBOX[t0];
        t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = s;
        rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0);
      } else if (nk > 6 && (i / 4) % nk === 4) {
        t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
      }
      rk[i] = rk[i - key.length] ^ t0;
      rk[i + 1] = rk[i - key.length + 1] ^ t1;
      rk[i + 2] = rk[i - key.length + 2] ^ t2;
      rk[i + 3] = rk[i - key.length + 3] ^ t3;
    }
    this.rk = rk;
  }

  /** Decrypts one block (16 bytes) in place. */
  private block(s: Uint8Array, off: number): void {
    const rk = this.rk;
    let k = this.rounds * 16;
    for (let i = 0; i < 16; i++) s[off + i] ^= rk[k + i];
    const t = new Uint8Array(16);
    for (let round = this.rounds - 1; round >= 0; round--) {
      // Inverse row shift and inverse byte substitution.
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) & 3) * 4 + r] = INV[s[off + c * 4 + r]];
      k = round * 16;
      for (let i = 0; i < 16; i++) t[i] ^= rk[k + i];
      if (round === 0) {
        s.set(t, off);
        break;
      }
      for (let c = 0; c < 16; c += 4) {
        const a = t[c], b = t[c + 1], d = t[c + 2], e = t[c + 3];
        s[off + c] = M14[a] ^ M11[b] ^ M13[d] ^ M9[e];
        s[off + c + 1] = M9[a] ^ M14[b] ^ M11[d] ^ M13[e];
        s[off + c + 2] = M13[a] ^ M9[b] ^ M14[d] ^ M11[e];
        s[off + c + 3] = M11[a] ^ M13[b] ^ M9[d] ^ M14[e];
      }
    }
  }

  /** ECB mode: every block independently. The data length must be a multiple of 16. */
  ecb(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.subarray(0, data.length - (data.length % 16)));
    for (let off = 0; off < out.length; off += 16) this.block(out, off);
    return out;
  }

  /** CBC mode without removing the padding. */
  cbc(data: Uint8Array, iv: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.subarray(0, data.length - (data.length % 16)));
    let prev = iv;
    for (let off = 0; off < out.length; off += 16) {
      this.block(out, off);
      for (let i = 0; i < 16; i++) out[off + i] ^= prev[i];
      prev = data.subarray(off, off + 16);
    }
    return out;
  }
}

/** RC4 stream: encryption and decryption are the same. */
export class Rc4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;
  constructor(key: Uint8Array) {
    const s = this.s;
    for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + s[i] + key[i % key.length]) & 0xff;
      const t = s[i]; s[i] = s[j]; s[j] = t;
    }
  }
  /** Transforms data in place. */
  apply(data: Uint8Array, start = 0, end = data.length): void {
    const s = this.s;
    let { i, j } = this;
    for (let p = start; p < end; p++) {
      i = (i + 1) & 0xff;
      j = (j + s[i]) & 0xff;
      const t = s[i]; s[i] = s[j]; s[j] = t;
      data[p] ^= s[(s[i] + s[j]) & 0xff];
    }
    this.i = i;
    this.j = j;
  }
  /** Skips n bytes of the stream. */
  skip(n: number): void {
    this.apply(new Uint8Array(n));
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

export function le32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
