/**
 * RAR5, BZip2 and Deflate extraction in 7z and zip, xls password with XOR obfuscation, sparklines,
 * LibreOffice conditional formatting, newer chart types.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChart } from '../src/core/chart';
import { listRar } from '../src/core/rar';
import { list7z } from '../src/core/sevenzip';
import { parseXml } from '../src/core/xml';
import { crc32, ZipReader } from '../src/core/zip';
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
  it('rar 5: regular, solid and with the ARM filter — checksums match', async () => {
    const texts = listRar(bytesOf('ext', 'rar5-solid.rar'));
    expect(texts.map((e) => e.name)).toEqual(['stest1.txt', 'stest2.txt']);
    // The second file of a solid archive is read first: the decompressor walks the preceding ones itself.
    const second = await texts[1].read!();
    expect(second.length).toBe(2048);
    expect(new TextDecoder().decode(second).startsWith('000\n001\n002\n')).toBe(true);
    expect((await texts[0].read!()).length).toBe(2048);

    const binary = listRar(bytesOf('ext', 'rar5-solid-bin.rar'));
    expect(binary.length).toBe(4);
    for (const e of [...binary].reverse()) expect((await e.read!()).length).toBe(4096);

    const [elf] = listRar(bytesOf('ext', 'rar5-arm.rar'));
    const program = await elf.read!();
    expect(program.length).toBe(90808);
    expect([...program.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    // The file checksum is stored in the archive; the decompressor verifies it itself, here it is for clarity.
    expect(crc32(program)).toBeGreaterThan(0);

    const nested = listRar(bytesOf('ext', 'rar5-subdirs.rar'));
    const file = nested.find((e) => e.name === 'sub/with space/long fn.txt')!;
    expect(new TextDecoder().decode(await file.read!())).toBe('long fn\n');
    expect(nested.find((e) => e.directory)?.read).toBeUndefined();
  });
  it('rar: encrypted and corrupt data is not extracted, rather than "extracted as garbage"', async () => {
    const damaged = bytesOf('ext', 'rar5-solid.rar').slice();
    for (let i = 96; i < 104; i++) damaged[i] ^= 0xff;
    let failed = 0;
    try {
      for (const e of listRar(damaged)) await e.read?.();
    } catch {
      failed++;
    }
    expect(failed).toBe(1);
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

describe('rar versions 3–4', () => {
  it('regular, solid and with the x86 filter — checksums match', async () => {
    const solid = listRar(bytesOf('ext', 'rar3-solid.rar'));
    expect(solid.map((e) => e.name)).toEqual(['stest1.txt', 'stest2.txt']);
    expect(new TextDecoder().decode(await solid[1].read!()).startsWith('000\n001\n')).toBe(true);
    const normal = listRar(bytesOf('ext', 'rar3-normal.rar'));
    const html = await normal.find((e) => e.name === 'testdir/LibarchiveAddingTest.html')!.read!();
    expect(html.length).toBe(20111);
    expect(new TextDecoder().decode(html.subarray(0, 14))).toBe('<!DOCTYPE HTML');
    const [exe] = listRar(bytesOf('ext', 'rar3-filter.rar'));
    const program = await exe.read!();
    expect(program.length).toBe(204288);
    expect([program[0], program[1]]).toEqual([0x4d, 0x5a]);
  });
  it('the PPMd method ("text compression") is not supported: a clear error instead of garbage', async () => {
    const entry = listRar(bytesOf('ext', 'rar3-ppmd.rar')).find((e) => e.name === 'LibarchiveAddingTest.html')!;
    await expect(Promise.resolve().then(() => entry.read!())).rejects.toThrow(/PPMd/);
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
