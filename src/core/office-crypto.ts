/**
 * Opening password-protected Office files.
 *
 * A docx/xlsx/pptx with a password is a CFB container with the EncryptionInfo and EncryptedPackage streams: an encrypted
 * zip inside. "Agile" encryption (Office 2010 and newer) and "standard" encryption (Office 2007) are supported.
 * For doc, RC4 CryptoAPI encryption (Word 2003 and newer) is supported.
 */
import { CfbReader } from './cfb';
import { AesDecryptor, concatBytes, hashFunction, le32, md5, Rc4, sha1, utf16le } from './crypto';
import { attr, localName, parseXml, type XmlNode } from './xml';

function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (localName(c.name) === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

export class PasswordError extends Error {
  /** wrong: a password was given but did not fit; unsupported: the encryption method is not supported. */
  constructor(readonly reason: 'required' | 'wrong' | 'unsupported' = 'required') {
    super(reason === 'wrong' ? 'Wrong password' : reason === 'unsupported' ? 'The encryption method is not supported' : 'The file is password protected');
    this.name = reason === 'wrong' ? 'WrongPasswordError' : reason === 'unsupported' ? 'EncryptionUnsupportedError' : 'PasswordRequiredError';
  }
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const equal = (a: Uint8Array, b: Uint8Array, n: number) => {
  if (a.length < n || b.length < n) return false;
  let diff = 0;
  for (let i = 0; i < n; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};
const fit = (data: Uint8Array, size: number, fill: number) => {
  if (data.length >= size) return data.subarray(0, size);
  const out = new Uint8Array(size).fill(fill);
  out.set(data);
  return out;
};

function decryptAgile(info: Uint8Array, pkg: Uint8Array, password: string): Uint8Array {
  const xml = parseXml(new TextDecoder().decode(info.subarray(8)));
  const keyData = descendants(xml, 'keyData')[0];
  const enc = descendants(xml, 'encryptedKey')[0];
  if (!keyData || !enc) throw new PasswordError('unsupported');
  const need = (node: typeof keyData, name: string) => {
    const v = attr(node, name);
    if (v === undefined) throw new PasswordError('unsupported');
    return v;
  };
  if (need(enc, 'cipherAlgorithm') !== 'AES' || need(keyData, 'cipherAlgorithm') !== 'AES' || need(enc, 'cipherChaining') !== 'ChainingModeCBC' || need(keyData, 'cipherChaining') !== 'ChainingModeCBC') {
    throw new PasswordError('unsupported');
  }
  let hash: (d: Uint8Array) => Uint8Array;
  let dataHash: (d: Uint8Array) => Uint8Array;
  try {
    hash = hashFunction(need(enc, 'hashAlgorithm'));
    dataHash = hashFunction(need(keyData, 'hashAlgorithm'));
  } catch {
    throw new PasswordError('unsupported');
  }
  const spin = Number(need(enc, 'spinCount'));
  if (!(spin >= 0 && spin <= 10_000_000)) throw new PasswordError('unsupported');
  const salt = b64(need(enc, 'saltValue'));
  const keyBytes = Number(need(enc, 'keyBits')) / 8;
  const blockSize = Number(need(enc, 'blockSize'));
  const hashSize = Number(need(enc, 'hashSize'));

  // Repeated hashing of the password: deliberately slow, to hinder guessing.
  let h = hash(concatBytes(salt, utf16le(password)));
  const buf = new Uint8Array(4 + h.length);
  for (let i = 0; i < spin; i++) {
    buf[0] = i & 0xff;
    buf[1] = (i >>> 8) & 0xff;
    buf[2] = (i >>> 16) & 0xff;
    buf[3] = (i >>> 24) & 0xff;
    buf.set(h, 4);
    h = hash(buf);
  }
  const derive = (blockKey: number[]) => new AesDecryptor(fit(hash(concatBytes(h, new Uint8Array(blockKey))), keyBytes, 0x36));
  const iv = fit(salt, blockSize, 0x36);
  const verifierInput = derive([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]).cbc(b64(need(enc, 'encryptedVerifierHashInput')), iv);
  const verifierHash = derive([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]).cbc(b64(need(enc, 'encryptedVerifierHashValue')), iv);
  if (!equal(hash(verifierInput.subarray(0, salt.length)), verifierHash, hashSize)) throw new PasswordError('wrong');
  const secret = derive([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]).cbc(b64(need(enc, 'encryptedKeyValue')), iv).subarray(0, keyBytes);

  const dataSalt = b64(need(keyData, 'saltValue'));
  const dataBlock = Number(need(keyData, 'blockSize'));
  const aes = new AesDecryptor(fit(secret, Number(need(keyData, 'keyBits')) / 8, 0));
  const view = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  const size = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
  const body = pkg.subarray(8);
  if (size > body.length) throw new Error('The encrypted file is truncated');
  const out = new Uint8Array(size);
  for (let seg = 0, off = 0; off < size; seg++, off += 4096) {
    const segIv = fit(dataHash(concatBytes(dataSalt, le32(seg))), dataBlock, 0x36);
    const plain = aes.cbc(body.subarray(off, Math.min(off + 4096, body.length)), segIv);
    out.set(plain.subarray(0, Math.min(plain.length, size - off)), off);
  }
  return out;
}

interface CryptoApiHeader {
  algId: number;
  hashId: number;
  keyBits: number;
  salt: Uint8Array;
  verifier: Uint8Array;
  verifierHash: Uint8Array;
}

/** CryptoAPI encryption header: shared by OOXML "standard" encryption and RC4 in doc. */
function readCryptoApiHeader(info: Uint8Array): CryptoApiHeader {
  const v = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const headerSize = v.getUint32(8, true);
  const h = 12;
  if (h + headerSize + 4 > info.length) throw new PasswordError('unsupported');
  const algId = v.getUint32(h + 8, true);
  const hashId = v.getUint32(h + 12, true);
  const keyBits = v.getUint32(h + 16, true);
  let p = h + headerSize;
  const saltSize = v.getUint32(p, true);
  p += 4;
  const salt = info.subarray(p, p + saltSize);
  p += saltSize;
  const verifier = info.subarray(p, p + 16);
  p += 16;
  const hashSize = v.getUint32(p, true);
  p += 4;
  // For AES the verifier hash is padded to a whole number of blocks.
  const verifierHash = info.subarray(p, p + (algId === 0x6801 ? hashSize : Math.ceil(hashSize / 16) * 16));
  return { algId, hashId, keyBits, salt, verifier, verifierHash };
}

function decryptStandard(info: Uint8Array, pkg: Uint8Array, password: string): Uint8Array {
  const head = readCryptoApiHeader(info);
  if (![0x660e, 0x660f, 0x6610].includes(head.algId) || (head.hashId !== 0x8004 && head.hashId !== 0)) throw new PasswordError('unsupported');
  let h = sha1(concatBytes(head.salt, utf16le(password)));
  for (let i = 0; i < 50000; i++) h = sha1(concatBytes(le32(i), h));
  h = sha1(concatBytes(h, le32(0)));
  const mix = (fill: number) => {
    const buf = new Uint8Array(64).fill(fill);
    for (let i = 0; i < h.length; i++) buf[i] ^= h[i];
    return sha1(buf);
  };
  const aes = new AesDecryptor(concatBytes(mix(0x36), mix(0x5c)).subarray(0, head.keyBits / 8));
  if (!equal(sha1(aes.ecb(head.verifier)), aes.ecb(head.verifierHash), 20)) throw new PasswordError('wrong');
  const view = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  const size = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
  const plain = aes.ecb(pkg.subarray(8));
  if (size > plain.length) throw new Error('The encrypted file is truncated');
  return plain.subarray(0, size);
}

/** Decrypts a password-protected docx/xlsx/pptx and returns the original zip. */
export async function decryptOoxml(blob: Blob, password: string): Promise<Uint8Array> {
  const cfb = await CfbReader.open(blob);
  const infoEntry = cfb.find('EncryptionInfo');
  const pkgEntry = cfb.find('EncryptedPackage');
  if (!infoEntry || !pkgEntry) throw new PasswordError('unsupported');
  const info = cfb.read(infoEntry);
  const pkg = cfb.read(pkgEntry);
  const major = info[0] | (info[1] << 8);
  const minor = info[2] | (info[3] << 8);
  if (major === 4 && minor === 4) return decryptAgile(info, pkg, password);
  if ((major === 2 || major === 3 || major === 4) && minor === 2) return decryptStandard(info, pkg, password);
  throw new PasswordError('unsupported');
}

/**
 * RC4 keys for the binary formats (doc, xls, ppt). header starts with the encryption version number:
 * 1.1 is the legacy RC4 (MD5, 40 bits), 2.2–4.2 is RC4 CryptoAPI (SHA-1). Returns a key by block number; the password is checked at once.
 */
export function rc4KeySource(header: Uint8Array, password: string | undefined): (block: number) => Uint8Array {
  if (header.length < 4) throw new PasswordError('unsupported');
  const major = header[0] | (header[1] << 8);
  const minor = header[2] | (header[3] << 8);
  let keyFor: (block: number) => Uint8Array;
  let verifier: Uint8Array;
  let verifierHash: Uint8Array;
  let hash: (data: Uint8Array) => Uint8Array;
  if (major === 1 && minor === 1) {
    if (header.length < 52) throw new PasswordError('unsupported');
    if (password === undefined) throw new PasswordError('required');
    const salt = header.subarray(4, 20);
    const first = md5(utf16le(password)).subarray(0, 5);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 16; i++) parts.push(first, salt);
    const base = md5(concatBytes(...parts)).subarray(0, 5);
    keyFor = (block) => md5(concatBytes(base, le32(block)));
    verifier = new Uint8Array(header.subarray(20, 36));
    verifierHash = new Uint8Array(header.subarray(36, 52));
    hash = md5;
  } else if ((major === 2 || major === 3 || major === 4) && minor === 2) {
    if (password === undefined) throw new PasswordError('required');
    const head = readCryptoApiHeader(header);
    if (head.algId !== 0x6801 || head.hashId !== 0x8004) throw new PasswordError('unsupported');
    const base = sha1(concatBytes(head.salt, utf16le(password)));
    const keyBits = head.keyBits || 40;
    keyFor = (block) => {
      const h = sha1(concatBytes(base, le32(block)));
      // A 40-bit key is zero-padded to 128 bits.
      return keyBits === 40 ? fit(h.subarray(0, 5), 16, 0) : h.subarray(0, keyBits / 8);
    };
    verifier = new Uint8Array(head.verifier);
    verifierHash = new Uint8Array(head.verifierHash);
    hash = sha1;
  } else throw new PasswordError('unsupported');
  const check = new Rc4(keyFor(0));
  check.apply(verifier);
  check.apply(verifierHash);
  const digest = hash(verifier);
  if (!equal(digest, verifierHash, digest.length)) throw new PasswordError('wrong');
  return keyFor;
}

/**
 * Decryption of doc streams. Streams are encrypted in 512-byte blocks, each block with its own key.
 * header is the start of the table stream, where the encryption header lies.
 */
export function createDocDecryptor(header: Uint8Array, password: string | undefined): (stream: Uint8Array, plainPrefix: number) => Uint8Array {
  const keyFor = rc4KeySource(header, password);
  return (stream, plainPrefix) => {
    const out = new Uint8Array(stream);
    for (let off = 0, block = 0; off < out.length; off += 512, block++) new Rc4(keyFor(block)).apply(out, off, Math.min(off + 512, out.length));
    // The start of the stream is stored in plain text but still occupies room in the cipher stream.
    out.set(stream.subarray(0, Math.min(plainPrefix, stream.length)));
    return out;
  };
}

const XOR_PAD = [0xbb, 0xff, 0xff, 0xba, 0xff, 0xff, 0xb9, 0x80, 0x00, 0xbe, 0x0f, 0x00, 0xbf, 0x0f, 0x00];
const XOR_INITIAL = [0xe1f0, 0x1d0f, 0xcc9c, 0x84c0, 0x110c, 0x0e10, 0xf1ce, 0x313e, 0x1872, 0xe139, 0xd40f, 0x84f9, 0x280c, 0xa96a, 0x4ec3];
const XOR_MATRIX = [
  0xaefc, 0x4dd9, 0x9bb2, 0x2745, 0x4e8a, 0x9d14, 0x2a09, 0x7b61, 0xf6c2, 0xfda5, 0xeb6b, 0xc6f7, 0x9dcf, 0x2bbf, 0x4563, 0x8ac6, 0x05ad, 0x0b5a, 0x16b4, 0x2d68, 0x5ad0,
  0x0375, 0x06ea, 0x0dd4, 0x1ba8, 0x3750, 0x6ea0, 0xdd40, 0xd849, 0xa0b3, 0x5147, 0xa28e, 0x553d, 0xaa7a, 0x44d5, 0x6f45, 0xde8a, 0xad35, 0x4a4b, 0x9496, 0x390d, 0x721a,
  0xeb23, 0xc667, 0x9cef, 0x29ff, 0x53fe, 0xa7fc, 0x5fd9, 0x47d3, 0x8fa6, 0x0f6d, 0x1eda, 0x3db4, 0x7b68, 0xf6d0, 0xb861, 0x60e3, 0xc1c6, 0x93ad, 0x377b, 0x6ef6, 0xddec,
  0x45a0, 0x8b40, 0x06a1, 0x0d42, 0x1a84, 0x3508, 0x6a10, 0xaa51, 0x4483, 0x8906, 0x022d, 0x045a, 0x08b4, 0x1168, 0x76b4, 0xed68, 0xcaf1, 0x85c3, 0x1ba7, 0x374e, 0x6e9c,
  0x3730, 0x6e60, 0xdcc0, 0xa9a1, 0x4363, 0x86c6, 0x1dad, 0x3331, 0x6662, 0xccc4, 0x89a9, 0x0373, 0x06e6, 0x0dcc, 0x1021, 0x2042, 0x4084, 0x8108, 0x1231, 0x2462, 0x48c4,
];

/**
 * An xls workbook with "XOR obfuscation" (Excel 95 and the weak protection mode): every byte of record content
 * is XORed with a byte of the 16-byte key derived from the password and rotated.
 */
function decryptXlsXor(stream: Uint8Array, filepass: number, verifier: number, password: string | undefined): Uint8Array {
  if (password === undefined) throw new PasswordError('required');
  // The password is at most 15 single-byte characters.
  const chars = [...password].map((ch) => ch.charCodeAt(0) & 0xff).slice(0, 15);
  if (!chars.length) throw new PasswordError('wrong');
  let check = 0;
  for (const byte of [chars.length, ...chars].reverse()) check = ((check & 0x4000 ? 1 : 0) ^ ((check * 2) & 0x7fff)) ^ byte;
  if ((check ^ 0xce4b) !== verifier) throw new PasswordError('wrong');
  let key = XOR_INITIAL[chars.length - 1];
  let element = 0x68;
  for (let ch of [...chars].reverse()) {
    for (let i = 0; i < 7; i++) {
      if (ch & 0x40) key ^= XOR_MATRIX[element];
      ch = (ch << 1) & 0xff;
      element--;
    }
  }
  const ror1 = (a: number, b: number) => (((a ^ b) >> 1) | ((a ^ b) << 7)) & 0xff;
  const array = new Uint8Array(16);
  const high = (key >> 8) & 0xff;
  const low = key & 0xff;
  let index = chars.length;
  if (index % 2 === 1) {
    array[index] = ror1(XOR_PAD[0], high);
    index--;
    array[index] = ror1(chars[chars.length - 1], low);
  }
  while (index > 0) {
    index--;
    array[index] = ror1(chars[index], high);
    index--;
    array[index] = ror1(chars[index], low);
  }
  index = 15;
  for (let pad = 15 - chars.length; pad > 0; ) {
    array[index--] = ror1(XOR_PAD[pad--], high);
    array[index--] = ror1(XOR_PAD[pad--], low);
  }
  const out = new Uint8Array(stream);
  const view = new DataView(out.buffer);
  for (let pos = 0; pos + 4 <= out.length; ) {
    const id = view.getUint16(pos, true);
    const size = view.getUint16(pos + 2, true);
    const start = pos + 4;
    const end = Math.min(out.length, start + size);
    if (!XLS_PLAIN.has(id)) {
      const from = id === 0x0085 ? Math.min(end, start + 4) : start;
      // The position in the key depends on the record's place in the stream and its full size.
      let k = (from + size) % 16;
      for (let p = from; p < end; p++, k = (k + 1) % 16) {
        const x = out[p] ^ array[k];
        out[p] = ((x >> 5) | (x << 3)) & 0xff;
      }
    }
    pos = end;
  }
  out[filepass] = 0xff;
  out[filepass + 1] = 0xff;
  return out;
}

const XLS_PLAIN = new Set([0x0809, 0x002f, 0x0194, 0x0195, 0x00e1, 0x0196, 0x0138]);

/**
 * An xls workbook (BIFF8) with a password: returns the decrypted stream, or the original if there is no encryption.
 * Only record content is encrypted; the key changes every 1024 bytes of the stream, record headers included.
 */
export function decryptXlsStream(stream: Uint8Array, password: string | undefined): Uint8Array {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let filepass = -1;
  for (let pos = 0, n = 0; pos + 4 <= stream.length && n < 40; n++) {
    const id = view.getUint16(pos, true);
    if (id === 0x002f) { filepass = pos; break; }
    if (n > 0 && (id === 0x0809 || id === 0x000a)) break;
    pos += 4 + view.getUint16(pos + 2, true);
  }
  if (filepass < 0) return stream;
  const len = view.getUint16(filepass + 2, true);
  // 0: XOR obfuscation (Excel 95 and "weak protection"), 1: RC4. Excel 95 has no kind field: always XOR.
  if (len === 4 || (len >= 6 && view.getUint16(filepass + 4, true) === 0)) {
    return decryptXlsXor(stream, filepass, view.getUint16(filepass + (len === 4 ? 6 : 8), true), password);
  }
  if (len < 6 || view.getUint16(filepass + 4, true) !== 1) throw new PasswordError('unsupported');
  const keyFor = rc4KeySource(stream.subarray(filepass + 6, filepass + 4 + len), password);
  const out = new Uint8Array(stream);
  let rc4: Rc4 | undefined;
  let block = -1;
  let at = 0;
  const run = (from: number, to: number) => {
    let p = from;
    while (p < to) {
      const b = Math.floor(p / 1024);
      if (!rc4 || b !== block || p < at) {
        rc4 = new Rc4(keyFor(b));
        block = b;
        at = b * 1024;
      }
      if (p > at) rc4.skip(p - at);
      const end = Math.min(to, (b + 1) * 1024);
      rc4.apply(out, p, end);
      at = end;
      p = end;
    }
  };
  for (let pos = 0; pos + 4 <= out.length; ) {
    const id = view.getUint16(pos, true);
    const size = view.getUint16(pos + 2, true);
    const start = pos + 4;
    const end = Math.min(out.length, start + size);
    // In a sheet record the first four bytes (the sheet offset) are stored in the clear.
    if (!XLS_PLAIN.has(id)) run(id === 0x0085 ? Math.min(end, start + 4) : start, end);
    pos = end;
  }
  // The encryption record is no longer needed: make it unknown so that parsing continues.
  out[filepass] = 0xff;
  out[filepass + 1] = 0xff;
  return out;
}

/**
 * A ppt presentation with a password (RC4 CryptoAPI). Returns the decrypted document stream and a function for pictures,
 * or null if there is no encryption. Every persist object is encrypted with its own key, by its number.
 */
export function decryptPptStream(data: Uint8Array, currentUser: Uint8Array | undefined, password: string | undefined): { data: Uint8Array; pictures: (stream: Uint8Array) => Uint8Array } | null {
  if (!currentUser || currentUser.length < 20) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cu = new DataView(currentUser.buffer, currentUser.byteOffset, currentUser.byteLength);
  const persist = new Map<number, number>();
  let cryptRef = 0;
  // Edit chain: from the last to the first; later directory entries take precedence.
  for (let edit = cu.getUint32(16, true), guard = 0; edit > 0 && edit + 36 <= data.length && guard < 1000; guard++) {
    if (dv.getUint16(edit + 2, true) !== 0x0ff5) break;
    const recLen = dv.getUint32(edit + 4, true);
    if (recLen >= 32 && !cryptRef) cryptRef = dv.getUint32(edit + 36, true);
    const dir = dv.getUint32(edit + 20, true);
    if (dir + 8 <= data.length && dv.getUint16(dir + 2, true) === 0x1772) {
      const end = Math.min(data.length, dir + 8 + dv.getUint32(dir + 4, true));
      for (let p = dir + 8; p + 4 <= end; ) {
        const head = dv.getUint32(p, true);
        const first = head & 0xfffff;
        const count = head >>> 20;
        p += 4;
        for (let i = 0; i < count && p + 4 <= end; i++, p += 4) if (!persist.has(first + i)) persist.set(first + i, dv.getUint32(p, true));
      }
    }
    edit = dv.getUint32(edit + 16, true);
  }
  const cryptAt = cryptRef ? persist.get(cryptRef) : undefined;
  if (cryptAt === undefined || cryptAt + 8 > data.length || dv.getUint16(cryptAt + 2, true) !== 0x2f14) return null;
  const keyFor = rc4KeySource(data.subarray(cryptAt + 8, Math.min(data.length, cryptAt + 8 + dv.getUint32(cryptAt + 4, true))), password);
  const out = new Uint8Array(data);
  const ov = new DataView(out.buffer);
  for (const [id, offset] of persist) {
    if (id === cryptRef || offset + 8 > out.length) continue;
    const rc4 = new Rc4(keyFor(id));
    rc4.apply(out, offset, offset + 8);
    rc4.apply(out, offset + 8, Math.min(out.length, offset + 8 + ov.getUint32(offset + 4, true)));
  }
  // The record with the encryption parameters is made unknown.
  out[cryptAt + 2] = 0xff;
  out[cryptAt + 3] = 0xff;
  const pictures = (stream: Uint8Array) => {
    const pic = new Uint8Array(stream);
    const pv = new DataView(pic.buffer);
    const piece = (from: number, size: number) => {
      const end = Math.min(pic.length, from + size);
      if (end > from) new Rc4(keyFor(0)).apply(pic, from, end);
      return end;
    };
    // Every part of a picture record is encrypted anew, with the key of block zero.
    for (let p = 0; p + 8 <= pic.length; ) {
      piece(p, 8);
      const inst = pv.getUint16(p, true) >> 4;
      const type = pv.getUint16(p + 2, true);
      const end = Math.min(pic.length, p + 8 + pv.getUint32(p + 4, true));
      let q = piece(p + 8, 16);
      const metafile = type === 0xf01a || type === 0xf01b || type === 0xf01c;
      const twoUids = metafile ? (inst & 1) === 1 : type === 0xf01d ? inst === 0x46b || inst === 0x6e3 : (inst & 1) === 1;
      if (twoUids) q = piece(q, 16);
      q = piece(q, metafile ? 34 : 1);
      piece(q, end - q);
      if (end <= p) break;
      p = end;
    }
    return pic;
  };
  return { data: out, pictures };
}
