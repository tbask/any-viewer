/**
 * An own TIFF decoder (browsers do not show this format).
 * "Baseline" TIFF as saved by scanners and graphics editors is supported: strips,
 * no compression / LZW / PackBits / Deflate, 1, 8 and 16 bits per channel, grey, palette and RGB(A) images.
 * Not supported: tiles, JPEG and CCITT fax compression inside TIFF, CMYK.
 * Of a multi-page file the first page is shown.
 */
import { inflateRaw } from './inflate';

export class TiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TiffError';
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let op = 0;
  let ip = 0;
  let bits = 9;
  let next = 258;
  let old = -1;
  let first = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  while (op < expected) {
    while (bitCnt < bits) {
      if (ip >= src.length) return out;
      bitBuf = ((bitBuf << 8) | src[ip++]) & 0xffffff;
      bitCnt += 8;
    }
    const code = (bitBuf >> (bitCnt - bits)) & ((1 << bits) - 1);
    bitCnt -= bits;
    if (code === 257) break; // end of data
    if (code === 256) {
      // dictionary reset
      bits = 9;
      next = 258;
      old = -1;
      continue;
    }
    if (old === -1) {
      out[op++] = code;
      old = code;
      first = code;
      continue;
    }
    let sp = 0;
    let cur = code;
    if (code >= next) {
      // The code is not in the dictionary yet: it is "the previous string + its first character".
      stack[sp++] = first;
      cur = old;
    }
    while (cur >= 258) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    first = cur;
    stack[sp++] = cur;
    while (sp > 0 && op < expected) out[op++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
    }
    // A TIFF quirk: the code length grows one code earlier than in GIF.
    if (next >= (1 << bits) - 1 && bits < 12) bits++;
    old = code;
  }
  return out;
}

function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let ip = 0;
  let op = 0;
  while (ip < src.length && op < expected) {
    const n = (src[ip++] << 24) >> 24;
    if (n >= 0) {
      for (let i = 0; i <= n && op < expected; i++) out[op++] = src[ip++];
    } else if (n !== -128) {
      const value = src[ip++];
      for (let i = 0; i < 1 - n && op < expected; i++) out[op++] = value;
    }
  }
  return out;
}

const COMPRESSION_NAMES: Record<number, string> = { 2: 'CCITT', 3: 'CCITT Group 3', 4: 'CCITT Group 4', 6: 'JPEG', 7: 'JPEG', 34712: 'JPEG 2000' };

export function decodeTiff(data: Uint8Array, maxPixels = 64_000_000): DecodedImage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 8) throw new TiffError('The file is not a TIFF image');
  const le = data[0] === 0x49 && data[1] === 0x49;
  if (!le && !(data[0] === 0x4d && data[1] === 0x4d)) throw new TiffError('The file is not a TIFF image');
  if (view.getUint16(2, le) !== 42) throw new TiffError('TIFF variant is not supported');
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > data.length) throw new TiffError('The TIFF file is corrupt');

  const tags = new Map<number, number[]>();
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > data.length) break;
    const tag = view.getUint16(at, le);
    const type = view.getUint16(at + 2, le);
    const n = view.getUint32(at + 4, le);
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 1 || type === 2 || type === 6 || type === 7 ? 1 : 0;
    if (!size || n > 1_000_000) continue;
    const offset = n * size <= 4 ? at + 8 : view.getUint32(at + 8, le);
    if (offset + n * size > data.length) continue;
    const values: number[] = [];
    for (let k = 0; k < n; k++) values.push(size === 2 ? view.getUint16(offset + k * 2, le) : size === 4 ? view.getUint32(offset + k * 4, le) : data[offset + k]);
    tags.set(tag, values);
  }
  const one = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;

  const width = one(256, 0);
  const height = one(257, 0);
  if (!width || !height) throw new TiffError('The TIFF file has no image dimensions');
  if (width * height > maxPixels) throw new TiffError('The TIFF image is too large');
  if (tags.has(322)) throw new TiffError('Tiled TIFF images are not supported');
  const bits = one(258, 1);
  const samples = one(277, 1);
  const compression = one(259, 1);
  const photometric = one(262, bits === 1 ? 0 : 1);
  const predictor = one(317, 1);
  if (one(284, 1) !== 1) throw new TiffError('Planar TIFF configuration is not supported');
  if (bits !== 1 && bits !== 8 && bits !== 16) throw new TiffError(`TIFF bit depth ${bits} is not supported`);
  if (photometric > 3) throw new TiffError('The colour model of this TIFF is not supported');
  if (![1, 5, 8, 32946, 32773].includes(compression)) throw new TiffError(`TIFF compression ${COMPRESSION_NAMES[compression] ?? compression} is not supported`);

  const offsets = tags.get(273) ?? [];
  const byteCounts = tags.get(279) ?? [];
  const rowsPerStrip = Math.min(one(278, height), height);
  const bytesPerSample = bits === 16 ? 2 : 1;
  const rowBytes = bits === 1 ? Math.ceil((width * samples) / 8) : width * samples * bytesPerSample;
  const raw = new Uint8Array(rowBytes * height);

  offsets.forEach((offset, s) => {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    if (rows <= 0) return;
    const expected = rows * rowBytes;
    const length = byteCounts[s] ?? Math.max(0, data.length - offset);
    const src = data.subarray(offset, Math.min(offset + length, data.length));
    let strip: Uint8Array;
    if (compression === 1) strip = src;
    else if (compression === 5) strip = lzwDecode(src, expected);
    else if (compression === 32773) strip = packBitsDecode(src, expected);
    else strip = inflateRaw(src.subarray(2), expected, expected + 1024); // zlib: two header bytes, then deflate
    raw.set(strip.subarray(0, Math.min(expected, strip.length)), s * rowsPerStrip * rowBytes);
  });

  // Horizontal predictor: every sample is stored as the difference from its left neighbour.
  if (predictor === 2 && bits === 8) {
    for (let y = 0; y < height; y++) {
      const row = y * rowBytes;
      for (let x = samples; x < rowBytes; x++) raw[row + x] = (raw[row + x] + raw[row + x - samples]) & 0xff;
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const palette = tags.get(320);
  const sample = (index: number) => (bits === 16 ? raw[index * 2 + (le ? 1 : 0)] : raw[index]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bits === 1) {
        const bit = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = (photometric === 0 ? !bit : bit) ? 255 : 0;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = 255;
        continue;
      }
      const i = (y * width + x) * samples;
      if (photometric === 2 && samples >= 3) {
        rgba[o] = sample(i);
        rgba[o + 1] = sample(i + 1);
        rgba[o + 2] = sample(i + 2);
        rgba[o + 3] = samples >= 4 && tags.has(338) ? sample(i + 3) : 255;
      } else if (photometric === 3 && palette) {
        const n = palette.length / 3;
        const v = sample(i);
        rgba[o] = palette[v] >> 8;
        rgba[o + 1] = palette[n + v] >> 8;
        rgba[o + 2] = palette[2 * n + v] >> 8;
        rgba[o + 3] = 255;
      } else {
        const v = photometric === 0 ? 255 - sample(i) : sample(i);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = samples >= 2 && tags.has(338) ? sample(i + 1) : 255;
      }
    }
  }
  return { width, height, rgba };
}
