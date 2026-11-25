/**
 * Pictures from office files: regular bitmaps are passed as is, EMF and WMF metafiles are converted to SVG.
 * Only parsers import this module, so the metafile code stays out of the main part of the library.
 */
import { imageMime, sniffImageMime, type DocImage } from './docmodel';
import { inflateRaw } from './inflate';
import { metafileImage, metafileKind } from './metafile';

const copy = (data: Uint8Array): ArrayBuffer => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

/** A picture by its file name in the container and its content; undefined: nothing to show. */
export function loadImage(path: string, data: Uint8Array): DocImage | undefined {
  const mime = imageMime(path);
  if (mime) return { mime, data: copy(data) };
  if (/\.(emf|wmf)$/i.test(path) || metafileKind(data)) return metafileImage(data);
  const sniffed = sniffImageMime(data);
  return sniffed ? { mime: sniffed, data: copy(data) } : undefined;
}

/** true: a file with this name may be shown (a bitmap or a metafile). */
export function isLoadableImage(path: string): boolean {
  return imageMime(path) !== undefined || /\.(emf|wmf)$/i.test(path);
}

/** DIB bitmap (without a file header) → BMP. */
function dibToBmp(dib: Uint8Array): DocImage | undefined {
  if (dib.length < 40) return undefined;
  const v = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const size = v.getUint32(0, true);
  const bpp = v.getUint16(14, true);
  let colors = v.getUint32(32, true);
  if (!colors && bpp <= 8) colors = 1 << bpp;
  const file = new Uint8Array(14 + dib.length);
  const fv = new DataView(file.buffer);
  file[0] = 0x42;
  file[1] = 0x4d;
  fv.setUint32(2, file.length, true);
  fv.setUint32(10, 14 + size + colors * 4 + (v.getUint32(16, true) === 3 && size === 40 ? 12 : 0), true);
  file.set(dib, 14);
  return { mime: 'image/bmp', data: file.buffer as ArrayBuffer };
}

/**
 * An OfficeArt picture record (doc, ppt, xls) at the offset of its header.
 * Bitmaps are stored as is, metafiles compressed, with an extra header.
 */
export function blipImage(bytes: Uint8Array, offset: number): DocImage | undefined {
  if (offset < 0 || offset + 8 > bytes.length) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inst = v.getUint16(offset, true) >> 4;
  let type = v.getUint16(offset + 2, true);
  let start = offset + 8;
  let end = Math.min(bytes.length, start + v.getUint32(offset + 4, true));
  // Picture description record: the picture itself is nested after the 36-byte description and the name.
  if (type === 0xf007) {
    if (start + 36 + 8 > end) return undefined;
    return blipImage(bytes.subarray(0, end), start + 36 + bytes[start + 33]);
  }
  if (type < 0xf018 || type > 0xf117) return undefined;
  if (type === 0xf02a) type = 0xf01d;
  const twoUids = (inst & 1) === 1;
  start += twoUids ? 32 : 16;
  if (type === 0xf01a || type === 0xf01b || type === 0xf01c) {
    if (start + 34 > end) return undefined;
    const saved = v.getUint32(start + 28, true);
    const compressed = bytes[start + 32] === 0;
    const raw = bytes.subarray(start + 34, Math.min(end, start + 34 + saved));
    if (type === 0xf01c) return undefined; // Macintosh PICT drawing
    try {
      // zlib compression: two header bytes, then a DEFLATE stream.
      const data = compressed ? inflateRaw(raw.subarray(2), v.getUint32(start, true), 64 * 1024 * 1024) : raw;
      return metafileImage(data);
    } catch {
      return undefined;
    }
  }
  start += 1;
  if (start >= end) return undefined;
  const data = bytes.subarray(start, end);
  if (type === 0xf01f) return dibToBmp(data);
  const mime = sniffImageMime(data);
  return mime ? { mime, data: copy(data) } : undefined;
}

/** Looks for a metafile record in a data region (when the exact place of the record is unknown). */
export function findMetafileBlip(bytes: Uint8Array, from: number, to: number): DocImage | undefined {
  const end = Math.min(to, bytes.length) - 8;
  for (let i = Math.max(0, from); i < end; i++) {
    if (bytes[i + 3] !== 0xf0 || (bytes[i + 2] !== 0x1a && bytes[i + 2] !== 0x1b)) continue;
    const inst = (bytes[i] | (bytes[i + 1] << 8)) >> 4;
    if (inst !== 0x3d4 && inst !== 0x3d5 && inst !== 0x216 && inst !== 0x217) continue;
    const image = blipImage(bytes, i);
    if (image) return image;
  }
  return undefined;
}
