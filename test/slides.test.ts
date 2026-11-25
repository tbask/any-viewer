import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSlides, type SlidesFormat } from '../src/formats/documents';
import { detectFormat } from '../src/detect';
import type { SlideShape, SlidesModel } from '../src/core/slidemodel';

const fixture = (name: string) => new Blob([readFileSync(join(__dirname, 'fixtures', name)) as BlobPart]);
const textOf = (shape: SlideShape) => (shape.paras ?? []).map((p) => p.runs.map((r) => (r.k === 'text' ? r.text : '')).join('')).join('\n');
const shapeWith = (m: SlidesModel, slide: number, text: string) => m.slides[slide].shapes.find((s) => textOf(s).includes(text))!;

// One presentation in three formats. For ppt only texts and their positions are read.
describe.each<[SlidesFormat, boolean]>([['pptx', true], ['odp', true], ['ppt', false]])('презентация в формате %s', (format, full) => {
  const load = () => parseSlides(format, fixture(`deck.${format}`));

  it('slide size and slide count', async () => {
    const m = await load();
    expect([m.width, m.height]).toEqual([1280, 720]);
    expect(m.slides).toHaveLength(4);
  });

  it('texts stand in their places', async () => {
    const m = await load();
    const title = shapeWith(m, 0, 'Квартальный отчёт');
    expect([Math.round(title.x), Math.round(title.y), Math.round(title.w)]).toEqual([72, 224, 816]);
    expect(textOf(shapeWith(m, 0, 'Алматы'))).toBe('Алматы, ноябрь 2025');
    expect(textOf(shapeWith(m, 1, 'Выручка'))).toBe('Выручка выросла на 18%\nВложенный пункт\nЖирный красный');
    const free = shapeWith(m, 2, 'Свободная надпись');
    expect(Math.round(free.y)).toBe(480);
    expect(textOf(shapeWith(m, 3, 'Таблица'))).toBe('Таблица и диаграмма');
  });

  it('the format is detected by content', async () => {
    expect(await detectFormat(fixture(`deck.${format}`), { name: 'без-расширения' })).toBe(format);
  });

  it.runIf(full)('text formatting, bullets and levels', async () => {
    const m = await load();
    const body = shapeWith(m, 1, 'Выручка');
    // pptx and odp keep the bullet characters of the theme: the second level of the default theme is a dash.
    expect(body.paras!.map((p) => [p.marker, p.level ?? 0])).toEqual([['•', 0], [format === 'ppt' ? '•' : '–', 1], ['•', 0]]);
    const red = body.paras![2].runs[0];
    expect(red.k === 'text' && red.s).toMatchObject({ b: 1, color: '#c00000', size: 32 });
    const title = shapeWith(m, 0, 'Квартальный отчёт').paras![0].runs[0];
    expect(title.k === 'text' && title.s?.size).toBe(44);
    const free = shapeWith(m, 2, 'Свободная надпись').paras![0].runs[0];
    expect(free.k === 'text' && free.s?.size).toBe(24);
  });

  it.runIf(full)('shapes, picture, table and chart', async () => {
    const m = await load();
    expect(shapeWith(m, 2, 'Прямоугольник').fill).toBe('#1f4e79');
    expect(shapeWith(m, 2, 'Круг')).toMatchObject({ fill: '#facc15', shape: 'ellipse' });
    const picture = m.slides[2].shapes.find((s) => s.img)!;
    expect([Math.round(picture.x), Math.round(picture.w), Math.round(picture.h)]).toEqual([768, 384, 192]);
    expect(m.images[picture.img!].mime).toBe('image/png');
    const table = m.slides[3].shapes.find((s) => s.table)!.table!;
    expect(table.rows.map((r) => r.map((c) => c.paras.map((p) => p.runs.map((x) => (x.k === 'text' ? x.text : '')).join('')).join('')))).toEqual([
      ['Месяц', 'План', 'Факт'],
      ['Октябрь', '100', '112'],
      ['Ноябрь', '120', '131'],
    ]);
    expect(table.widths).toHaveLength(3);
    expect(m.slides[3].shapes.some((s) => (s.chart && s.chart.series.length > 0) || s.placeholder === 'chart')).toBe(true);
  });
});

describe('presentations: errors', () => {
  it('foreign data is rejected', async () => {
    await expect(parseSlides('pptx', new Blob(['не презентация']))).rejects.toThrow();
    await expect(parseSlides('odp', new Blob(['не презентация']))).rejects.toThrow();
    await expect(parseSlides('ppt', new Blob(['не презентация']))).rejects.toThrow();
    // An Excel workbook in the same container, but without a presentation stream.
    await expect(parseSlides('ppt', fixture('book.xls'))).rejects.toThrow();
  });
});
