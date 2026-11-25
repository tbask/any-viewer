import { describe, expect, it } from 'vitest';
import { decodeText, detectEncoding, isValidUtf8 } from '../src/core/encoding';
import { detectDelimiter, indexCsv, parseCsv, parseCsvRow } from '../src/core/csv';

const cp1251 = (s: string) =>
  new Uint8Array([...s].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 128) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    if (c === 0x401) return 0xa8;
    if (c === 0x451) return 0xb8;
    throw new Error('нет в таблице');
  }));

const utf16 = (s: string, le: boolean, bom: boolean) => {
  const out: number[] = bom ? (le ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(...(le ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff]));
  }
  return new Uint8Array(out);
};

describe('encodings', () => {
  it('UTF-8 with and without a BOM', () => {
    const enc = new TextEncoder();
    expect(decodeText(enc.encode('Привет, мир')).text).toBe('Привет, мир');
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('Привет')]);
    expect(decodeText(withBom)).toEqual({ text: 'Привет', encoding: 'utf-8' });
  });
  it('windows-1251 as the fallback encoding', () => {
    const r = decodeText(cp1251('Счёт? Ёжик, привет'));
    expect(r.encoding).toBe('windows-1251');
    expect(r.text).toBe('Счёт? Ёжик, привет');
  });
  it('UTF-16 with and without a BOM', () => {
    expect(decodeText(utf16('Hello мир', true, true)).text).toBe('Hello мир');
    expect(decodeText(utf16('Hello мир', false, true)).text).toBe('Hello мир');
    expect(detectEncoding(utf16('plain ascii text here', true, false))).toBe('utf-16le');
    expect(detectEncoding(utf16('plain ascii text here', false, false))).toBe('utf-16be');
  });
  it('UTF-8 validation', () => {
    const enc = new TextEncoder();
    expect(isValidUtf8(enc.encode('ascii'))).toBe(true);
    expect(isValidUtf8(enc.encode('кириллица 漢字 😀'))).toBe(true);
    expect(isValidUtf8(enc.encode('обрезано').subarray(0, 5))).toBe(true); // cut in the middle of a character
    expect(isValidUtf8(new Uint8Array([0xc0, 0x80]))).toBe(false); // overlong encoding
    expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false); // surrogate
    expect(isValidUtf8(new Uint8Array([0x41, 0xff, 0x41]))).toBe(false);
    expect(isValidUtf8(cp1251('Привет'))).toBe(false);
  });
  it('empty file', () => {
    expect(decodeText(new Uint8Array(0)).text).toBe('');
  });
});

describe('csv', () => {
  it('detects the delimiter', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|');
    expect(detectDelimiter('одна колонка\nбез разделителей\n')).toBe(',');
  });
  it('prefers ";" when the comma is a decimal separator', () => {
    expect(detectDelimiter('Товар;Цена;Кол-во\nХлеб;45,50;2,0\nМолоко;89,90;1,5\n')).toBe(';');
    expect(detectDelimiter('1,5;2,5;3,5\n4,5;5,5;6,5\n')).toBe(';');
  });
  it('does not count delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b;c;d",x\n"e;f;g;h",y\n')).toBe(',');
  });
  it('parses quotes, escaping and line breaks in cells', () => {
    expect(parseCsv('a,"b ""q"" c","multi\nline",d\r\n1,,3,\r\n')).toEqual([
      ['a', 'b "q" c', 'multi\nline', 'd'],
      ['1', '', '3', ''],
    ]);
  });
  it('different line breaks and a missing trailing one', () => {
    expect(parseCsv('a,b\rc,d\ne,f')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(parseCsv('﻿x;y\n1;2')).toEqual([['x', 'y'], ['1', '2']]);
  });
  it('empty rows are kept, an empty file gives zero rows', () => {
    expect(parseCsv('a,b\n\nc,d\n')).toEqual([['a', 'b'], [''], ['c', 'd']]);
    expect(indexCsv('').rowCount).toBe(0);
    expect(indexCsv('').columnCount).toBe(0);
  });
  it('the index counts rows and the column maximum', () => {
    const idx = indexCsv('a,b\n1,2,3,4\n"x,y",z\n');
    expect(idx.rowCount).toBe(3);
    expect(idx.columnCount).toBe(4);
    expect(parseCsvRow(idx.text, idx.rowStarts[2], idx.rowEnds[2], idx.delimiter)).toEqual(['x,y', 'z']);
  });
  it('tolerates an unclosed quote and text after a quote', () => {
    expect(parseCsvRow('"abc', 0, 4, ',')).toEqual(['abc']);
    expect(parseCsvRow('"a"b,c', 0, 6, ',')).toEqual(['ab', 'c']);
    expect(parseCsvRow('a"b,c', 0, 5, ',')).toEqual(['a"b', 'c']);
  });
  it('a large file is indexed and read selectively', () => {
    const rows = 200_000;
    const text = Array.from({ length: rows }, (_, i) => `${i};"имя ${i}";${i * 2}`).join('\n');
    const idx = indexCsv(text);
    expect(idx.rowCount).toBe(rows);
    expect(idx.columnCount).toBe(3);
    expect(parseCsvRow(idx.text, idx.rowStarts[150_000], idx.rowEnds[150_000], idx.delimiter)).toEqual(['150000', 'имя 150000', '300000']);
    expect(indexCsv(text, undefined, 1000).rowCount).toBe(1000);
  });
});
