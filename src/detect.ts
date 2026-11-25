/**
 * Format detection by content, name and MIME type.
 *
 * Content decides: a file opens as what it really is, even if the extension promises something else
 * (a docx or RTF named .doc; a jpg named .png). In strict mode (strictExtension) such a mismatch is an
 * error; the exception is plain text under a foreign extension, which always opens as text.
 */
import type { FileFormat, FileKind } from './types';
import { looksLikeCms } from './core/cms';
import { ZipReader } from './core/zip';

const EXTENSIONS: Record<string, FileFormat> = {
  // images
  jpg: 'jpg', jpeg: 'jpg', jpe: 'jpg', png: 'png', webp: 'webp', bmp: 'bmp', gif: 'gif', svg: 'svg', tif: 'tiff', tiff: 'tiff', heic: 'heic', heif: 'heic',
  // text
  txt: 'txt', text: 'txt', log: 'txt', md: 'md', markdown: 'md', json: 'json', xml: 'xml', xsd: 'xml', xsl: 'xml', xfdf: 'xml',
  html: 'html', htm: 'html', yaml: 'yaml', yml: 'yaml', sql: 'sql', dxf: 'txt', stl: 'txt', obj: 'txt', fdf: 'txt',
  csv: 'csv', tsv: 'csv', pdf: 'pdf',
  // office documents, including templates and macro-enabled variants (macros are never executed)
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx', doc: 'doc', dot: 'doc', odt: 'odt', rtf: 'rtf',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx', xls: 'xls', xlt: 'xls', ods: 'ods',
  pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', ppsm: 'pptx', potx: 'pptx', ppt: 'ppt', pps: 'ppt', pot: 'ppt', odp: 'odp',
  // mail and calendar
  eml: 'eml', mbox: 'mbox', ics: 'ics', msg: 'msg',
  // archives and containers
  zip: 'zip', asice: 'zip', asics: 'zip', tar: 'tar', gz: 'gz', tgz: 'gz', rar: 'rar', '7z': '7z', epub: 'epub',
  // audio and video
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', aac: 'audio',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', avi: 'video', mkv: 'video',
  // CMS / PKCS#7 digital signature
  p7s: 'p7s', sig: 'p7s', p7m: 'p7m', cms: 'p7m',
  // recognised but not rendered
  dwg: 'dwg', xfa: 'xml',
};

const MIME_TYPES: Record<string, FileFormat> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/heic': 'heic',
  'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml', 'text/html': 'html',
  'text/csv': 'csv', 'text/tab-separated-values': 'csv', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'message/rfc822': 'eml', 'text/calendar': 'ics', 'application/vnd.ms-outlook': 'msg',
  'application/zip': 'zip', 'application/x-tar': 'tar', 'application/gzip': 'gz', 'application/epub+zip': 'epub',
  'audio/mpeg': 'audio', 'audio/wav': 'audio', 'audio/mp4': 'audio', 'audio/ogg': 'audio', 'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video', 'video/x-msvideo': 'video',
};

const KINDS: Record<FileFormat, FileKind> = {
  jpg: 'image', png: 'image', webp: 'image', bmp: 'image', gif: 'image', svg: 'image', tiff: 'image', heic: 'image',
  txt: 'text', json: 'text', xml: 'text', html: 'document', yaml: 'text', sql: 'text',
  csv: 'table', xlsx: 'table', xls: 'table', ods: 'table', pdf: 'pdf',
  docx: 'document', doc: 'document', odt: 'document', rtf: 'document', md: 'document', eml: 'document', mbox: 'document', ics: 'document', msg: 'document', epub: 'document',
  pptx: 'slides', ppt: 'slides', odp: 'slides',
  zip: 'archive', tar: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive',
  audio: 'media', video: 'media',
  p7s: 'signature', p7m: 'signature',
  dwg: 'unknown', unknown: 'unknown',
};

/** Formats that are recognised but not rendered. */
const NOT_IMPLEMENTED = new Set<FileFormat>(['dwg', 'unknown']);

/** Formats that can be rendered. */
export const IMPLEMENTED_FORMATS: ReadonlySet<FileFormat> = new Set((Object.keys(KINDS) as FileFormat[]).filter((f) => !NOT_IMPLEMENTED.has(f)));

/** Text formats: plain text inside, they differ only by extension. */
const TEXT_FORMATS = new Set<FileFormat>(['txt', 'md', 'json', 'xml', 'html', 'yaml', 'sql', 'csv', 'eml', 'mbox', 'ics', 'svg']);

export function kindOf(format: FileFormat): FileKind {
  return KINDS[format] ?? 'unknown';
}

export function isImplemented(format: FileFormat): boolean {
  return IMPLEMENTED_FORMATS.has(format);
}

/** Format by file name or URL (by extension). */
export function formatFromName(name?: string): FileFormat {
  if (!name) return 'unknown';
  let path = name;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return 'unknown';
  return EXTENSIONS[path.slice(dot + 1).toLowerCase()] ?? 'unknown';
}

export function formatFromMime(mime?: string): FileFormat {
  if (!mime) return 'unknown';
  return MIME_TYPES[mime.split(';')[0].trim().toLowerCase()] ?? 'unknown';
}

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}
const ascii = (b: Uint8Array, offset: number, length: number) => String.fromCharCode(...b.subarray(offset, offset + length));

export type SniffResult = FileFormat | 'cfb' | 'text' | 'binary';

/** Detects the format from the first bytes of the file. */
export function sniffBytes(head: Uint8Array): SniffResult {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpg';
  if (ascii(head, 0, 4) === 'RIFF') {
    const type = ascii(head, 8, 4);
    if (type === 'WEBP') return 'webp';
    if (type === 'WAVE') return 'audio';
    if (type === 'AVI ') return 'video';
  }
  if (ascii(head, 0, 4) === 'GIF8') return 'gif';
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'cfb';
  if (startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf'; // {\rtf
  if (startsWith(head, [0x1f, 0x8b])) return 'gz';
  if (ascii(head, 0, 4) === 'Rar!') return 'rar';
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (ascii(head, 257, 5) === 'ustar') return 'tar';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video'; // webm, mkv
  if (ascii(head, 0, 4) === 'OggS' || ascii(head, 0, 4) === 'fLaC' || ascii(head, 0, 3) === 'ID3') return 'audio';
  // An MPEG frame starts with 0xFF 0xEx/0xFx. The pair FF FE is a UTF-16 mark, not audio.
  const isBom = startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff]);
  if (!isBom && head.length > 3 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0 && (head[2] & 0xf0) !== 0xf0) return 'audio';
  if (ascii(head, 4, 4) === 'ftyp') {
    // ISO BMFF family: mp4, mov, m4a, heic differ by "brand".
    const brand = ascii(head, 8, 4).toLowerCase();
    if (brand.startsWith('hei') || brand.startsWith('hev') || brand === 'mif1' || brand === 'msf1') return 'heic';
    if (brand.startsWith('m4a') || brand.startsWith('m4b')) return 'audio';
    return 'video';
  }
  if (ascii(head, 0, 2) === 'BM' && head.length > 14 && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) return 'bmp';
  if (/^AC10\d\d/.test(ascii(head, 0, 6))) return 'dwg';

  // %PDF- may not be at the very start: the specification allows junk in the first 1024 bytes.
  const limit = Math.min(head.length, 1024) - 4;
  for (let i = 0; i < limit; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return 'pdf';
  }

  // Text or binary: a UTF-16 BOM permits zero bytes, otherwise a zero means binary data.
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return 'text';
  const n = Math.min(head.length, 8192);
  let evenZero = 0;
  let oddZero = 0;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = head[i];
    if (c === 0) {
      if (i & 1) oddZero++;
      else evenZero++;
    } else if (c < 9 || (c > 13 && c < 32 && c !== 27)) {
      control++;
    }
  }
  if (evenZero + oddZero > 0) {
    // UTF-16 without a BOM: zeros come strictly every other byte, only at even or only at odd positions.
    const pairs = n >> 1;
    const oneSided = (evenZero === 0 && oddZero > pairs * 0.3) || (oddZero === 0 && evenZero > pairs * 0.3);
    return n >= 8 && oneSided && control === 0 ? 'text' : 'binary';
  }
  return control > n * 0.05 ? 'binary' : 'text';
}

/** A password-protected Office file (docx, xlsx, pptx): outside it is a CFB container with an EncryptedPackage stream. */
export class EncryptedFileError extends Error {
  constructor() {
    super('The file is password protected');
    this.name = 'EncryptedFileError';
  }
}

/** The extension promises one format while the content belongs to another. */
export class FormatMismatchError extends Error {
  constructor(readonly expected: FileFormat, readonly actual: FileFormat | 'text' | 'binary') {
    super(`The file content (${actual}) does not match the extension (${expected})`);
    this.name = 'FormatMismatchError';
  }
}

export interface DetectHints {
  name?: string;
  mimeType?: string;
  /** Reject files whose extension does not match the content. */
  strict?: boolean;
}

export interface DetectResult {
  format: FileFormat;
  /** The format promised by the extension, when the file was opened by content despite it. */
  expected?: FileFormat;
  /** The archive is truncated: there is no central directory; what survived was read. */
  damaged?: boolean;
  /** Zero-length file. */
  empty?: boolean;
}

/** Under an extension with a known signature lies data that resembles no format. */
export class CorruptFileError extends Error {
  constructor(readonly expected: FileFormat) {
    super('The file content is not data of the declared format');
    this.name = 'CorruptFileError';
  }
}

/** Detects the file format by content, name and MIME type. */
export async function detectFormat(blob: Blob, hints: DetectHints = {}): Promise<FileFormat> {
  return (await detectFile(blob, hints)).format;
}

/** Like detectFormat, but also reports that the file was opened despite its extension, is truncated or empty. */
export async function detectFile(blob: Blob, hints: DetectHints = {}): Promise<DetectResult> {
  const result: DetectResult = { format: 'unknown' };
  result.format = await detect(blob, hints, result);
  // Within one family (docx under .doc, jpg under .png) the mismatch is not worth the user's attention.
  if (result.expected && (result.expected === result.format || (kindOf(result.expected) === kindOf(result.format) && kindOf(result.format) !== 'unknown'))) delete result.expected;
  return result;
}

/** "Excel" exports from business systems: XML Spreadsheet 2003 or an HTML table named .xls. */
function sniffSpreadsheetText(start: string): 'xml' | 'html' | null {
  if (/<\?mso-application[^>]*Excel\.Sheet|<Workbook[^>]+urn:schemas-microsoft-com:office:spreadsheet/i.test(start)) return 'xml';
  if (/urn:schemas-microsoft-com:office:excel/i.test(start) || /<table[\s>]/i.test(start)) return 'html';
  return null;
}

async function detect(blob: Blob, hints: DetectHints, result: DetectResult): Promise<FileFormat> {
  const byName = formatFromName(hints.name);
  const byMime = formatFromMime(hints.mimeType || blob.type);
  const hint = byName !== 'unknown' ? byName : byMime;
  const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
  if (head.length === 0) {
    result.empty = true;
    return hint;
  }
  const sniffed = sniffBytes(head);
  // A mismatch is judged against the extension only: servers often set the MIME type at random.
  // In strict mode it is an error; otherwise the file opens by content and the mismatch is remembered.
  const fail = (actual: FileFormat | 'text' | 'binary'): FileFormat => {
    if (byName !== 'unknown' && byName !== actual) {
      if (hints.strict) throw new FormatMismatchError(byName, actual);
      result.expected = byName;
    }
    return actual === 'text' ? 'txt' : actual === 'binary' ? 'unknown' : actual;
  };

  // A CMS signature is checked first: the document embedded in it (a PDF, say) lies close to the start of the file,
  // and the search for its signature would otherwise fire earlier.
  if (looksLikeCms(head)) {
    if (hint === 'p7s' || hint === 'p7m') return hint;
    return hint === 'unknown' ? 'p7m' : fail('p7m');
  }

  if (sniffed === 'zip') {
    let detected: FileFormat = 'zip';
    try {
      const zip = await ZipReader.open(blob);
      if (zip.recovered) result.damaged = true;
      if (zip.has('word/document.xml')) detected = 'docx';
      else if (zip.has('xl/workbook.xml')) detected = 'xlsx';
      else if (zip.has('ppt/presentation.xml')) detected = 'pptx';
      else if (zip.has('mimetype')) {
        const inner = formatFromMime((await zip.readText('mimetype')).trim());
        if (inner !== 'unknown') detected = inner;
      }
    } catch {
      // Damaged archive: the name remains as a hint.
      return hint !== 'unknown' ? hint : 'zip';
    }
    // Any zip container may be opened as an archive if it is named so (.zip, .asice).
    if (hint === 'zip') return 'zip';
    return hint === detected || hint === 'unknown' ? detected : fail(detected);
  }

  if (sniffed === 'cfb') {
    // Legacy Office formats and Outlook messages share one container and differ by stream names.
    // Only the container root is examined: nested objects (an Excel workbook inside a Word document)
    // have their own streams with the same names.
    let names: string[] = [];
    try {
      const { CfbReader } = await import('./core/cfb');
      names = (await CfbReader.open(blob)).topNames();
    } catch {
      return hint === 'doc' || hint === 'xls' || hint === 'ppt' || hint === 'msg' ? hint : 'unknown';
    }
    if (names.includes('encryptedpackage')) throw new EncryptedFileError();
    let detected: FileFormat = 'unknown';
    if (names.includes('worddocument')) detected = 'doc';
    else if (names.includes('workbook') || names.includes('book')) detected = 'xls';
    else if (names.includes('powerpoint document')) detected = 'ppt';
    else if (names.some((n) => n.startsWith('__substg1.0_') || n === '__properties_version1.0')) detected = 'msg';
    if (detected === 'unknown') return hint === 'doc' || hint === 'xls' || hint === 'ppt' || hint === 'msg' ? hint : 'unknown';
    return hint === detected || hint === 'unknown' ? detected : fail(detected);
  }

  if (sniffed === 'text') {
    const start = new TextDecoder().decode(head).replace(/^﻿/, '').trimStart();
    const officeTable = hint === 'xls' || hint === 'xlsx' || hint === 'ods';
    const sheet = sniffSpreadsheetText(start);
    if (sheet === 'xml' && (officeTable || hint === 'xml' || hint === 'unknown')) return hint === 'xml' ? 'xml' : 'xls';
    if (sheet === 'html' && officeTable) return 'xls';
    if (TEXT_FORMATS.has(hint)) return hint;
    if (hint === 'unknown') {
      // Without a hint only SVG is recognised: it has to be shown as a picture, not as source.
      if (/^(<\?xml[^>]*\?>\s*)?(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(start)) return 'svg';
      return 'txt';
    }
    // A signature in text form (PEM).
    if ((hint === 'p7s' || hint === 'p7m') && /-----BEGIN (PKCS7|CMS)-----/.test(start.slice(0, 256))) return hint;
    // A Word document saved as a web page but named .doc.
    if ((hint === 'doc' || hint === 'docx') && /^(<!DOCTYPE html|<html[\s>])/i.test(start)) return fail('html');
    // Plain text under a foreign extension is harmless: show it as text and say so.
    if (byName !== 'unknown') result.expected = byName;
    return 'txt';
  }
  if (sniffed === 'binary') {
    if (hint === 'unknown') return 'unknown';
    if (hint === 'tar' || hint === 'audio' || hint === 'video') return hint;
    if (hints.strict) return fail('binary');
    // Data without a recognisable signature: under a text extension it is an unknown format, under others it is corruption.
    if (TEXT_FORMATS.has(hint)) return 'unknown';
    throw new CorruptFileError(hint);
  }

  // A signature of a specific format was found.
  if (hint === 'unknown' || hint === sniffed) return sniffed;
  // Audio and video in shared containers (mp4/m4a, ogg, webm) cannot be told apart by signature; trust the extension.
  if ((sniffed === 'audio' || sniffed === 'video') && (hint === 'audio' || hint === 'video')) return hint;
  return fail(sniffed);
}
