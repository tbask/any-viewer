import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openWorkbook } from '../src/formats/tables';
import { detectFormat, EncryptedFileError } from '../src/detect';
import { CfbReader, CfbError } from '../src/core/cfb';
import { applyTint } from '../src/formats/xlsx';
import { lengthToChars } from '../src/formats/ods';
import { parseCellRef, parseRangeRef } from '../src/core/workbook';

const fixture = (name: string) => new Blob([readFileSync(join(__dirname, 'fixtures', name)) as BlobPart]);
const options = { maxRows: 500_000, lang: 'ru-RU' };
const row = (rows: (string[] | undefined)[], r: number) => Array.from(rows[r] ?? [], (x) => x ?? '');

// The same document in three formats: xlsx and xls store numbers and format codes,
// ods stores ready text (in the locale of the program that saved the file).
describe.each([
  ['xlsx', 'book-lo.xlsx', { thousands: '1 234,50', sum: '3 543 015,00 ₸', share: '0,5%', neg: '(42,50)', bool: 'ИСТИНА', small: '0,000012345' }],
  ['xls', 'book.xls', { thousands: '1 234,50', sum: '3 543 015,00 ₸', share: '0,5%', neg: '(42,50)', bool: 'ИСТИНА', small: '0,000012345' }],
  ['ods', 'book.ods', { thousands: '1,234.50', sum: '3,543,015.00 ₸', share: '0.5%', neg: '(42.50)', bool: 'TRUE', small: '0.000012345' }],
] as const)('книга в формате %s', (format, file, expected) => {
  it('sheets: a hidden one is not shown', async () => {
    const wb = await openWorkbook(format, fixture(file), options);
    expect(wb.sheets).toEqual(['Продажи', 'Справочник', 'Пустой']);
  });

  it('values, number and date formats', async () => {
    const wb = await openWorkbook(format, fixture(file), options);
    const sheet = await wb.openSheet(0);
    const { rows } = sheet.getRows(0, 30);
    expect(row(rows, 0)).toEqual(['Отчёт о продажах за ноябрь']);
    expect(row(rows, 1)).toEqual(['Товар', 'Дата', 'Цена', 'Кол-во', 'Сумма', 'Доля']);
    expect(row(rows, 2)).toEqual(['Товар №1', '01.11.2025', expected.thousands, '1', `${expected.thousands} ₸`, expected.share]);
    expect(row(rows, 22)[0]).toBe('Итого');
    expect(row(rows, 22)[4]).toBe(expected.sum);
    expect(row(rows, 23)).toEqual(['Многострочный\nтекст', expected.bool, expected.neg, '25.11.2025 14:30', expected.small, '12345678901234']);
    expect(row(rows, 25)[0]).toBe('Блок 2×2');
  });

  it('merged cells and styles', async () => {
    const wb = await openWorkbook(format, fixture(file), options);
    const { meta, getRows } = await wb.openSheet(0);
    expect(meta.columnCount).toBe(6);
    expect(meta.merges!.map((m) => [m.r0, m.c0, m.r1, m.c1])).toEqual([[0, 0, 0, 5], [25, 0, 26, 1]]);
    const { styles } = getRows(0, 30);
    const style = (r: number, c: number) => meta.styles![styles![r]![c]];
    expect(style(0, 0)).toMatchObject({ bold: true, align: 'center' });
    expect(style(1, 3)).toMatchObject({ bold: true, color: '#ffffff', fill: '#1f4e79' });
    expect(style(22, 0)).toMatchObject({ bold: true, italic: true });
    expect(style(25, 0)).toMatchObject({ fill: '#fff2cc' });
    expect(meta.columnWidths[0]).toBeGreaterThan(25); // the width of column A is given in the file
  });

  it('second sheet of 1500 rows and an empty sheet', async () => {
    const wb = await openWorkbook(format, fixture(file), options);
    const big = await wb.openSheet(1);
    expect(big.meta.rowCount).toBe(1500);
    expect(row(big.getRows(1499, 1500).rows, 0)[1]).toBe('Запись 1500');
    expect(row(big.getRows(1499, 1500).rows, 0)[3]).toBe('код-01500');
    const empty = await wb.openSheet(2);
    expect(empty.meta.rowCount).toBe(0);
  });

  it('row limit', async () => {
    const wb = await openWorkbook(format, fixture(file), { ...options, maxRows: 100 });
    const big = await wb.openSheet(1);
    expect(big.meta.rowCount).toBe(100);
    expect(big.meta.truncated).toBe(true);
  });

  it('the format is detected by content, without an extension', async () => {
    expect(await detectFormat(fixture(file), { name: 'файл-без-расширения' })).toBe(format);
  });
});

describe('xlsx: special cases', () => {
  it('formulas without a cached result give an empty cell, the rest is read', async () => {
    const wb = await openWorkbook('xlsx', fixture('book.xlsx'), options);
    const { rows } = (await wb.openSheet(0)).getRows(0, 5);
    expect(row(rows, 2).slice(0, 4)).toEqual(['Товар №1', '01.11.2025', '1 234,50', '1']);
    expect(row(rows, 2)[4] ?? '').toBe('');
  });
  it('an encrypted workbook is recognised as password protected', async () => {
    await expect(detectFormat(fixture('locked.xlsx'), { name: 'locked.xlsx' })).rejects.toThrow(EncryptedFileError);
  });
  it('a non-archive is rejected', async () => {
    await expect(openWorkbook('xlsx', new Blob(['это не книга']), options)).rejects.toThrow();
    await expect(openWorkbook('ods', new Blob(['это не книга']), options)).rejects.toThrow();
    await expect(openWorkbook('xls', new Blob(['это не книга']), options)).rejects.toThrow();
  });
  it('theme colour shades', () => {
    expect(applyTint('#4472c4', 0)).toBe('#4472c4');
    expect(applyTint('#000000', 0.5)).toBe('#808080');
    expect(applyTint('#ffffff', -0.5)).toBe('#808080');
  });
});

describe('helper functions', () => {
  it('cell references', () => {
    expect(parseCellRef('A1')).toEqual({ row: 0, col: 0 });
    expect(parseCellRef('$AB$12')).toEqual({ row: 11, col: 27 });
    expect(parseCellRef('XFD1048576')).toEqual({ row: 1048575, col: 16383 });
    expect(parseCellRef('12')).toBeNull();
    expect(parseCellRef('A')).toBeNull();
    expect(parseRangeRef('B2:D5')).toEqual({ r0: 1, c0: 1, r1: 4, c1: 3 });
  });
  it('ods length units', () => {
    expect(lengthToChars('2.54cm')).toBeCloseTo(96 / 7.2, 0);
    expect(lengthToChars('1in')).toBeCloseTo(96 / 7.2, 1);
    expect(lengthToChars('нет')).toBeUndefined();
  });
  it('CFB container: stream list', async () => {
    const cfb = await CfbReader.open(fixture('book.xls'));
    expect(cfb.find('workbook')).toBeDefined();
    expect(cfb.read(cfb.find('Workbook')!).length).toBeGreaterThan(1000);
  });
});
