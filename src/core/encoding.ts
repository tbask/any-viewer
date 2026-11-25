/**
 * Encoding detection for text files (txt, csv).
 * Order: BOM → signs of UTF-16 without a BOM → valid UTF-8 check → fallback encoding.
 */

export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * Checks whether the bytes are valid UTF-8.
 * An incomplete sequence at the very end is allowed: the buffer may have been cut at a limit.
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    let cp: number;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
      cp = b & 0x07;
    } else {
      return false;
    }
    if (i + need >= n) {
      // Truncated tail: check only the continuation bytes that are present.
      for (let k = i + 1; k < n; k++) if ((bytes[k] & 0xc0) !== 0x80) return false;
      return true;
    }
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

export function detectEncoding(bytes: Uint8Array, fallback = 'windows-1251'): string {
  const n = bytes.length;
  if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (n >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (n >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';

  // UTF-16 without a BOM: for Latin and Cyrillic every other byte is zero or from a narrow range.
  const sample = Math.min(n, 4096) & ~1;
  if (sample >= 8) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < sample; i += 2) {
      if (bytes[i] === 0) evenZero++;
      if (bytes[i + 1] === 0) oddZero++;
    }
    const pairs = sample / 2;
    if (oddZero > pairs * 0.4 && evenZero < pairs * 0.05) return 'utf-16le';
    if (evenZero > pairs * 0.4 && oddZero < pairs * 0.05) return 'utf-16be';
  }

  return isValidUtf8(bytes) ? 'utf-8' : fallback;
}

export function decodeText(bytes: Uint8Array, fallback = 'windows-1251'): DecodedText {
  let encoding = detectEncoding(bytes, fallback);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    encoding = 'windows-1251';
    try {
      decoder = new TextDecoder(encoding);
    } catch {
      encoding = 'utf-8';
      decoder = new TextDecoder(encoding);
    }
  }
  // TextDecoder drops the BOM itself.
  return { text: decoder.decode(bytes), encoding: decoder.encoding || encoding };
}
