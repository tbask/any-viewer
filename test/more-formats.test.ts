/** Templates and macro-enabled files, rar and 7z archives, digital signature, html. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFormat } from '../src/detect';
import { parseCms } from '../src/core/cms';
import { listRar } from '../src/core/rar';
import { list7z as list7zFull } from '../src/core/sevenzip';

/** A file list without content readers: convenient to compare as a whole. */
const list7z = (...args: Parameters<typeof list7zFull>) => list7zFull(...args).map(({ read: _read, ...rest }) => rest);
import type { Block, DocModel } from '../src/core/docmodel';
import { parseDocument, parseSlides, type DocFormat, type SlidesFormat } from '../src/formats/documents';
import { decodeHtml, parseHtml } from '../src/formats/html';
import { openWorkbook } from '../src/formats/tables';

const dir = join(__dirname, 'fixtures');
const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const blobOf = (name: string) => new Blob([read(name) as BlobPart]);
const text = (m: DocModel) => {
  const out: string[] = [];
  const walk = (b: Block): void => {
    if (b.k === 'p') out.push(((b.marker ? `${b.marker} ` : '') + b.runs.map((r) => (r.k === 'text' ? r.text : '')).join('')).trimEnd());
    else if (b.k === 'table') b.rows.forEach((r) => r.cells.forEach((c) => c.blocks.forEach(walk)));
  };
  m.blocks.forEach(walk);
  return out.filter((t) => t.trim());
};

describe('templates and macro-enabled files', () => {
  it('Word: dotx, docm, dot are read the same way as docx and doc', async () => {
    const reference = text(await parseDocument('docx', blobOf('doc.docx'), {}));
    expect(reference.length).toBeGreaterThan(5);
    for (const [file, format] of [['doc.dotx', 'docx'], ['doc.docm', 'docx'], ['doc.dot', 'doc']] as const) {
      const blob = blobOf(`variants/${file}`);
      expect(await detectFormat(blob, { name: file, strict: true }), file).toBe(format);
      const got = text(await parseDocument(format as DocFormat, blob, {}));
      expect(got.join('\n'), file).toContain(reference[0]);
      expect(got.length, file).toBeGreaterThanOrEqual(reference.length - 2);
    }
  });
  it('Excel: xlsm, xltx, xlt', async () => {
    for (const [file, format] of [['book.xlsm', 'xlsx'], ['book.xltx', 'xlsx'], ['book.xlt', 'xls']] as const) {
      const blob = blobOf(`variants/${file}`);
      expect(await detectFormat(blob, { name: file, strict: true }), file).toBe(format);
      const wb = await openWorkbook(format, blob, { maxRows: 1000, lang: 'ru-RU' });
      expect(wb.sheets.length, file).toBe(3);
      expect((await wb.openSheet(0)).meta.rowCount, file).toBeGreaterThan(20);
    }
  });
  it('PowerPoint: ppsx, pptm, potx, pps', async () => {
    for (const [file, format] of [['deck.ppsx', 'pptx'], ['deck.pptm', 'pptx'], ['deck.potx', 'pptx'], ['deck.pps', 'ppt']] as const) {
      const blob = blobOf(`variants/${file}`);
      expect(await detectFormat(blob, { name: file, strict: true }), file).toBe(format);
      const model = await parseSlides(format as SlidesFormat, blob);
      expect(model.slides.length, file).toBe(4);
    }
  });
});

describe('rar and 7z archives', () => {
  it('rar 5 and rar 3: names and sizes', () => {
    expect(listRar(read('ext/rar5-times.rar')).map(({ read: _read, ...rest }) => rest)).toEqual([{ name: 'stest1.txt', size: 2048, directory: false }]);
    expect(listRar(read('ext/rar5-hlink.rar')).map((e) => e.name)).toEqual(['stest1.txt', 'stest2.txt', 'stest3.txt']);
    expect(listRar(read('ext/rar3-comment-plain.rar')).map((e) => e.name)).toEqual(['file1.txt', 'file2.txt']);
  });
  it('rar: Unicode names', () => {
    expect(listRar(read('ext/unicode.rar')).map((e) => e.name)).toEqual(['уииоотивл.txt', '𝐀𝐁𝐁𝐂.txt']);
  });
  it('rar and 7z with an encrypted header report a password', () => {
    for (const f of ['ext/rar5-hpsw.rar', 'ext/rar3-comment-hpsw.rar']) expect(() => listRar(read(f)), f).toThrow(expect.objectContaining({ name: 'PasswordError' }));
    expect(() => list7z(read('ext/hpsw.7z'))).toThrow(expect.objectContaining({ name: 'PasswordError' }));
  });
  it('a stub with a rar or 7z signature is an error, not an empty list', () => {
    const enc = new TextEncoder();
    expect(() => listRar(enc.encode('Rar!\x1a\x07\x00RAR placeholder; not a valid RAR archive.\n'))).toThrow();
    expect(() => list7z(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, ...enc.encode('7Z test fixture placeholder.')]))).toThrow();
  });
  it('7z: folders, empty files, Russian names', () => {
    for (const f of ['ext/lzma2.7z', 'ext/lzma.7z']) {
      expect(list7z(read(f)), f).toEqual([
        { name: 's2', size: 0, directory: true },
        { name: 's2/readme.txt', size: 3000, directory: false },
        { name: 's2/папка', size: 0, directory: true },
        { name: 's2/папка/empty.txt', size: 0, directory: false },
        { name: 's2/папка/вложенная', size: 0, directory: true },
        { name: 's2/папка/отчёт за год.txt', size: 3900, directory: false },
      ]);
    }
  });
  it('7z: compressed header for 1500 files', () => {
    const list = list7z(read('ext/many.7z'));
    expect(list.length).toBe(1501);
    expect(list[1]).toEqual({ name: 'many/файл-0000.txt', size: 0, directory: false });
    // The size of file i equals the length of the number i repeated i % 50 times.
    expect(list[1500]).toEqual({ name: 'many/файл-1499.txt', size: 4 * 49, directory: false });
    expect(list[124]).toEqual({ name: 'many/файл-0123.txt', size: 3 * 23, directory: false });
  });
});

describe('CMS digital signature', () => {
  it('detached signature: the signer is present, the document is not', async () => {
    const info = parseCms(read('ext/signed.txt.p7s'));
    expect(info.content).toBeUndefined();
    expect(info.signers).toHaveLength(1);
    expect(info.signers[0]).toMatchObject({ name: 'Тестовый Подписант', organization: 'Test Org' });
    expect(info.signers[0].validTo).toMatch(/^\d\d\.\d\d\.\d{4} \d\d:\d\d UTC$/);
    expect(info.signingTime).toMatch(/^\d\d\.\d\d\.\d{4} \d\d:\d\d UTC$/);
    expect(await detectFormat(blobOf('ext/signed.txt.p7s'), { name: 'a.txt.p7s', strict: true })).toBe('p7s');
    expect(await detectFormat(blobOf('ext/signed.txt.p7s'), { name: 'a.sig', strict: true })).toBe('p7s');
  });
  it('attached signature: the document is extracted', async () => {
    const info = parseCms(read('ext/signed.txt.p7m'));
    expect(new TextDecoder().decode(info.content)).toBe('Подписанный документ: договор №42\n');
    const pdf = parseCms(read('ext/standard.pdf.p7m'));
    expect(new TextDecoder().decode(pdf.content!.subarray(0, 5))).toBe('%PDF-');
    // A PDF inside a signature must not override the detection of the signature itself.
    expect(await detectFormat(blobOf('ext/standard.pdf.p7m'), { name: 'standard.pdf.p7m', strict: true })).toBe('p7m');
    expect(await detectFormat(blobOf('ext/standard.pdf.p7m'), {})).toBe('p7m');
  });
  it('text form (PEM)', async () => {
    expect(new TextDecoder().decode(parseCms(read('ext/signed-pem.p7m')).content)).toContain('договор №42');
    expect(await detectFormat(blobOf('ext/signed-pem.p7m'), { name: 'a.p7m', strict: true })).toBe('p7m');
  });
  it('junk and a truncated file give an error', () => {
    expect(() => parseCms(new TextEncoder().encode('placeholder'))).toThrow();
    expect(() => parseCms(read('ext/signed.txt.p7m').subarray(0, 300))).toThrow();
  });
  it('the asice signature container opens as an archive', async () => {
    expect(await detectFormat(blobOf('ext/container.asice'), { name: 'a.asice', strict: true })).toBe('zip');
  });
});

describe('html', () => {
  it('markup becomes a document, scripts and styles are dropped', () => {
    const model = parseHtml(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Заголовок окна</title>
      <style>p { color: red }</style><script>alert('<p>нет</p>')</script></head>
      <body onload="evil()"><h1>Тест HTML</h1><p>Первый абзац с <b>жирным</b> &mdash; и <a href="https://example.com/x">ссылкой</a>
      <p>Второй абзац без закрывающего тега<ul><li>один<li>два</ul>
      <a href="javascript:alert(1)">опасная</a><img src="https://example.com/track.png"><iframe src="https://example.com"></iframe>
      <ol><li>первый</li><li>второй</li></ol></body></html>`);
    const lines = text(model);
    expect(lines).toEqual(['Тест HTML', 'Первый абзац с жирным — и ссылкой', 'Второй абзац без закрывающего тега', '• один', '• два', 'опасная', '1. первый', '2. второй']);
    const json = JSON.stringify(model);
    expect(json).not.toMatch(/alert|evil|color: red|javascript:|track\.png|iframe/);
    expect(json).toContain('https://example.com/x');
    expect(model.blocks[0]).toMatchObject({ k: 'p', s: { heading: 1 } });
    expect(Object.keys(model.images)).toHaveLength(0);
  });
  it('tables and preformatted text', () => {
    const model = parseHtml('<table><tr><th>Показатель<th>Значение<tr><td>Выручка<td colspan="2">100</table><pre>код\n  с отступом</pre>');
    const table = model.blocks[0];
    expect(table.k).toBe('table');
    if (table.k !== 'table') return;
    expect(table.rows.map((r) => r.cells.map((c) => text({ blocks: c.blocks, images: {} }).join(' ')))).toEqual([['Показатель', 'Значение'], ['Выручка', '100']]);
    expect(table.rows[1].cells[1].colSpan).toBe(2);
    const pre = model.blocks[1];
    expect(pre.k === 'p' && pre.runs.map((r) => (r.k === 'text' ? r.text : r.k))).toEqual(['код', 'br', '\u00a0\u00a0с\u00a0отступом']);
  });
  it('encoding from meta charset', () => {
    const head = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=koi8-r"></head><body><p>';
    const koi = new Uint8Array([...new TextEncoder().encode(head), 0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4, ...new TextEncoder().encode('</p></body></html>')]);
    expect(text(parseHtml(decodeHtml(koi)))).toEqual(['Привет']);
  });
  it('fragments and junk do not crash the parser', () => {
    expect(() => parseHtml('<p><b>не закрыт <i>совсем </p></div></span><<<>>> <a href=x>')).not.toThrow();
    expect(() => parseHtml('<div>'.repeat(5000) + 'глубоко')).not.toThrow();
    expect(text(parseHtml('просто текст без тегов'))).toEqual(['просто текст без тегов']);
  });
});
