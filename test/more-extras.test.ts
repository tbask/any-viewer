/**
 * BZip2 and Deflate extraction in 7z and zip, RAR file lists, xls password with XOR obfuscation, sparklines,
 * LibreOffice conditional formatting, newer chart types.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChart } from '../src/core/chart';
import { listRar } from '../src/core/rar';
import { list7z } from '../src/core/sevenzip';
import { parseXml } from '../src/core/xml';
import { ZipReader } from '../src/core/zip';
import { openWorkbook } from '../src/formats/tables';
import { sparkSvg } from '../src/renderers/grid';

const fixtures = join(__dirname, 'fixtures');
const bytesOf = (...path: string[]) => new Uint8Array(readFileSync(join(fixtures, ...path)));
const blobOf = (...path: string[]) => new Blob([bytesOf(...path) as BlobPart]);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const options = { maxRows: 100_000, lang: 'en-US' };

describe('archive extraction', () => {
  const docx = bytesOf('doc-lo.docx');
  const xlsx = bytesOf('formula-rules.xlsx');
  it('7z: BZip2 and Deflate', async () => {
    for (const name of ['pack-bzip2.7z', 'pack-deflate.7z']) {
      const entries = new Map(list7z(bytesOf('ext', name)).map((e) => [e.name, e]));
      expect(same(await entries.get('docs/report.docx')!.read!(), docx), name).toBe(true);
      expect(same(await entries.get('docs/rules.xlsx')!.read!(), xlsx), name).toBe(true);
      expect(new TextDecoder().decode(await entries.get('readme.txt')!.read!()), name).toBe('Привет из архива\n');
    }
  });
  it('zip: BZip2 and LZMA', async () => {
    for (const name of ['pack-bzip2.zip', 'pack-lzma.zip']) {
      const zip = await ZipReader.open(blobOf('ext', name));
      expect(same(await zip.read('docs/report.docx'), docx), name).toBe(true);
      expect(same(await zip.read('docs/rules.xlsx'), xlsx), name).toBe(true);
    }
  });
  it('rar: files stored without compression are extracted', async () => {
    const nested = listRar(bytesOf('ext', 'rar5-subdirs.rar'));
    const file = nested.find((e) => e.name === 'sub/with space/long fn.txt')!;
    expect(new TextDecoder().decode(await file.read!())).toBe('long fn\n');
    expect(nested.find((e) => e.directory)?.read).toBeUndefined();
    // RAR 3–4: a stored file next to compressed ones.
    const old = listRar(bytesOf('ext', 'rar3-normal.rar'));
    expect((await old.find((e) => e.name === 'testlink')!.read!()).length).toBe(25);
  });
  it('rar: compressed files are listed with their sizes and are not decompressed', async () => {
    const texts = listRar(bytesOf('ext', 'rar5-solid.rar'));
    expect(texts.map((e) => [e.name, e.size])).toEqual([['stest1.txt', 2048], ['stest2.txt', 2048]]);
    for (const e of texts) await expect(Promise.resolve().then(() => e.read!())).rejects.toThrow(/cannot be extracted/);
    const html = listRar(bytesOf('ext', 'rar3-normal.rar')).find((e) => e.name === 'testdir/LibarchiveAddingTest.html')!;
    expect(html.size).toBe(20111);
    await expect(Promise.resolve().then(() => html.read!())).rejects.toThrow(/cannot be extracted/);
  });
});

describe('xls: password with XOR obfuscation', () => {
  it('password check and decryption', async () => {
    const plain = await openWorkbook('xls', blobOf('office', 'excel-features.xls'), options);
    const name = async (run: () => Promise<unknown>) => run().then(() => 'ok', (e: Error) => e.name);
    expect(await name(() => openWorkbook('xls', blobOf('crypto', 'xor-password.xls'), options))).toBe('PasswordRequiredError');
    expect(await name(() => openWorkbook('xls', blobOf('crypto', 'xor-password.xls'), { ...options, password: 'nope' }))).toBe('WrongPasswordError');
    const wb = await openWorkbook('xls', blobOf('crypto', 'xor-password.xls'), { ...options, password: 'test123' });
    expect(wb.sheets).toEqual(plain.sheets);
    for (const i of [0, 2, 5]) expect((await wb.openSheet(i)).getRows(0, 20).rows).toEqual((await plain.openSheet(i)).getRows(0, 20).rows);
  });
});

describe('sparklines', () => {
  it('xlsx: line, columns with negative values, data from another sheet', async () => {
    const wb = await openWorkbook('xlsx', blobOf('sparklines.xlsx'), options);
    const sheet = await wb.openSheet(0);
    const block = sheet.getRows(0, 4);
    const spark = (row: number) => sheet.meta.styles?.[block.styles?.[row]?.[6] ?? 0]?.spark;
    expect(spark(1)).toEqual({ kind: 'line', values: [1, 3, 2, 6, 9], color: '#376092' });
    expect(spark(2)).toEqual({ kind: 'column', values: [5, -2, 4, -6, 1], color: '#70ad47', negative: '#d00000' });
    expect(spark(3)?.values).toEqual([10, 20, 15, 30, 5]);
    expect(spark(0)).toBeUndefined();
  });
  it('sparkline picture', () => {
    const line = sparkSvg({ kind: 'line', values: [1, null, 3, 2], color: '#112233' });
    expect(() => parseXml(line)).not.toThrow();
    expect(line).toContain('stroke="#112233"');
    expect(line.match(/M/g)?.length).toBe(2); // a gap breaks the line
    const columns = sparkSvg({ kind: 'column', values: [5, -2, 0], color: '#00aa00', negative: '#cc0000' });
    expect(columns.match(/<rect/g)?.length).toBe(2);
    expect(columns).toContain('fill="#cc0000"');
  });
});

describe('ods from LibreOffice: conditional formatting', () => {
  it('scale, data bar, icons and value rule — as in the source xlsx', async () => {
    const looks = async (format: 'ods' | 'xlsx', file: string) => {
      const wb = await openWorkbook(format, blobOf('office', file), options);
      const sheet = await wb.openSheet(0);
      const block = sheet.getRows(12, 16);
      const out: string[] = [];
      block.rows.forEach((row, r) => row?.forEach((_, c) => {
        const st = sheet.meta.styles?.[block.styles?.[r]?.[c] ?? 0];
        if (c >= 2 && c <= 7 && st) out.push(`${r}:${c}:${r === 0 || r === 3 ? st.fill ?? '' : ''}:${st.bar ? st.bar.part.toFixed(2) : ''}:${st.icon ? st.icon.char : ''}`);
      }));
      return out;
    };
    expect(await looks('ods', 'excel-features-lo.ods')).toEqual(await looks('xlsx', 'excel-features.xlsx'));
  });
  it('formula rules', async () => {
    const wb = await openWorkbook('ods', blobOf('formula-rules-lo.ods'), options);
    const sheet = await wb.openSheet(0);
    const block = sheet.getRows(0, 11);
    const filled = (col: number) => block.rows.map((_, i) => (sheet.meta.styles?.[block.styles?.[i]?.[col] ?? 0]?.fill ? i + 1 : 0)).filter(Boolean);
    expect(filled(0)).toEqual([2, 5, 8, 11]);
    expect(filled(4)).toEqual([2, 4, 6, 8, 10]);
    expect(filled(5)).toEqual([4, 7, 9]);
    expect(filled(6)).toEqual([2, 3, 4, 9]);
    expect(filled(7)).toEqual([]);
  });
});

describe('newer chart types (chartex)', () => {
  const chartEx = (layout: string, data: string) => parseXml(`<cx:chartSpace xmlns:cx="cx"><cx:chartData><cx:data id="0">${data}</cx:data></cx:chartData>
    <cx:chart><cx:title><cx:tx><cx:txData><cx:v>Заголовок</cx:v></cx:txData></cx:tx></cx:title><cx:plotArea><cx:plotAreaRegion>
    <cx:series layoutId="${layout}"><cx:tx><cx:txData><cx:v>Ряд</cx:v></cx:txData></cx:tx><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`);
  const cats = '<cx:strDim type="cat"><cx:lvl ptCount="3"><cx:pt idx="0">Старт</cx:pt><cx:pt idx="1">Рост</cx:pt><cx:pt idx="2">Спад</cx:pt></cx:lvl></cx:strDim>';
  const vals = '<cx:numDim type="val"><cx:lvl ptCount="3"><cx:pt idx="0">100</cx:pt><cx:pt idx="1">40</cx:pt><cx:pt idx="2">-25</cx:pt></cx:lvl></cx:numDim>';
  it('waterfall, funnel, treemap, histogram', () => {
    const waterfall = parseChart(chartEx('waterfall', cats + vals))!;
    expect(waterfall.title).toBe('Заголовок');
    expect(waterfall.categories).toEqual(['Старт', 'Рост', 'Спад']);
    expect(waterfall.series).toMatchObject([{ kind: 'bar', name: 'Ряд', values: [100, 40, -25] }]);
    expect(parseChart(chartEx('funnel', cats + vals))!.horizontal).toBe(true);
    expect(parseChart(chartEx('treemap', cats + vals.replace('type="val"', 'type="size"')))!.series[0].kind).toBe('pie');
    const numbers = [1, 2, 2, 3, 3, 3, 4, 4, 9].map((v, i) => `<cx:pt idx="${i}">${v}</cx:pt>`).join('');
    const histogram = parseChart(chartEx('clusteredColumn', `<cx:numDim type="val"><cx:lvl>${numbers}</cx:lvl></cx:numDim>`))!;
    expect(histogram.series[0].values.reduce<number>((a, b) => a + (b ?? 0), 0)).toBe(9);
    expect(histogram.categories.length).toBe(histogram.series[0].values.length);
    expect(parseChart(chartEx('boxWhisker', cats + vals))).toBeUndefined();
  });
});

describe('xls: formula rules', () => {
  it('formulas from the binary form are evaluated the same way as in xlsx', async () => {
    const wb = await openWorkbook('xls', blobOf('formula-rules-lo.xls'), options);
    const sheet = await wb.openSheet(0);
    const block = sheet.getRows(0, 11);
    const filled = (col: number) => block.rows.map((_, i) => (sheet.meta.styles?.[block.styles?.[i]?.[col] ?? 0]?.fill ? i + 1 : 0)).filter(Boolean);
    expect(filled(0)).toEqual([2, 5, 8, 11]);
    expect(filled(4)).toEqual([2, 4, 6, 8, 10]);
    expect(filled(5)).toEqual([4, 7, 9]);
    expect(filled(6)).toEqual([2, 3, 4, 9]);
  });
});
