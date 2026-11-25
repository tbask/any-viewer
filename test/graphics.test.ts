/**
 * Graphics and formatting on Microsoft Office files: charts, shapes, SmartArt, equations, watermark,
 * conditional formatting, comments, row heights, binary ppt.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paletteColor } from '../src/core/chart';
import type { Block, DocModel, MathNode } from '../src/core/docmodel';
import type { SlideShape } from '../src/core/slidemodel';
import { parseDocument, parseSlides } from '../src/formats/documents';
import { mathToText, parseOmml } from '../src/formats/omml';
import { openWorkbook } from '../src/formats/tables';
import { parseXml } from '../src/core/xml';
import { axisScale } from '../src/renderers/chart';
import { presetPath } from '../src/renderers/shapes';

const dir = join(__dirname, 'fixtures', 'office');
const blobOf = (name: string) => new Blob([new Uint8Array(readFileSync(join(dir, name))) as BlobPart]);
const options = { maxRows: 100_000, lang: 'en-US' };
const shapeText = (s: SlideShape) => (s.paras ?? []).map((p) => p.runs.map((r) => (r.k === 'text' ? r.text : '')).join('')).join('\n');

describe('Excel: formatting and sheet objects', () => {
  it('xlsx: row heights, comment, picture, shape, conditional formatting', async () => {
    const wb = await openWorkbook('xlsx', blobOf('excel-features.xlsx'), options);
    const { meta } = await wb.openSheet(0);
    expect(meta.rowHeights).toEqual({ 0: 1.4, 5: 1.25, 6: 4.66, 17: 2.66 });
    expect(meta.notes).toEqual({ '9:2': 'Test Test: [X17] Текст примечания к ячейке' });
    const objects = meta.objects ?? [];
    expect(objects.filter((o) => o.image).length).toBe(1);
    expect(objects.find((o) => o.text)?.text).toBe('[X25] Фигура на листе');
    const styles = meta.styles ?? [];
    // Data bars in cells: the largest value has a full-width bar.
    expect(styles.some((s) => s.bar?.part === 1)).toBe(true);
    expect(new Set(styles.filter((s) => s.icon).map((s) => s.icon!.color)).size).toBe(3);
    expect(styles.some((s) => s.fill === '#f8696b')).toBe(true); // start of the colour scale
    expect(styles.some((s) => s.fill === '#ffc7ce' && s.color === '#9c0006')).toBe(true); // the "greater than 50" rule
    expect(styles.some((s) => s.size === 14 && s.bold)).toBe(true);
    expect(styles.some((s) => s.wrap)).toBe(true);
    expect(styles.some((s) => s.strike)).toBe(true);
  });
  it('xlsx: four charts with cached values', async () => {
    const wb = await openWorkbook('xlsx', blobOf('excel-features.xlsx'), options);
    const { meta } = await wb.openSheet(wb.sheets.indexOf('Диаграммы'));
    const charts = (meta.objects ?? []).map((o) => o.chart!).filter(Boolean);
    expect(charts.map((c) => c.title)).toEqual(['[X20] Гистограмма', '[X20] График', '[X20] Круговая', '[X20] Комбинированная']);
    expect(charts[0].categories).toEqual(['Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь']);
    expect(charts[0].series.map((s) => [s.kind, s.name, s.values])).toEqual([
      ['bar', 'План', [100, 110, 120, 130, 140, 150]],
      ['bar', 'Факт', [95, 108, 121, 134, 147, 160]],
    ]);
    expect(charts[3].series.map((s) => s.kind)).toEqual(['bar', 'line']);
    expect(charts[2].series[0].kind).toBe('pie');
  });
  it('xls and ods: row heights and comment', async () => {
    for (const format of ['xls', 'ods'] as const) {
      const wb = await openWorkbook(format, blobOf(`excel-features.${format}`), options);
      const { meta } = await wb.openSheet(0);
      expect(meta.rowHeights, format).toEqual({ 0: 1.4, 5: 1.25, 6: 4.66, 17: 2.66 });
      expect(meta.notes, format).toEqual({ '9:2': '[X17] Текст примечания к ячейке' });
    }
  });
});

describe('axes and outlines', () => {
  it('value axis: round ticks and headroom at the top', () => {
    expect(axisScale(95, 160, 9)).toEqual({ min: 0, max: 180, step: 20 });
    expect(axisScale(0, 5)).toEqual({ min: 0, max: 6, step: 1 });
    expect(axisScale(-30, 70).min).toBeLessThanOrEqual(-30);
    expect(axisScale(1000, 1010).min).toBeGreaterThan(0);
    expect(axisScale(0, 0)).toEqual({ min: 0, max: 1.2, step: 0.2 });
  });
  it('preset shape outlines', () => {
    expect(presetPath('triangle', 100, 50)).toBe('M50.0 0.0 L100.0 50.0 L0.0 50.0 Z');
    expect(presetPath('star5', 100, 100)!.split('L').length).toBe(10);
    for (const name of ['rightArrow', 'diamond', 'cloud', 'wedgeRoundRectCallout', 'heart', 'flowChartTerminator', 'chevron', 'hexagon']) expect(presetPath(name, 120, 80), name).toMatch(/^M.*Z/);
    expect(presetPath('rect', 10, 10)).toBeNull();
    expect(presetPath('неизвестная', 10, 10)).toBeNull();
  });
  it('series colours: after six theme colours come their shades', () => {
    const palette = ['#111111', '#222222', '#333333'];
    expect(paletteColor(palette, 1)).toBe('#222222');
    expect(paletteColor(palette, 4)).not.toBe('#222222');
  });
});

describe('pptx: shapes, effects, charts, SmartArt', () => {
  it('preset outlines, gradient, transparency, shadow, cropping, vertical text', async () => {
    const model = await parseSlides('pptx', blobOf('ppt-features.pptx'));
    const all = model.slides.flatMap((s) => s.shapes);
    const byText = (code: string) => all.find((s) => shapeText(s).trim().startsWith(code))!;
    expect(byText('[P07-4]').geom).toBe('triangle');
    expect(byText('[P07-5]').geom).toBe('rightArrow');
    expect(byText('[P07-6]').geom).toBe('star5');
    expect(byText('[P07-8]').geom).toBe('flowChartDecision');
    expect(byText('[P07-3]').shape).toBe('ellipse');
    expect(byText('[P08-A]').dash).toBe(true);
    expect(byText('[P08-B]').shadow).toBe(true);
    expect(byText('[P08-D]').rot).toBe(20);
    expect(byText('[P08-E]').gradient!.stops.length).toBeGreaterThanOrEqual(2);
    expect(byText('[P08-F]').alpha).toBe(0.5);
    expect(byText('[P16]').textRot).toBe(270);
    expect(all.some((s) => s.crop && s.crop.l > 0.2)).toBe(true);
    expect(all.some((s) => s.shape === 'line' && s.arrowEnd)).toBe(true);
    expect(all.some((s) => s.img?.endsWith('.svg'))).toBe(true);
    expect(model.slides.some((s) => s.bgGradient)).toBe(true);
    const run = byText('[P15]').paras![0].runs[0];
    expect(run.k === 'text' && run.s?.outline).toBeTruthy();
    const link = byText('[P17]').paras!.flatMap((p) => p.runs).find((r) => r.k === 'text' && r.href);
    expect(link && link.k === 'text' && link.href).toMatch(/^https?:/);
  });
  it('charts and SmartArt', async () => {
    const model = await parseSlides('pptx', blobOf('ppt-features.pptx'));
    const charts = model.slides.flatMap((s) => s.shapes).filter((s) => s.chart).map((s) => s.chart!);
    expect(charts.map((c) => [c.title, c.series[0].kind, c.series.length])).toEqual([['[P13] Гистограмма', 'bar', 3], ['[P13] Круговая', 'pie', 1]]);
    expect(charts[0].series[0].values).toEqual([4.3, 2.5, 3.5, 4.5]);
    const nodes = model.slides.flatMap((s) => s.shapes).filter((s) => shapeText(s).includes('[P14]'));
    expect(nodes.filter((s) => s.fill).map((s) => shapeText(s).replace(/\s+/g, ' '))).toEqual(['[P14] Узел 1', '[P14] Узел 2', '[P14] Узел 3', '[P14] Узел 4', '[P14] Узел 5']);
    expect(model.slides.flatMap((s) => s.shapes).some((s) => s.placeholder)).toBe(false);
  });
});

describe('ppt: binary format', () => {
  it('slides, text formatting, table, pictures, outlines', async () => {
    const model = await parseSlides('ppt', blobOf('ppt-features.ppt'));
    expect(model.slides.length).toBe(17);
    expect([model.width, model.height]).toEqual([1280, 720]);
    const all = model.slides.flatMap((s) => s.shapes);
    const byText = (code: string) => all.find((s) => shapeText(s).trim().startsWith(code))!;
    // Slide order as in the show.
    expect(shapeText(model.slides[0].shapes.find((s) => s.paras)!)).toContain('[P02-T]');
    expect(model.slides.findIndex((s) => s.shapes.some((x) => shapeText(x).includes('[P13]')))).toBe(11);
    // Text formatting: font, size and colour from the master and from the text itself.
    const footer = byText('[P22]').paras![0].runs[0];
    expect(footer.k === 'text' && footer.s).toMatchObject({ size: 9, color: '#898989', font: 'Trebuchet MS' });
    const title = byText('[P02-B]').paras![0].runs[0];
    expect(title.k === 'text' && title.s?.size).toBe(36);
    // Text with effects (shadow, highlight, WordArt) was saved by PowerPoint itself as a picture in this format.
    expect(model.slides[3].shapes.some((s) => s.img)).toBe(true);
    // A table is a group of cell shapes.
    for (const cell of ['[P06] Показатель', 'Q2', '7,9 млн', 'Объединённая ячейка', '+12 %']) expect(all.some((s) => shapeText(s) === cell), cell).toBe(true);
    // Shapes.
    expect(byText('[P07-5]').geom).toBe('rightArrow');
    expect(byText('[P07-3]').shape).toBe('ellipse');
    expect(byText('[P07-6]').path).toBeDefined();
    expect(byText('[P08-A]').dash).toBe(true);
    expect(byText('[P08-D]').rot).toBe(20);
    expect(byText('[P08-F]').alpha).toBeCloseTo(0.5, 1);
    // Pictures and the background picture.
    expect(Object.keys(model.images).length).toBeGreaterThanOrEqual(5);
    expect(all.some((s) => s.crop && s.crop.l > 0.2)).toBe(true);
    expect(model.slides.some((s) => s.bgImg)).toBe(true);
    // Footer: the slide number is substituted for the service character.
    expect(model.slides[4].shapes.some((s) => shapeText(s) === '5')).toBe(true);
    expect(all.some((s) => shapeText(s).includes('*'))).toBe(false);
    // Bullets of all list levels.
    const levels = byText('[P05-1]').paras!;
    // The theme's bullet is an arrowhead from Wingdings 3; it is mapped to a regular character.
    expect(levels.map((p) => [p.level ?? 0, p.marker])).toEqual([[0, '▶'], [1, '▶'], [2, '▶'], [3, '▶'], [4, '▶']]);
  });
  it('a LibreOffice file is read by the old path', async () => {
    const model = await parseSlides('ppt', new Blob([new Uint8Array(readFileSync(join(dir, '..', 'deck.ppt'))) as BlobPart]));
    expect(model.slides.length).toBe(4);
    const texts = model.slides.flatMap((s) => s.shapes).map(shapeText);
    for (const t of ['Квартальный отчёт', 'Прямоугольник', 'Октябрь', '131']) expect(texts.some((x) => x.includes(t)), t).toBe(true);
    expect(Object.keys(model.images).length).toBeGreaterThanOrEqual(1);
    // LibreOffice writes an ellipse as a freeform outline with formulas; it is recognised as an ellipse.
    expect(model.slides[2].shapes.some((s) => s.shape === 'ellipse' && shapeText(s) === 'Круг')).toBe(true);
  });
});

describe('docx: graphics', () => {
  let model: DocModel;
  const blocks = (kind: Block['k']) => model.blocks.filter((b) => b.k === kind);
  it('watermark, WordArt, chart, SmartArt, shapes, equation, embedded workbook', async () => {
    model = await parseDocument('docx', blobOf('word-features.docx'), {});
    expect(model.watermark).toBe('[W42] КОНФИДЕНЦИАЛЬНО');
    const art = model.blocks.flatMap((b) => (b.k === 'p' ? b.runs : [])).find((r) => r.k === 'text' && r.text === '[W28] WordArt');
    expect(art && art.k === 'text' && art.s).toMatchObject({ size: 28, b: 1 });

    const chart = blocks('chart')[0];
    expect(chart.k === 'chart' && [chart.chart.title, chart.chart.series.length, chart.w, chart.h]).toEqual(['[W30] Диаграмма Word', 3, 576, 336]);

    const canvases = blocks('canvas').map((b) => (b.k === 'canvas' ? b.shapes : []));
    expect(canvases[0].map((s) => shapeText(s).replace(/\s+/g, ' '))).toEqual(['[W29] Узел 1', '[W29] Узел 2', '[W29] Узел 3', '[W29] Узел 4', '[W29] Узел 5']);
    // Three shapes and a text box of one paragraph stand on a shared canvas with their relative positions.
    const shapes = canvases[1];
    expect(shapes.map((s) => s.geom ?? s.shape ?? 'rect').sort()).toEqual(['rect', 'rect', 'rightArrow', 'star5']);
    const xs = ['[W26-A]', '[W26-B]', '[W26-C]'].map((code) => shapes.find((s) => shapeText(s).includes(code))!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);

    const math = model.blocks.flatMap((b) => (b.k === 'p' ? b.runs : [])).find((r) => r.k === 'math');
    expect(math && math.k === 'math' && mathToText(math.node).replace(/[\s ]/g, '')).toBe('x=(−b±√(b^2−4ac))/(2a)');

    // Embedded Excel workbook: the snapshot saved by Word itself is shown (EMF metafile → SVG).
    const svg = Object.values(model.images).find((im) => im.mime === 'image/svg+xml');
    expect(svg).toBeDefined();
    const text = new TextDecoder().decode(svg!.data);
    expect(text).toContain('Реестр платежей за ноябрь 2026');
    expect(text).toContain('Суммы платежей');
  });
});

describe('equations (OMML)', () => {
  const root = (xml: string) => {
    const doc = parseXml(xml);
    return doc.name === 'm:oMath' ? doc : doc.children[0];
  };
  const m = (xml: string): MathNode => parseOmml(root(`<m:oMath xmlns:m="m">${xml}</m:oMath>`))!;
  const r = (t: string) => `<m:r><m:t>${t}</m:t></m:r>`;
  it('fraction, power, subscript, root, sum, brackets, matrix', () => {
    expect(mathToText(m(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`))).toBe('(a)/(b)');
    expect(mathToText(m(`<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`))).toBe('x^2');
    expect(mathToText(m(`<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`))).toBe('x_i^2');
    expect(m(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r('x')}</m:e></m:rad>`)).toMatchObject({ t: 'rad', deg: undefined });
    expect(m(`<m:rad><m:deg>${r('3')}</m:deg><m:e>${r('x')}</m:e></m:rad>`)).toMatchObject({ t: 'rad', deg: { t: 'text', v: '3' } });
    expect(m(`<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${r('i')}</m:sub><m:sup>${r('n')}</m:sup><m:e>${r('x')}</m:e></m:nary>`)).toMatchObject({ t: 'nary', chr: '∑' });
    expect(mathToText(m(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${r('a')}</m:e><m:e>${r('b')}</m:e></m:d>`))).toBe('[a|b]');
    expect(m(`<m:m><m:mr><m:e>${r('1')}</m:e><m:e>${r('2')}</m:e></m:mr><m:mr><m:e>${r('3')}</m:e><m:e>${r('4')}</m:e></m:mr></m:m>`)).toMatchObject({ t: 'matrix' });
  });
  it('variables in italics, digits and signs upright, function names upright', () => {
    expect(m(r('x=2'))).toMatchObject({ t: 'row', items: [{ t: 'text', v: 'x' }, { t: 'text', upright: true }] });
    expect(m(r('sin'))).toMatchObject({ t: 'text', v: 'sin', upright: true });
    expect(parseOmml(root('<m:oMath xmlns:m="m"/>'))).toBeUndefined();
  });
});
