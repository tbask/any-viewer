import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, type DocFormat } from '../src/formats/documents';
import { parseRtf } from '../src/formats/rtf';
import { lengthToPt } from '../src/formats/odt';
import { detectFormat } from '../src/detect';
import { applyCellEdges, formatCounter, type Block, type DocModel, type Inline } from '../src/core/docmodel';

const fixture = (name: string) => new Blob([readFileSync(join(__dirname, 'fixtures', name)) as BlobPart]);
const textOf = (runs: Inline[]) => runs.map((r) => (r.k === 'text' ? r.text : r.k === 'tab' ? '\t' : r.k === 'br' ? '\n' : '')).join('');
const paragraphs = (m: DocModel) => m.blocks.filter((b): b is Extract<Block, { k: 'p' }> => b.k === 'p');
const find = (m: DocModel, text: string) => paragraphs(m).find((p) => textOf(p.runs).includes(text))!;
const run = (m: DocModel, text: string) => {
  for (const p of paragraphs(m)) for (const r of p.runs) if (r.k === 'text' && r.text.includes(text)) return r;
  throw new Error(`нет фрагмента «${text}»`);
};

// One document in four formats (the docx was made with python-docx, the others were produced from it in LibreOffice).
describe.each<[DocFormat, { numbered: boolean; styled: boolean }]>([
  ['docx', { numbered: true, styled: true }],
  ['odt', { numbered: true, styled: true }],
  ['rtf', { numbered: false, styled: true }],
  ['doc', { numbered: false, styled: false }],
])('документ в формате %s', (format, caps) => {
  const load = () => parseDocument(format, fixture(`doc.${format}`), {});

  it('headings and text, including Kazakh letters and special characters', async () => {
    const m = await load();
    expect(find(m, 'Договор поставки № 42').s?.heading).toBe(1);
    expect(find(m, '1. Предмет договора').s?.heading).toBe(2);
    expect(find(m, '3. Реквизиты').s?.heading).toBe(2);
    expect(textOf(find(m, 'Қазақша').runs)).toBe('Қазақша мәтін: әіңғүұқөһ. Спецсимволы: «ёлочки» — тире № 5 € ₸');
    expect(textOf(find(m, 'табуляцией').runs)).toBe('Текст с табуляцией:\tпосле табуляции');
  });

  it('emphasis, size, colour, sub/superscript', async () => {
    const m = await load();
    expect(run(m, 'полужирный').s).toMatchObject({ b: 1 });
    expect(run(m, 'курсив').s).toMatchObject({ i: 1 });
    expect(run(m, 'подчёркнутый').s).toMatchObject({ u: 1 });
    expect(run(m, 'красный 16 пт').s).toMatchObject({ color: '#c00000', size: 16 });
    expect(run(m, 'Обычный текст').s?.b).toBeUndefined();
    const formula = find(m, 'Обычный текст').runs.filter((r) => r.k === 'text' && r.text === '2') as Extract<Inline, { k: 'text' }>[];
    expect(formula.map((r) => r.s?.va)).toEqual(['sub', 'sup']);
    expect(run(m, '25 ноября 2025 года').s).toMatchObject({ b: 1 });
  });

  it('alignment', async () => {
    const m = await load();
    expect(find(m, 'По центру').s?.align).toBe('center');
    expect(find(m, 'Справа').s?.align).toBe('right');
    expect(find(m, 'Обычный текст').s?.align).toBe('justify');
  });

  it('lists', async () => {
    const m = await load();
    const item = (t: string) => find(m, t);
    if (format === 'rtf') {
      // In RTF the bullet and the number are written as plain text at the start of the paragraph.
      expect(textOf(item('Второй пункт').runs).trim()).toMatch(/^2\.\s+Второй пункт$/);
      expect(textOf(item('Маркер один').runs).trim()).toMatch(/^•\s+Маркер один$/);
    } else {
      expect(item('Первый пункт').marker).toBe(caps.numbered ? '1.' : '•');
      expect(item('Третий пункт').marker).toBe(caps.numbered ? '3.' : '•');
      expect(item('Маркер два').marker).toBe('•');
    }
  });

  it('table with a merged cell', async () => {
    const m = await load();
    const table = m.blocks.find((b): b is Extract<Block, { k: 'table' }> => b.k === 'table')!;
    const cells = table.rows.map((r) => r.cells.filter((c) => !c.skip).map((c) => c.blocks.map((b) => (b.k === 'p' ? textOf(b.runs) : '')).join('')));
    expect(cells).toEqual([['Товар', 'Количество', 'Цена'], ['Хлеб', '2', '45,50'], ['Молоко', '1', '89,90'], ['Итого', '180,90']]);
    expect(table.rows[3].cells[0].colSpan).toBe(2);
    expect(table.widths).toHaveLength(3);
  });

  it('picture and page break', async () => {
    const m = await load();
    const images = Object.values(m.images);
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe('image/png');
    expect(new Uint8Array(images[0].data).subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    const img = paragraphs(m).flatMap((p) => p.runs).find((r) => r.k === 'img') as Extract<Inline, { k: 'img' }>;
    expect([img.w, img.h]).toEqual([240, 120]);
    const breakAt = m.blocks.findIndex((b) => b.k === 'pagebreak');
    const before = m.blocks.findIndex((b) => b.k === 'p' && textOf(b.runs).includes('Перед разрывом'));
    const after = m.blocks.findIndex((b) => b.k === 'p' && textOf(b.runs).includes('3. Реквизиты'));
    expect(breakAt).toBeGreaterThan(before);
    expect(breakAt).toBeLessThan(after);
  });

  it('the format is detected by content', async () => {
    expect(await detectFormat(fixture(`doc.${format}`), { name: 'без-расширения' })).toBe(format);
  });
});

describe('RTF: special cases', () => {
  const rtf = (body: string) => parseRtf(new TextEncoder().encode(body));
  it('code page, \\u and escaping', () => {
    const m = rtf("{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0\\fcharset204 Arial;}}\\f0 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2, \\u1084?\\u1080?\\u1088? \\{a\\}\\\\\\par}");
    expect(textOf(paragraphs(m)[0].runs)).toBe('Привет, мир {a}\\');
  });
  it('text properties are scoped to the group', () => {
    const m = rtf('{\\rtf1 a{\\b b}c\\par}');
    const runs = paragraphs(m)[0].runs as Extract<Inline, { k: 'text' }>[];
    expect(runs.map((r) => [r.text, r.s?.b])).toEqual([['a', undefined], ['b', 1], ['c', undefined]]);
  });
  it('service groups and the field code stay out of the text, the field result goes in', () => {
    const m = rtf('{\\rtf1{\\info{\\title secret}}{\\*\\generator X;}{\\field{\\*\\fldinst HYPERLINK "http://x"}{\\fldrslt link}} text\\par}');
    expect(textOf(paragraphs(m)[0].runs)).toBe('link text');
  });
  it('non-RTF is rejected', () => {
    expect(() => rtf('просто текст')).toThrow();
  });
});

describe('document helper functions', () => {
  it('list numbering', () => {
    expect([1, 2, 27].map((n) => formatCounter(n, 'lowerLetter'))).toEqual(['a', 'b', 'aa']);
    expect([1, 4, 9, 14, 2025].map((n) => formatCounter(n, 'upperRoman'))).toEqual(['I', 'IV', 'IX', 'XIV', 'MMXXV']);
    expect(formatCounter(3, 'russianLower')).toBe('в');
    expect(formatCounter(7, 'decimal')).toBe('7');
  });
  it('length units', () => {
    expect(lengthToPt('1in')).toBe(72);
    expect(lengthToPt('2.54cm')).toBeCloseTo(72, 0);
    expect(lengthToPt('12pt')).toBe(12);
    expect(lengthToPt('50%')).toBeUndefined();
  });
  it('cell merging by edges', () => {
    const rows = [{ cells: [{ blocks: [] }, { blocks: [] }, { blocks: [] }] }, { cells: [{ blocks: [] }, { blocks: [] }] }];
    expect(applyCellEdges(rows, [[100, 200, 300], [200, 300]])).toEqual([100, 100, 100]);
    expect(rows[1].cells[0]).toMatchObject({ colSpan: 2 });
    expect(applyCellEdges(rows, [[100, 200, 300], undefined])).toBeUndefined();
  });
});
