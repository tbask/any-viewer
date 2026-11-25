import { describe, expect, it } from 'vitest';
import { deflateSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFile, detectFormat, formatFromName, FormatMismatchError, sniffBytes } from '../src/detect';
import { parseMarkdown } from '../src/formats/markdown';
import { formatIcsDate, parseEml, parseIcs, parseMbox } from '../src/formats/mail';
import { gunzip, gzipOriginalName, listTar } from '../src/core/tar';
import { decodeTiff, TiffError } from '../src/core/tiff';
import type { Block, DocModel } from '../src/core/docmodel';
import { bytes, makeZip } from './helpers';

const blob = (b: Uint8Array | string) => new Blob([b as BlobPart]);
const flat = (m: DocModel) => {
  const out: string[] = [];
  const walk = (b: Block) => {
    if (b.k === 'p') out.push((b.marker ? `${b.marker} ` : '') + b.runs.map((r) => (r.k === 'text' ? r.text : r.k === 'br' ? '\n' : '')).join(''));
    else if (b.k === 'table') b.rows.forEach((r) => out.push(r.cells.map((c) => c.blocks.map((x) => (x.k === 'p' ? x.runs.map((y) => (y.k === 'text' ? y.text : '')).join('') : '')).join(' ')).join(' | ')));
  };
  m.blocks.forEach(walk);
  return out.filter(Boolean);
};

describe('strict extension check', () => {
  const strict = { strict: true };
  it('matching extension and content pass', async () => {
    expect(await detectFormat(blob('просто текст'), { name: 'a.txt', ...strict })).toBe('txt');
    expect(await detectFormat(blob('{"a":1}'), { name: 'a.json', ...strict })).toBe('json');
    expect(await detectFormat(blob('<svg xmlns="http://www.w3.org/2000/svg"/>'), { name: 'a.svg', ...strict })).toBe('svg');
    expect(await detectFormat(blob(makeZip([{ name: 'a.txt', data: bytes('x') }])), { name: 'a.zip', ...strict })).toBe('zip');
    expect(await detectFormat(blob(makeZip([{ name: 'word/document.xml', data: bytes('<x/>') }])), { name: 'макрос.docm', ...strict })).toBe('docx');
  });
  it('plain text under a foreign extension opens as text, with a notice', async () => {
    for (const name of ['a.docx', 'a.xlsm', 'a.pps', 'a.msg', 'a.rar', 'a.dwg', 'a.png', 'a.p7s']) {
      const found = await detectFile(blob('placeholder, not a real file'), { name, ...strict });
      expect(found.format, name).toBe('txt');
      expect(found.expected, name).toBe(formatFromName(name));
    }
    expect((await detectFile(blob('текст'), { name: 'a.txt', ...strict })).expected).toBeUndefined();
  });
  it('binary content under a foreign extension is rejected', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expect(detectFormat(blob(png), { name: 'a.txt', ...strict })).rejects.toThrow(FormatMismatchError);
    await expect(detectFormat(blob(png), { name: 'a.jpg', ...strict })).rejects.toThrow(FormatMismatchError);
    await expect(detectFormat(blob(makeZip([{ name: 'xl/workbook.xml', data: bytes('<x/>') }])), { name: 'a.docx', ...strict })).rejects.toThrow(FormatMismatchError);
    expect(await detectFormat(blob(png), { name: 'a.png', ...strict })).toBe('png');
  });
  it('without an extension the content decides; the MIME type is not treated as a mismatch', async () => {
    expect(await detectFormat(blob('текст'), { ...strict })).toBe('txt');
    expect(await detectFormat(blob('текст'), { mimeType: 'application/pdf', ...strict })).toBe('txt');
    expect(await detectFormat(blob('<?xml version="1.0"?>\n<svg width="1" height="1"></svg>'), strict)).toBe('svg');
  });
});

describe('signatures of the newer formats', () => {
  it('images, archives, audio and video', () => {
    expect(sniffBytes(bytes('GIF89a....'))).toBe('gif');
    expect(sniffBytes(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]))).toBe('tiff');
    expect(sniffBytes(new Uint8Array([0x42, 0x4d, 0x36, 0, 0x0c, 0, 0, 0, 0, 0, 0x36, 0, 0, 0, 0x28, 0, 0, 0]))).toBe('bmp');
    expect(sniffBytes(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe('gz');
    expect(sniffBytes(bytes('Rar!\x1a\x07\x00'))).toBe('rar');
    expect(sniffBytes(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
    expect(sniffBytes(bytes('\0\0\0\x18ftypheic\0\0\0\0'))).toBe('heic');
    expect(sniffBytes(bytes('\0\0\0\x18ftypisom\0\0\0\0'))).toBe('video');
    expect(sniffBytes(bytes('\0\0\0\x18ftypM4A \0\0\0\0'))).toBe('audio');
    expect(sniffBytes(bytes('RIFF\x10\0\0\0WAVEfmt '))).toBe('audio');
    expect(sniffBytes(bytes('RIFF\x10\0\0\0AVI LIST'))).toBe('video');
    expect(sniffBytes(bytes('OggS\0\x02'))).toBe('audio');
    expect(sniffBytes(bytes('ID3\x03\0\0'))).toBe('audio');
    expect(sniffBytes(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0]))).toBe('audio'); // MP3 frame without ID3
    expect(sniffBytes(new Uint8Array([0xff, 0xfe, 0x18, 0x04, 0x3c, 0x04, 0x4f, 0x04]))).toBe('text'); // UTF-16 with a BOM is not audio
  });
});

describe('markdown', () => {
  it('headings, emphasis, lists, code, tables', () => {
    const m = parseMarkdown('# Тест\n\n**Жирный**, *курсив*, `код` и [ссылка](https://example.com).\nпродолжение абзаца\n\n- Первый\n  - Вложенный\n1. Номер\n\n```\ncode line\n```\n\n| А | Б |\n|---|---|\n| 1 | 2 |\n');
    const [h, p, li1, li2, li3, code, table] = m.blocks as Extract<Block, { k: 'p' }>[];
    expect(h.s?.heading).toBe(1);
    expect(p.runs.map((r) => (r.k === 'text' ? [r.text, r.s?.b ?? r.s?.i ?? r.s?.mono ?? r.href ?? 0] : 0))).toEqual([
      ['Жирный', 1], [', ', 0], ['курсив', 1], [', ', 0], ['код', 1], [' и ', 0], ['ссылка', 'https://example.com'], ['. продолжение абзаца', 0],
    ]);
    expect([li1.marker, li1.level, li2.marker, li2.level, li3.marker]).toEqual(['•', 0, '•', 1, '1.']);
    expect(code.runs[0]).toMatchObject({ text: 'code line', s: { mono: 1 } });
    expect((table as unknown as Extract<Block, { k: 'table' }>).rows).toHaveLength(2);
  });
});

describe('mail and calendar', () => {
  const eml = [
    'From: =?utf-8?B?0JjQstCw0L0=?= <ivan@example.com>',
    'To: recipient@example.com',
    'Subject: =?windows-1251?Q?=CF=F0=E8=E2=E5=F2?=',
    'Date: Mon, 23 Nov 2026 10:00:00 +0500',
    'Content-Type: multipart/mixed; boundary="XX"',
    '',
    '--XX',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('Текст письма\nвторая строка').toString('base64'),
    '--XX',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0=',
    '--XX--',
    '',
  ].join('\r\n');
  it('eml: headers, base64 body, attachments', () => {
    const lines = flat(parseEml(bytes(eml)));
    expect(lines[0]).toBe('Привет');
    expect(lines).toContain('From | Иван <ivan@example.com>');
    expect(lines).toContain('Attachments | report.pdf');
    expect(lines.slice(-2)).toEqual(['Текст письма', 'вторая строка']);
  });
  it('eml: 8-bit headers and quoted-printable', () => {
    const raw = 'Subject: Тема письма\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82 =\r\nmir';
    const lines = flat(parseEml(bytes(raw)));
    expect(lines[0]).toBe('Тема письма');
    expect(lines[lines.length - 1]).toBe('Привет mir');
  });
  it('eml: HTML mail is shown as text without markup', () => {
    const lines = flat(parseEml(bytes('Subject: x\r\nContent-Type: text/html\r\n\r\n<html><script>alert(1)</script><p>Hello <b>world</b></p></html>')));
    expect(lines[lines.length - 1]).toBe('Hello world');
    expect(lines.join(' ')).not.toContain('alert');
  });
  it('mbox: several messages', () => {
    const m = parseMbox(bytes('From a@x Mon Nov 23 10:00:00 2026\nSubject: one\n\nfirst\n\nFrom b@x Mon Nov 23 11:00:00 2026\nSubject: two\n\nsecond\n'));
    expect(m.blocks.filter((b) => b.k === 'pagebreak')).toHaveLength(1);
    expect(flat(m)).toEqual(['one', 'first', 'two', 'second']);
  });
  it('ics: events and dates', () => {
    expect(formatIcsDate('20261123T100000Z')).toBe('23.11.2026 10:00 UTC');
    expect(formatIcsDate('20261123')).toBe('23.11.2026');
    const lines = flat(parseIcs(bytes('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Встреча\\, важная\r\nDTSTART;TZID=Asia/Almaty:20261123T100000\r\nDTEND;TZID=Asia/Almaty:20261123T110000\r\nLOCATION:Алма\r\n ты\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')));
    expect(lines[0]).toBe('Встреча, важная');
    expect(lines).toContain('Date | 23.11.2026 10:00 (Asia/Almaty) — 23.11.2026 11:00 (Asia/Almaty)');
    expect(lines).toContain('Location | Алматы');
    expect(() => parseIcs(bytes('BEGIN:VCALENDAR\r\nEND:VCALENDAR'))).toThrow();
  });
});

describe('archives', () => {
  it('tar and tar.gz made by a third-party program', async () => {
    const dir = join(__dirname, 'fixtures', 'ext'); // the archives were made with Python's tarfile module
    const tar = new Uint8Array(readFileSync(join(dir, 't.tar')));
    const entries = listTar(tar);
    expect(entries.map((e) => [e.name, e.size])).toEqual([['папка/файл.txt', 5], ['b.bin', 3000], ['очень-длинное-имя-'.repeat(8) + '.txt', 1]]);
    expect(listTar(new Uint8Array(readFileSync(join(dir, 'pax.tar')))).map((e) => e.name)).toEqual(entries.map((e) => e.name));
    const gz = new Uint8Array(gzipSync(tar));
    expect(listTar(await gunzip(blob(gz), 1e7))).toHaveLength(3);
    await expect(gunzip(blob(gz), 100)).rejects.toThrow();
    expect(gzipOriginalName(new Uint8Array([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3, 0x61, 0x2e, 0x74, 0x78, 0x74, 0, 1]))).toBe('a.txt');
  });
});

describe('TIFF', () => {
  // A 5×3 image: for every compression kind a TIFF is built by hand and the pixels are compared.
  const W = 5;
  const H = 3;
  const rgb = Uint8Array.from({ length: W * H * 3 }, (_, i) => (i * 37 + (i % 3) * 50) & 0xff);
  const build = (compression: number, data: Uint8Array, extra: [number, number][] = [], samples = 3, bits = 8, photometric = 2) => {
    const entries: [number, number, number][] = [
      [256, 4, W], [257, 4, H], [258, 3, bits], [259, 3, compression], [262, 3, photometric], [273, 4, 8 + 0], [277, 3, samples], [278, 4, H], [279, 4, data.length],
      ...extra.map(([t, v]) => [t, 3, v] as [number, number, number]),
    ];
    entries.sort((a, b) => a[0] - b[0]);
    const ifdOffset = 8 + data.length + (data.length & 1);
    const out = new Uint8Array(ifdOffset + 2 + entries.length * 12 + 4);
    const v = new DataView(out.buffer);
    out.set([0x49, 0x49, 0x2a, 0]);
    v.setUint32(4, ifdOffset, true);
    out.set(data, 8);
    v.setUint16(ifdOffset, entries.length, true);
    entries.forEach(([tag, type, value], i) => {
      const at = ifdOffset + 2 + i * 12;
      v.setUint16(at, tag, true);
      v.setUint16(at + 2, type, true);
      v.setUint32(at + 4, 1, true);
      if (type === 3) v.setUint16(at + 8, value, true);
      else v.setUint32(at + 8, value, true);
    });
    return out;
  };
  const pixels = (img: { rgba: Uint8ClampedArray }) => Array.from(img.rgba).filter((_, i) => i % 4 !== 3);

  it('no compression', () => {
    const img = decodeTiff(build(1, rgb));
    expect([img.width, img.height]).toEqual([W, H]);
    expect(pixels(img)).toEqual(Array.from(rgb));
    expect(img.rgba[3]).toBe(255);
  });
  it('Deflate and the horizontal predictor', () => {
    expect(pixels(decodeTiff(build(8, new Uint8Array(deflateSync(rgb)))))).toEqual(Array.from(rgb));
    const diff = rgb.slice();
    for (let y = 0; y < H; y++) for (let x = W * 3 - 1; x >= 3; x--) diff[y * W * 3 + x] = (diff[y * W * 3 + x] - diff[y * W * 3 + x - 3]) & 0xff;
    expect(pixels(decodeTiff(build(8, new Uint8Array(deflateSync(diff)), [[317, 2]])))).toEqual(Array.from(rgb));
  });
  it('PackBits', () => {
    const packed = new Uint8Array([rgb.length - 1, ...rgb]); // one "literal" run
    expect(pixels(decodeTiff(build(32773, packed)))).toEqual(Array.from(rgb));
    const run = new Uint8Array([(-(W * H * 3 - 1)) & 0xff, 77]); // a repeat of one byte
    expect(new Set(pixels(decodeTiff(build(32773, run))))).toEqual(new Set([77]));
  });
  it('greyscale and 1 bit', () => {
    const gray = Uint8Array.from({ length: W * H }, (_, i) => i * 17);
    expect(Array.from(decodeTiff(build(1, gray, [], 1, 8, 1)).rgba).filter((_, i) => i % 4 === 0)).toEqual(Array.from(gray));
    const bits = new Uint8Array([0b10100000, 0b01010000, 0b11111000]);
    const mono = decodeTiff(build(1, bits, [], 1, 1, 1));
    expect(Array.from(mono.rgba).filter((_, i) => i % 4 === 0).slice(0, 5)).toEqual([255, 0, 255, 0, 0]);
  });
  it('LZW and PIL reference files', () => {
    const dir = join(__dirname, 'fixtures', 'ext'); // the files and reference pixels were made with the Pillow library
    const ref = Array.from(readFileSync(join(dir, 'ref.rgb')));
    for (const name of ['raw', 'tiff_lzw', 'packbits', 'tiff_adobe_deflate']) {
      const img = decodeTiff(new Uint8Array(readFileSync(join(dir, `${name}.tiff`))));
      expect([img.width, img.height], name).toEqual([64, 48]);
      expect(pixels(img), name).toEqual(ref);
    }
    expect(pixels(decodeTiff(new Uint8Array(readFileSync(join(dir, 'palette.tiff')))))).toEqual(Array.from(readFileSync(join(dir, 'palette.rgb'))));
  });
  it('unsupported and corrupt', () => {
    expect(() => decodeTiff(bytes('не tiff вовсе'))).toThrow(TiffError);
    expect(() => decodeTiff(build(7, rgb))).toThrow(/JPEG/);
    expect(() => decodeTiff(build(1, rgb), 4)).toThrow(TiffError);
  });
});
