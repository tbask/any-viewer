import { describe, expect, it } from 'vitest';
import { detectFormat, formatFromMime, formatFromName, isImplemented, kindOf, sniffBytes } from '../src/detect';
import { getImageSize } from '../src/core/image-size';
import { bytes, makeZip } from './helpers';

const blob = (b: Uint8Array) => new Blob([b as BlobPart]);
const PNG_1x1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

describe('format detection', () => {
  it('by name and MIME type', () => {
    expect(formatFromName('Отчёт.DOCX')).toBe('docx');
    expect(formatFromName('https://host/path/file.jpeg?token=a.b#x')).toBe('jpg');
    expect(formatFromName('https://host.com/path/noext')).toBe('unknown');
    expect(formatFromName('archive.tar.gz')).toBe('gz');
    expect(formatFromName('файл.неизвестное')).toBe('unknown');
    expect(formatFromName('Макросы.XLSM')).toBe('xlsx');
    expect(formatFromName('шаблон.dotx')).toBe('docx');
    expect(formatFromMime('text/csv; charset=utf-8')).toBe('csv');
    expect(formatFromMime('application/pdf')).toBe('pdf');
  });

  it('by signature', () => {
    expect(sniffBytes(PNG_1x1)).toBe('png');
    expect(sniffBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBe('jpg');
    expect(sniffBytes(bytes('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('webp');
    expect(sniffBytes(bytes('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffBytes(bytes('мусор перед заголовком\n%PDF-1.4\n'))).toBe('pdf');
    expect(sniffBytes(bytes('{\\rtf1\\ansi'))).toBe('rtf');
    expect(sniffBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('cfb');
    expect(sniffBytes(bytes('обычный текст\nвторая строка'))).toBe('text');
    expect(sniffBytes(new Uint8Array([1, 2, 3, 0, 0, 0, 7, 8, 200, 0, 0]))).toBe('binary');
  });

  it('content outranks the extension', async () => {
    expect(await detectFormat(blob(PNG_1x1), { name: 'photo.txt' })).toBe('png');
    expect(await detectFormat(blob(bytes('%PDF-1.7')), { name: 'doc.docx' })).toBe('pdf');
  });

  it('text and csv are told apart by the hint', async () => {
    expect(await detectFormat(blob(bytes('a;b\n1;2')), { name: 'data.csv' })).toBe('csv');
    expect(await detectFormat(blob(bytes('a;b\n1;2')), { mimeType: 'text/csv' })).toBe('csv');
    expect(await detectFormat(blob(bytes('просто текст')), {})).toBe('txt');
    expect(await detectFormat(blob(bytes('просто текст')), { name: 'readme' })).toBe('txt');
  });

  it('office formats inside zip', async () => {
    const z = (name: string, data = '<x/>') => blob(makeZip([{ name, data: bytes(data) }]));
    expect(await detectFormat(z('word/document.xml'))).toBe('docx');
    expect(await detectFormat(z('word/document.xml'), { name: 'x.zip' })).toBe('zip'); // named as an archive: shown as an archive
    expect(await detectFormat(z('xl/workbook.xml'))).toBe('xlsx');
    expect(await detectFormat(z('ppt/presentation.xml'))).toBe('pptx');
    expect(await detectFormat(z('mimetype', 'application/vnd.oasis.opendocument.text'))).toBe('odt');
    expect(await detectFormat(z('mimetype', 'application/vnd.oasis.opendocument.spreadsheet'))).toBe('ods');
    expect(await detectFormat(z('mimetype', 'application/vnd.oasis.opendocument.presentation'))).toBe('odp');
    expect(await detectFormat(z('readme.txt'), { name: 'archive.zip' })).toBe('zip');
  });

  it('legacy Office formats are told apart by name', async () => {
    const cfb = blob(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    expect(await detectFormat(cfb, { name: 'a.doc' })).toBe('doc');
    expect(await detectFormat(cfb, { name: 'a.xls' })).toBe('xls');
    expect(await detectFormat(cfb, { name: 'a.bin' })).toBe('unknown');
  });

  it('binary junk and an empty file', async () => {
    expect(await detectFormat(blob(new Uint8Array([0, 1, 2, 3, 0, 0, 9, 9])), { name: 'x.bin' })).toBe('unknown');
    expect(await detectFormat(blob(new Uint8Array(0)), { name: 'empty.txt' })).toBe('txt');
  });

  it('families and readiness', () => {
    expect(kindOf('xlsx')).toBe('table');
    expect(kindOf('csv')).toBe('table');
    expect(kindOf('odp')).toBe('slides');
    expect(isImplemented('pdf')).toBe(true);
    expect(isImplemented('docx')).toBe(true);
    expect(isImplemented('unknown')).toBe(false);
  });
});

describe('image dimensions', () => {
  it('PNG', () => {
    expect(getImageSize(PNG_1x1)).toEqual({ width: 1, height: 1 });
  });
  it('JPEG with a segment before SOF', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 of length 4
      0xff, 0xc2, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x07, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(getImageSize(jpeg)).toEqual({ width: 1920, height: 1200 });
  });
  it('WebP: VP8X, VP8 and VP8L', () => {
    const base = (chunk: string) => {
      const b = new Uint8Array(32);
      b.set(bytes('RIFF'), 0);
      b.set(bytes('WEBP'), 8);
      b.set(bytes(chunk), 12);
      return b;
    };
    const x = base('VP8X');
    x.set([0xff, 0x03, 0x00], 24); // 1023 + 1
    x.set([0xff, 0x01, 0x00], 27); // 511 + 1
    expect(getImageSize(x)).toEqual({ width: 1024, height: 512 });
    const lossy = base('VP8 ');
    lossy.set([0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02], 23); // 800 x 600
    expect(getImageSize(lossy)).toEqual({ width: 800, height: 600 });
    const lossless = base('VP8L');
    const bits = (640 - 1) | ((480 - 1) << 14);
    lossless.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 20);
    expect(getImageSize(lossless)).toEqual({ width: 640, height: 480 });
  });
  it('unknown data', () => {
    expect(getImageSize(bytes('не картинка вовсе, а текст подлиннее'))).toBeNull();
  });
});
