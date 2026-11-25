/**
 * xls/ppt/doc passwords, EMF/WMF metafiles, sheet objects in xls and ods, OpenDocument graphics, doc shapes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { md5 } from '../src/core/crypto';
import { metafileKind, metafileToSvg } from '../src/core/metafile';
import type { Block } from '../src/core/docmodel';
import type { SlideShape } from '../src/core/slidemodel';
import { parseXml } from '../src/core/xml';
import { parseDocument, parseSlides } from '../src/formats/documents';
import { odfShapePath, parseOdfChart } from '../src/formats/odf-draw';
import { openWorkbook } from '../src/formats/tables';

const fixtures = join(__dirname, 'fixtures');
const blobOf = (...path: string[]) => new Blob([new Uint8Array(readFileSync(join(fixtures, ...path))) as BlobPart]);
const options = { maxRows: 100_000, lang: 'en-US' };
const shapeText = (s: SlideShape) => (s.paras ?? []).map((p) => p.runs.map((r) => (r.k === 'text' ? r.text : '')).join('')).join('\n');
const errorName = async (run: () => Promise<unknown>) => run().then(() => 'ok', (e: Error) => e.name);

describe('passwords of the binary formats', () => {
  it('MD5', () => {
    const hex = (text: string) => [...md5(new TextEncoder().encode(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367');
  });
  it('xls: legacy RC4 (LibreOffice) and RC4 CryptoAPI', async () => {
    const plain = await openWorkbook('xls', blobOf('office', 'excel-features.xls'), options);
    const expected = (await plain.openSheet(0)).getRows(0, 12).rows;
    for (const name of ['lo-password.xls', 'capi-password.xls']) {
      expect(await errorName(() => openWorkbook('xls', blobOf('crypto', name), options)), name).toBe('PasswordRequiredError');
      expect(await errorName(() => openWorkbook('xls', blobOf('crypto', name), { ...options, password: 'nope' })), name).toBe('WrongPasswordError');
      const wb = await openWorkbook('xls', blobOf('crypto', name), { ...options, password: 'test123' });
      expect(wb.sheets, name).toEqual(plain.sheets);
      expect((await wb.openSheet(0)).getRows(0, 12).rows, name).toEqual(expected);
    }
  });
  it('ppt: RC4 CryptoAPI, including the picture stream', async () => {
    const strip = (m: unknown) => JSON.stringify(m, (_, v) => (v instanceof ArrayBuffer ? v.byteLength : v));
    const plain = await parseSlides('ppt', blobOf('office', 'ppt-features.ppt'));
    expect(await errorName(() => parseSlides('ppt', blobOf('crypto', 'capi-password.ppt')))).toBe('PasswordRequiredError');
    expect(await errorName(() => parseSlides('ppt', blobOf('crypto', 'capi-password.ppt'), { password: 'nope' }))).toBe('WrongPasswordError');
    const opened = await parseSlides('ppt', blobOf('crypto', 'capi-password.ppt'), { password: 'test123' });
    expect(strip(opened)).toBe(strip(plain));
    const png = new Uint8Array(Object.values(opened.images).find((im) => im.mime === 'image/png')!.data);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it('doc: legacy RC4 (LibreOffice)', async () => {
    expect(await errorName(() => parseDocument('doc', blobOf('crypto', 'lo-password.doc'), {}))).toBe('PasswordRequiredError');
    expect(await errorName(() => parseDocument('doc', blobOf('crypto', 'lo-password.doc'), { password: 'nope' }))).toBe('WrongPasswordError');
    const model = await parseDocument('doc', blobOf('crypto', 'lo-password.doc'), { password: 'test123' });
    expect(JSON.stringify(model.blocks)).toContain('Тестовый документ Word');
  });
});

describe('metafiles', () => {
  it('EMF and WMF become SVG with shapes and text', () => {
    for (const name of ['sample.emf', 'sample.wmf']) {
      const bytes = new Uint8Array(readFileSync(join(fixtures, 'ext', name)));
      expect(metafileKind(bytes), name).toBe(name.slice(-3));
      const svg = metafileToSvg(bytes)!;
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), name).toBe(true);
      expect(() => parseXml(svg), name).not.toThrow();
      for (const part of ['fill="#4472c4"', 'fill="#ed7d31"', 'fill="#70ad47"', '#c00000', 'Метафайл Text 123', 'Жирный красный', 'font-weight="bold"']) expect(svg, `${name}: ${part}`).toContain(part);
      expect(svg, name).not.toMatch(/<script|javascript:|href="http/i);
    }
    expect(metafileToSvg(new Uint8Array(64))).toBeNull();
    expect(metafileToSvg(new Uint8Array([1, 0, 9, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
  it('doc and odt: snapshot of an embedded workbook from a metafile', async () => {
    for (const format of ['doc', 'odt'] as const) {
      const model = await parseDocument(format, blobOf('office', `word-features.${format}`), {});
      const svg = Object.values(model.images).find((im) => im.mime === 'image/svg+xml');
      expect(svg, format).toBeDefined();
      expect(new TextDecoder().decode(svg!.data), format).toContain('Реестр платежей за ноябрь 2026');
    }
  });
});

describe('xls and ods: sheet objects and conditional formatting', () => {
  for (const format of ['xls', 'ods'] as const) {
    it(`${format}: picture, shape, four charts`, async () => {
      const wb = await openWorkbook(format, blobOf('office', `excel-features.${format}`), options);
      const main = (await wb.openSheet(0)).meta.objects ?? [];
      expect(main.filter((o) => o.image?.mime === 'image/png').length).toBe(1);
      expect(main.find((o) => o.text)).toMatchObject({ text: '[X25] Фигура на листе', fill: '#156082' });
      const sheet = await wb.openSheet(wb.sheets.indexOf('Диаграммы'));
      const charts = (sheet.meta.objects ?? []).map((o) => o.chart!).filter(Boolean);
      expect(charts.map((c) => c.title)).toEqual(['[X20] Гистограмма', '[X20] График', '[X20] Круговая', '[X20] Комбинированная']);
      expect(charts[0].categories).toEqual(['Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь']);
      expect(charts[0].series.map((s) => [s.kind, s.name, s.values])).toEqual([
        ['bar', 'План', [100, 110, 120, 130, 140, 150]],
        ['bar', 'Факт', [95, 108, 121, 134, 147, 160]],
      ]);
      expect(charts[1].series[0].kind).toBe('line');
      expect(charts[2].series[0].kind).toBe('pie');
      expect(charts[3].series.map((s) => s.kind)).toEqual(['bar', 'line']);
      // The sheet is extended so that the charts fit.
      expect(sheet.meta.rowCount).toBeGreaterThan(30);
    });
  }
  it('xls: conditional formatting matches xlsx', async () => {
    const looks = async (format: 'xls' | 'xlsx') => {
      const wb = await openWorkbook(format, blobOf('office', `excel-features.${format}`), options);
      const sheet = await wb.openSheet(0);
      const block = sheet.getRows(0, sheet.meta.rowCount);
      const out: string[] = [];
      block.rows.forEach((row, r) => row?.forEach((_, c) => {
        const st = sheet.meta.styles?.[block.styles?.[r]?.[c] ?? 0];
        if (r >= 12 && r <= 15 && c >= 2 && st) out.push(`${r}:${c}:${st.fill ?? ''}:${st.bar ? st.bar.part.toFixed(2) + st.bar.color : ''}:${st.icon ? st.icon.char + st.icon.color : ''}:${r === 15 ? st.color ?? '' : ''}`);
      }));
      return out;
    };
    const xls = await looks('xls');
    expect(xls).toEqual(await looks('xlsx'));
    expect(xls.some((l) => l.includes('#f8696b'))).toBe(true);
    expect(xls.some((l) => l.includes('1.00#638ec6'))).toBe(true);
    expect(xls.some((l) => l.includes('#ffc7ce') && l.endsWith('#9c0006'))).toBe(true);
  });
  it('ods: the "greater than 50" rule from the cell style', async () => {
    const wb = await openWorkbook('ods', blobOf('office', 'excel-features.ods'), options);
    const sheet = await wb.openSheet(0);
    const block = sheet.getRows(15, 16);
    const fills = block.rows[0]!.map((_, c) => sheet.meta.styles?.[block.styles?.[0]?.[c] ?? 0]?.fill);
    expect(fills.slice(2, 8)).toEqual([undefined, undefined, undefined, '#ffc7ce', '#ffc7ce', '#ffc7ce']);
  });
});

describe('OpenDocument graphics', () => {
  const geometry = (path: string, equations: Record<string, string> = {}, extra = '') =>
    parseXml(`<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:enhanced-path="${path}" ${extra}>${Object.entries(equations).map(([n, f]) => `<draw:equation draw:name="${n}" draw:formula="${f}"/>`).join('')}</draw:enhanced-geometry>`);
  const root = (n: ReturnType<typeof parseXml>) => (n.name === 'draw:enhanced-geometry' ? n : n.children[0]);
  it('outline with formulas, arcs and ellipse quarters', () => {
    expect(odfShapePath(root(geometry('M 0 ?f0 L ?f1 ?f0 ?f1 0 21600 10800 Z N', { f0: '$0 ', f1: '21600-?f2 ', f2: 'if(?f0 ,5400,0)*2' }, 'draw:modifiers="5400"')))).toEqual(['M', 0, 0.25, 'L', 0.5, 0.25, 'L', 0.5, 0, 'L', 1, 0.5, 'Z']);
    const quarter = odfShapePath(root(geometry('M 10800 0 X 21600 10800 Y 10800 21600 Z N')))!;
    expect(quarter.filter((t) => t === 'C').length).toBe(2);
    expect(quarter.slice(-8)).toEqual(['C', expect.closeTo(1, 3), expect.closeTo(0.776, 2), expect.closeTo(0.776, 2), 1, 0.5, 1, 'Z']);
    const circle = odfShapePath(root(geometry('U 10800 10800 10800 10800 0 360 Z N')))!;
    expect(circle.filter((t) => t === 'C').length).toBe(4);
    expect(circle.slice(0, 3)).toEqual(['M', 1, 0.5]);
    // A formula that refers to itself does not loop the parser.
    expect(odfShapePath(root(geometry('M 0 0 L ?a ?a Z N', { a: '?a +1' })))).toHaveLength(7);
    expect(odfShapePath(undefined)).toBeUndefined();
  });
  it('chart from an embedded object', () => {
    const chart = parseOdfChart(parseXml(`<office:document-content><office:body><office:chart><chart:chart chart:class="chart:bar"><chart:title><text:p>Продажи<text:s/>2026</text:p></chart:title>
      <chart:plot-area><chart:axis chart:dimension="x"><chart:categories table:cell-range-address="local-table.$A$2:.$A$3"/></chart:axis>
      <chart:series chart:label-cell-address="local-table.$B$1" chart:values-cell-range-address="local-table.$B$2:.$B$3" chart:class="chart:bar"/>
      <chart:series chart:label-cell-address="local-table.$C$1" chart:values-cell-range-address="local-table.$C$2:.$C$3" chart:class="chart:line"/></chart:plot-area>
      <table:table table:name="local-table"><table:table-header-rows><table:table-row><table:table-cell/><table:table-cell office:value-type="string"><text:p>План</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Факт</text:p></table:table-cell></table:table-row></table:table-header-rows>
      <table:table-rows><table:table-row><table:table-cell office:value-type="string"><text:p>Янв</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="10"/><table:table-cell office:value-type="float" office:value="12.5"/></table:table-row>
      <table:table-row><table:table-cell office:value-type="string"><text:p>Фев</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="20"/><table:table-cell office:value-type="float" office:value="18"/></table:table-row></table:table-rows></table:table>
      </chart:chart></office:chart></office:body></office:document-content>`))!;
    expect(chart.title).toBe('Продажи 2026');
    expect(chart.categories).toEqual(['Янв', 'Фев']);
    expect(chart.series.map((s) => [s.kind, s.name, s.values])).toEqual([['bar', 'План', [10, 20]], ['line', 'Факт', [12.5, 18]]]);
  });
  it('odp: charts and shape outlines; odt: shapes on a canvas and watermark', async () => {
    const slides = await parseSlides('odp', blobOf('office', 'ppt-features.odp'));
    const shapes = slides.slides.flatMap((s) => s.shapes);
    expect(shapes.filter((s) => s.chart).map((s) => [s.chart!.title, s.chart!.series.length])).toEqual([['[P13] Гистограмма', 3], ['[P13] Круговая', 1]]);
    expect(shapes.some((s) => s.placeholder === 'chart')).toBe(false);
    expect(shapes.find((s) => shapeText(s).startsWith('[P07-6]'))?.path).toBeDefined();
    expect(shapes.find((s) => shapeText(s).startsWith('[P07-5]'))?.path).toBeDefined();
    const doc = await parseDocument('odt', blobOf('office', 'word-features.odt'), {});
    expect(doc.watermark).toBe('[W42] КОНФИДЕНЦИАЛЬНО');
    const canvas = doc.blocks.find((b): b is Extract<Block, { k: 'canvas' }> => b.k === 'canvas')!;
    expect(canvas.shapes.map((s) => shapeText(s)).sort()).toEqual(['[W26-A] Прямоугольник', '[W26-B] Стрелка', '[W26-C] Звезда']);
    expect(canvas.shapes.filter((s) => s.path).length).toBe(2);
    expect(canvas.shapes.every((s) => s.fill === '#156082')).toBe(true);
  });
});

describe('ppt and doc: links, connectors, shapes', () => {
  it('ppt: link in text, gradient background, elbow connector', async () => {
    const model = await parseSlides('ppt', blobOf('office', 'ppt-features.ppt'));
    const runs = model.slides.flatMap((s) => s.shapes).flatMap((s) => s.paras ?? []).flatMap((p) => p.runs);
    expect(runs.find((r) => r.k === 'text' && r.href)).toMatchObject({ text: '[P17] Ссылка на сайт example.com', href: 'https://example.com/' });
    expect(model.slides[9].bgGradient?.stops.map((s) => s.color)).toEqual(['#bdd7ee', '#ffffff']);
    const connector = model.slides.flatMap((s) => s.shapes).find((s) => s.connector)!;
    expect(connector.connector).toMatchObject({ kind: 'bent', elbows: 4 });
    const pptx = await parseSlides('pptx', blobOf('office', 'ppt-features.pptx'));
    expect(pptx.slides.flatMap((s) => s.shapes).find((s) => s.connector)?.connector).toMatchObject({ kind: 'bent', elbows: 4 });
  });
  it('doc: a shape with an arrow is drawn as an outline', async () => {
    const model = await parseDocument('doc', blobOf('office', 'word-features.doc'), {});
    const canvases = model.blocks.filter((b): b is Extract<Block, { k: 'canvas' }> => b.k === 'canvas');
    const arrow = canvases.flatMap((c) => c.shapes).find((s) => shapeText(s) === '[W26-B] Стрелка');
    expect(arrow).toMatchObject({ geom: 'rightArrow', fill: '#156082' });
  });
});
