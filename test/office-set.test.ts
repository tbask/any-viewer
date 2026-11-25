/**
 * Checks on files made by Microsoft Office itself (test/fixtures/office): opening by content,
 * passwords, truncated archives, hidden content, footnotes and headers/footers, "Excel" exports, number formats.
 */
import { describe, expect, it } from 'vitest';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CorruptFileError, detectFile, detectFormat, EncryptedFileError, FormatMismatchError } from '../src/detect';
import { AesDecryptor, Rc4, sha1, sha256, sha384, sha512 } from '../src/core/crypto';
import { createLocale, builtinFormat, formatValue } from '../src/core/numfmt';
import { decryptOoxml } from '../src/core/office-crypto';
import { ZipReader } from '../src/core/zip';
import { parseDocument, parseSlides, type DocFormat, type SlidesFormat } from '../src/formats/documents';
import { parseRtf } from '../src/formats/rtf';
import { openWorkbook } from '../src/formats/tables';
import type { TableFormat } from '../src/core/table-source';

const dir = join(__dirname, 'fixtures');
const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const blobOf = (name: string) => new Blob([read(name) as BlobPart]);
const options = { maxRows: 100_000, lang: 'en-US' };
const labels = { header: 'HEADER', footer: 'FOOTER', footnotes: 'FOOTNOTES', endnotes: 'ENDNOTES', comments: 'COMMENTS' };

/** All model text as one line: run texts and separator captions. */
function allText(value: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
      for (const [k, x] of Object.entries(v)) if (k !== 'images' && k !== 'href' && k !== 'id') walk(x);
    }
  };
  walk(value);
  return out.join('\n');
}
async function sheetText(format: TableFormat, blob: Blob): Promise<{ names: string[]; text: string; first: Awaited<ReturnType<Awaited<ReturnType<typeof openWorkbook>>['openSheet']>> }> {
  const wb = await openWorkbook(format, blob, options);
  const parts: string[] = [];
  for (let i = 0; i < wb.sheets.length; i++) {
    const sheet = await wb.openSheet(i);
    parts.push(allText(sheet.getRows(0, sheet.meta.rowCount).rows));
  }
  return { names: wb.sheets, text: parts.join('\n'), first: await wb.openSheet(0) };
}

describe('the format is detected by content', () => {
  it('a doc with an embedded Excel workbook stays a Word document', async () => {
    expect(await detectFormat(blobOf('office/word-features.doc'), { name: 'a.doc', strict: true })).toBe('doc');
    expect(await detectFormat(blobOf('office/word-features.doc'), {})).toBe('doc');
  });
  it('docx and rtf under .doc, jpg under .png open without a notice', async () => {
    expect(await detectFile(blobOf('doc.docx'), { name: 'a.doc' })).toEqual({ format: 'docx' });
    expect(await detectFile(blobOf('doc.rtf'), { name: 'a.doc' })).toEqual({ format: 'rtf' });
    expect(await detectFile(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])]), { name: 'a.png' })).toEqual({ format: 'jpg' });
  });
  it('another family opens with a notice; in strict mode it is an error', async () => {
    expect(await detectFile(blobOf('office/excel-features.xlsx'), { name: 'a.docx' })).toEqual({ format: 'xlsx', expected: 'docx' });
    await expect(detectFile(blobOf('office/excel-features.xlsx'), { name: 'a.docx', strict: true })).rejects.toThrow(FormatMismatchError);
    await expect(detectFile(blobOf('doc.docx'), { name: 'a.doc', strict: true })).rejects.toThrow(FormatMismatchError);
  });
  it('random bytes under .pdf are a corrupt file, an empty file is empty', async () => {
    const noise = new Uint8Array(4096).map((_, i) => (i * 197 + 13) % 251);
    await expect(detectFile(new Blob([noise]), { name: 'a.pdf' })).rejects.toThrow(CorruptFileError);
    expect(await detectFile(new Blob([]), { name: 'a.docx' })).toEqual({ format: 'docx', empty: true });
  });
  it('"Excel" exports: XML Spreadsheet 2003 and HTML table', async () => {
    expect(await detectFile(blobOf('office/excel-spreadsheetml-2003.xls'), { name: 'a.xls' })).toEqual({ format: 'xls' });
    expect(await detectFile(blobOf('office/excel-html-table.xls'), { name: 'a.xls' })).toEqual({ format: 'xls' });
    expect(await detectFile(blobOf('office/excel-spreadsheetml-2003.xls'), { name: 'a.xml' })).toEqual({ format: 'xml' });
  });
});

describe('exports under the .xls extension', () => {
  it('XML Spreadsheet 2003: sheet, dates, numbers', async () => {
    const { names, first } = await sheetText('xls', blobOf('office/excel-spreadsheetml-2003.xls'));
    expect(names).toEqual(['Выгрузка']);
    const rows = first.getRows(0, 3).rows;
    expect(rows[0]).toEqual(['[X92] Дата', 'Контрагент', 'Сумма', 'Назначение']);
    expect(rows[1]).toEqual(['11/05/2026', 'ТОО «Контрагент 1»', '1,500.25', 'Оплата по счёту № 1; НДС не облагается']);
    expect(first.meta.rowCount).toBe(21);
  });
  it('HTML table: sheet, number format from the cell style', async () => {
    const { names, first } = await sheetText('xls', blobOf('office/excel-html-table.xls'));
    expect(names).toEqual(['Выгрузка']);
    const rows = first.getRows(0, 2).rows;
    expect(rows[0]).toEqual(['[X93] Дата', 'Контрагент', 'Сумма']);
    expect(rows[1]).toEqual(['01.11.2026', 'ТОО «Контрагент 1»', '1,500.25']);
    expect(first.meta.rowCount).toBe(16);
  });
});

describe('truncated archive', () => {
  it('files before the cut are read, the rest are not', async () => {
    const full = read('office/excel-features.xlsx');
    const cut = full.subarray(0, Math.floor(full.length * 0.7));
    const zip = await ZipReader.open(cut);
    expect(zip.recovered).toBe(true);
    expect(zip.has('xl/workbook.xml')).toBe(true);
    expect((await ZipReader.open(full)).recovered).toBe(false);
    await expect(ZipReader.open(cut, { noRecovery: true })).rejects.toThrow();
    expect((await detectFile(new Blob([cut as BlobPart]), { name: 'a.xlsx' })).damaged).toBe(true);
    const wb = await openWorkbook('xlsx', new Blob([cut as BlobPart]), options);
    expect(wb.sheets.length).toBeGreaterThan(0);
  });
  it('a cut inside the very first file of the archive is an error', async () => {
    await expect(ZipReader.open(read('office/excel-features.xlsx').subarray(0, 200))).rejects.toThrow();
  });
});

describe('cryptography', () => {
  it('hashes match the reference implementation at lengths around block boundaries', () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 1000]) {
      const data = randomBytes(len);
      for (const [name, fn] of [['sha1', sha1], ['sha256', sha256], ['sha384', sha384], ['sha512', sha512]] as const) {
        expect(Buffer.from(fn(new Uint8Array(data))).toString('hex'), `${name}/${len}`).toBe(createHash(name).update(data).digest('hex'));
      }
    }
  });
  it('AES (CBC and ECB, 128/192/256-bit keys) and RC4', () => {
    for (const bytes of [16, 24, 32]) {
      const key = randomBytes(bytes);
      const iv = randomBytes(16);
      const data = randomBytes(160);
      const cbc = createCipheriv(`aes-${bytes * 8}-cbc`, key, iv).setAutoPadding(false);
      const ecb = createCipheriv(`aes-${bytes * 8}-ecb`, key, null).setAutoPadding(false);
      const aes = new AesDecryptor(new Uint8Array(key));
      expect(Buffer.from(aes.cbc(new Uint8Array(Buffer.concat([cbc.update(data), cbc.final()])), new Uint8Array(iv))).equals(data), `cbc ${bytes}`).toBe(true);
      expect(Buffer.from(aes.ecb(new Uint8Array(Buffer.concat([ecb.update(data), ecb.final()])))).equals(data), `ecb ${bytes}`).toBe(true);
    }
    const text = new Uint8Array(Buffer.from('Plaintext'));
    new Rc4(new Uint8Array(Buffer.from('Key'))).apply(text);
    expect(Buffer.from(text).toString('hex')).toBe('bbf316e8d940af0ad3');
  });
});

describe('password-protected files', () => {
  it('docx, xlsx, pptx are decrypted with the right password', async () => {
    for (const [file, inner] of [['word-password.docx', 'docx'], ['excel-password.xlsx', 'xlsx'], ['ppt-password.pptx', 'pptx']] as const) {
      const blob = blobOf(`office/${file}`);
      await expect(detectFormat(blob, { name: file }), file).rejects.toThrow(EncryptedFileError);
      const plain = new Blob([(await decryptOoxml(blob, 'test123')) as BlobPart]);
      expect(await detectFormat(plain, { name: file }), file).toBe(inner);
      await expect(decryptOoxml(blob, 'Test123'), file).rejects.toMatchObject({ name: 'WrongPasswordError' });
    }
    const doc = await parseDocument('docx', new Blob([(await decryptOoxml(blobOf('office/word-password.docx'), 'test123')) as BlobPart]), {});
    expect(allText(doc)).toContain('[W90]');
  }, 30_000);
  it('doc: no password asks, a wrong one is refused, the right one gives the text', async () => {
    const blob = blobOf('office/word-password.doc');
    await expect(parseDocument('doc', blob, {})).rejects.toMatchObject({ name: 'PasswordRequiredError' });
    await expect(parseDocument('doc', blob, { password: 'nope' })).rejects.toMatchObject({ name: 'WrongPasswordError' });
    expect(allText(await parseDocument('doc', blob, { password: 'test123' }))).toContain('[W90] Если этот текст виден без ввода пароля');
  });
});

describe('Word: hidden content is not shown, service parts are not lost', () => {
  for (const format of ['docx', 'doc', 'odt'] as const) {
    it(format, async () => {
      const text = allText(await parseDocument(format as DocFormat, blobOf(`office/word-features.${format}`), { labels }));
      // Hidden text and text deleted with change tracking are not visible in Word.
      expect(text).not.toContain('[W09]');
      expect(text).not.toContain('[W46]');
      expect(text).toContain('[W45]');
      for (const code of ['[W33]', '[W34]', '[W35]', '[W36]', '[W37]', '[W44]', '[W27]', '[W26-A]', '[W26-B]', '[W26-C]']) expect(text, code).toContain(code);
      // Order: header at the start, footnotes and footer at the end.
      expect(text.indexOf('[W34]')).toBeLessThan(text.indexOf('HEADER'));
      expect(text.indexOf('HEADER')).toBeLessThan(text.indexOf('[W01-H1]'));
      const order = ['FOOTNOTES', '[W36]', 'ENDNOTES', '[W37]', 'COMMENTS', '[W44]', 'FOOTER', '[W35]'].map((s) => text.lastIndexOf(s));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order[0]).toBeGreaterThan(text.indexOf('[W52]'));
      // A text box is output once, not in two variants (modern and for old versions).
      expect(text.split('[W27]').length - 1).toBe(1);
    });
  }
  it('rtf', () => {
    const rtf = String.raw`{\rtf1\ansi\titlepg{\fonttbl{\f0 Arial;}}{\headerf\pard First header\par}{\header\pard Main header\par}{\footer\pard Page footer\par}` +
      String.raw`\pard Visible {\v HIDDEN }text{\deleted  DELETED} kept{\super\chftn{\footnote\pard{\super\chftn} Note one\par}}` +
      String.raw` and{\super\chftn{\footnote\ftnalt\pard{\super\chftn} End note\par}}` +
      String.raw`{\*\atnid AB}{\*\atnauthor Reviewer}\chatn{\*\annotation\pard\chatn Comment text\par}` +
      String.raw`{\shp{\*\shpinst\shpleft0{\sp{\sn fHidden}{\sv 0}}{\shptxt\pard Box text\par}}{\shprslt\pard\par}}\par After\par}`;
    const model = parseRtf(new TextEncoder().encode(rtf), { labels });
    const text = allText(model);
    expect(text).not.toMatch(/HIDDEN|DELETED/);
    for (const part of ['First header', 'Main header', 'HEADER', 'Visible ', 'text', ' kept', 'Box text', 'After', 'FOOTNOTES', ' Note one', 'ENDNOTES', ' End note', 'COMMENTS', 'Comment text', '[1] Reviewer:', 'FOOTER', 'Page footer']) {
      expect(text, part).toContain(part);
    }
    expect(text.indexOf('Main header')).toBeLessThan(text.indexOf('Visible'));
    expect(text.indexOf('Box text')).toBeLessThan(text.indexOf('After'));
    expect(text.indexOf('Note one')).toBeGreaterThan(text.indexOf('After'));
    expect(model.blocks.some((b) => b.k === 'table')).toBe(true);
  });
});

describe('Excel: hidden rows, columns and sheets', () => {
  for (const format of ['xlsx', 'xls', 'ods'] as const) {
    it(format, async () => {
      const { names, text, first } = await sheetText(format, blobOf(`office/excel-features.${format}`));
      expect(names).toEqual(['Главная', 'Форматы', 'Формулы', 'Таблица', 'Сводная', 'Диаграммы', 'Қазақша', 'Защищённый']);
      for (const hidden of ['[X04-ROW]', '[X04-COL]', '[X05]', '[X02]', '[X03]']) expect(text, hidden).not.toContain(hidden);
      expect(text).toContain('Ниже свёрнутая группа строк 23–26');
      // Row numbers have gaps, as in Excel.
      const rowLabels = first.meta.rowLabels!;
      expect(rowLabels).toBeDefined();
      for (const row of [20, 23, 24, 25, 26]) expect(rowLabels, String(row)).not.toContain(row - 1);
      expect(rowLabels).toContain(21);
      expect(first.meta.colLabels).not.toContain(9);
      expect(first.meta.rowCount).toBe(rowLabels.length);
    });
  }
});

describe('PowerPoint: hidden slide', () => {
  for (const format of ['pptx', 'ppt', 'odp'] as const) {
    it(format, async () => {
      const model = await parseSlides(format as SlidesFormat, blobOf(`office/ppt-features.${format}`));
      const text = allText(model);
      expect(text).not.toContain('[P19]');
      expect(text).toContain('[P17]');
      expect(model.slides.length).toBe(17);
    });
  }
});

describe('number formats', () => {
  const en = createLocale('en-US');
  const ru = createLocale('ru-RU');
  it('fractions', () => {
    expect(formatValue(1.75, '# ?/?', en)).toBe('1 3/4');
    expect(formatValue(0.5, '# ?/?', en)).toBe('1/2');
    expect(formatValue(3, '# ?/?', en)).toBe('3');
    expect(formatValue(-2.25, '# ?/?', en)).toBe('-2 1/4');
    expect(formatValue(0.3333, '?/?', en)).toBe('1/3');
    expect(formatValue(2.375, '# ?/8', en)).toBe('2 3/8');
    expect(formatValue(0.999, '# ?/?', en)).toBe('1');
    expect(formatValue(1.75, builtinFormat(12)!, en)).toBe('1 3/4');
  });
  it('negatives in parentheses and the accounting format', () => {
    expect(formatValue(-2500.5, builtinFormat(40)!, en)).toBe('(2,500.50)');
    expect(formatValue(2500.5, builtinFormat(40)!, en).trim()).toBe('2,500.50');
    expect(formatValue(0, builtinFormat(44)!, en).trim()).toBe('-');
  });
  it('month-name language from the format code', () => {
    expect(formatValue(46350, '[$-419]d\\ mmmm\\ yyyy', en)).toBe('24 Ноябрь 2026');
    expect(formatValue(46350, '[$-409]mmmm d, yyyy', ru)).toBe('November 24, 2026');
    expect(formatValue(1234.5, '[$€-407] #,##0.00', en)).toBe('€ 1,234.50');
  });
  it('conditional sections', () => {
    expect(formatValue(3_500_000, '[>=1000000]#,##0.0,,\\ "млн";#,##0', en)).toBe('3.5 млн');
    expect(formatValue(3500, '[>=1000000]#,##0.0,,\\ "млн";#,##0', en)).toBe('3,500');
    expect(formatValue(500, '[Red][<=100]0;[Blue]0.00', en)).toBe('500.00');
  });
});
