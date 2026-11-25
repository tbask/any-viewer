/**
 * Extraction of files from archives (zip, tar.gz, 7z, stored rar) and the conditional formatting formula evaluator.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateFormula, formulaIsTrue, parseFormula, type FormulaValue } from '../src/core/formula';
import { listRar } from '../src/core/rar';
import { list7z } from '../src/core/sevenzip';
import { gunzip, listTar } from '../src/core/tar';
import { ZipReader } from '../src/core/zip';
import { parseDocument } from '../src/formats/documents';
import { openWorkbook } from '../src/formats/tables';

const fixtures = join(__dirname, 'fixtures');
const bytesOf = (...path: string[]) => new Uint8Array(readFileSync(join(fixtures, ...path)));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('files from an archive', () => {
  const original = { docx: bytesOf('doc-lo.docx'), xlsx: bytesOf('formula-rules.xlsx') };
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  it('7z (LZMA2 with the x86 filter, one solid block): files match the originals byte for byte', async () => {
    const entries = list7z(bytesOf('ext', 'pack.7z'));
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('docs')?.read).toBeUndefined();
    expect(text(await byName.get('readme.txt')!.read!())).toBe('Привет из архива\n');
    expect(same(await byName.get('docs/report.docx')!.read!(), original.docx)).toBe(true);
    expect(same(await byName.get('docs/rules.xlsx')!.read!(), original.xlsx)).toBe(true);
    expect((await byName.get('docs/data.bin')!.read!()).length).toBe(3000);
  });
  it('tar.gz and zip', async () => {
    const tar = listTar(await gunzip(new Blob([bytesOf('ext', 'pack.tar.gz') as BlobPart]), 1 << 26));
    const find = (name: string) => tar.find((e) => e.name.replace(/^\.\//, '') === name)!;
    expect(text(await find('readme.txt').read!())).toBe('Привет из архива\n');
    expect(same(await find('docs/report.docx').read!(), original.docx)).toBe(true);
    expect(tar.find((e) => e.directory)?.read).toBeUndefined();
    const zip = await ZipReader.open(new Blob([bytesOf('ext', 'pack.zip') as BlobPart]));
    expect(same(await zip.read('docs/rules.xlsx'), original.xlsx)).toBe(true);
  });
  it('an extracted file opens with the regular parser', async () => {
    const entry = list7z(bytesOf('ext', 'pack.7z')).find((e) => e.name === 'docs/report.docx')!;
    const model = await parseDocument('docx', new Blob([(await entry.read!()).slice() as BlobPart]), {});
    expect(model.blocks.length).toBeGreaterThan(5);
  });
  it('rar: a list with non-Latin names is read; the files of this archive are compressed and give a clear error', async () => {
    const entries = listRar(bytesOf('ext', 'unicode.rar'));
    expect(entries.map((e) => e.name)).toEqual(['уииоотивл.txt', '𝐀𝐁𝐁𝐂.txt']);
    for (const e of entries) await expect(Promise.resolve().then(() => e.read!())).rejects.toThrow(/cannot be extracted/);
  });
});

describe('conditional formatting formulas', () => {
  const grid: FormulaValue[][] = [
    ['Код', 'Признак', 'Сумма'],
    ['A1', 'да', 120],
    ['A2', 'нет', 40],
    ['A1', 'да', 30],
    [null, '', 0],
  ];
  const ctx = (row: number, col: number, dRow = 0, dCol = 0) => ({ cell: (r: number, c: number) => grid[r]?.[c] ?? null, row, col, dRow, dCol });
  const calc = (formula: string, row = 1, col = 0, dRow = 0) => evaluateFormula(parseFormula(formula)!, ctx(row, col, dRow));
  it('arithmetic, comparisons, strings', () => {
    expect(calc('1+2*3')).toBe(7);
    expect(calc('(1+2)*3^2')).toBe(27);
    expect(calc('-C2/4')).toBe(-30);
    expect(calc('50%')).toBe(0.5);
    expect(calc('"а"&"б"&1')).toBe('аб1');
    expect(calc('B2="ДА"')).toBe(true);
    expect(calc('C2>=120')).toBe(true);
    expect(calc('C2<>C3')).toBe(true);
    expect(calc('A5=""')).toBe(true);
    expect(calc('1/0')).toBeNull();
  });
  it('references: relative ones shift, absolute ones do not', () => {
    expect(calc('$C2', 2, 0, 1)).toBe(40);
    expect(calc('$C$2', 2, 0, 1)).toBe(120);
    expect(calc('SUM($C$2:$C$4)')).toBe(190);
    expect(calc('ROW()', 3)).toBe(4);
    expect(calc('COLUMN(C1)')).toBe(3);
  });
  it('functions', () => {
    expect(calc('AND(B2="да",C2>100)')).toBe(true);
    expect(calc('OR(B2="нет",C2>1000)')).toBe(false);
    expect(calc('IF(C2>100,"много","мало")')).toBe('много');
    expect(calc('MOD(ROW(),2)=0', 1)).toBe(true);
    expect(calc('COUNTIF($A$2:$A$4,$A2)')).toBe(2);
    expect(calc('COUNTIF(C2:C4,">35")')).toBe(2);
    expect(calc('SUMIF(B2:B4,"да",C2:C4)')).toBe(150);
    expect(calc('AVERAGE(C2:C4)')).toBeCloseTo(63.333, 2);
    expect(calc('MAX(C2:C4)-MIN(C2:C4)')).toBe(90);
    expect(calc('LEN(A2)&LEFT(B3,2)&UPPER(RIGHT(A2,1))')).toBe('2не1');
    expect(calc('ISBLANK(A5)')).toBe(true);
    expect(calc('ISNUMBER(C2)')).toBe(true);
    expect(calc('NOT(ISTEXT(C2))')).toBe(true);
    expect(calc('IFERROR(1/0,"ошибка")')).toBe('ошибка');
    expect(calc('YEAR(DATE(2026,11,24))&"-"&MONTH(46350)&"-"&WEEKDAY(DATE(2026,11,24),2)')).toBe('2026-11-2');
    expect(calc('SEARCH("д",B2)')).toBe(1);
  });
  it('what cannot be evaluated does not count as satisfied', () => {
    expect(parseFormula('Другой!A1>0')).toBeNull();
    expect(parseFormula('ИмяДиапазона>0')).toBeNull();
    expect(parseFormula('1+')).toBeNull();
    expect(formulaIsTrue(parseFormula('НЕИЗВЕСТНАЯ(1)')!, ctx(1, 0))).toBe(false);
    expect(formulaIsTrue(parseFormula('"текст"')!, ctx(1, 0))).toBe(false);
  });
  it('xlsx: formula rules colour the right rows', async () => {
    const wb = await openWorkbook('xlsx', new Blob([bytesOf('formula-rules.xlsx') as BlobPart]), { maxRows: 1000, lang: 'en-US' });
    const sheet = await wb.openSheet(0);
    const block = sheet.getRows(0, 11);
    const filled = (col: number) => block.rows.map((_, i) => (sheet.meta.styles?.[block.styles?.[i]?.[col] ?? 0]?.fill ? i + 1 : 0)).filter(Boolean);
    expect(filled(0)).toEqual([2, 5, 8, 11]); // $C2>100 — for the whole row
    expect(filled(2)).toEqual([2, 5, 8, 11]);
    expect(filled(4)).toEqual([2, 4, 6, 8, 10]); // MOD(ROW(),2)=0
    expect(filled(5)).toEqual([4, 7, 9]); // AND($B2="да",$C2<50)
    expect(filled(6)).toEqual([2, 3, 4, 9]); // COUNTIF($A$2:$A$11,$A2)>1
    expect(filled(7)).toEqual([]); // a reference to another sheet: the rule is skipped
  });
});
