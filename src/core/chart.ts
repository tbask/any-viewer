/**
 * Chart model and parser of its description in Office files (DrawingML Chart: xlsx, docx, pptx).
 * Next to the formulas the file stores cached series values; those are drawn, formulas are not recalculated.
 */
import { attr, child, childrenOf, localName, textContent, type XmlNode } from './xml';

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'radar';

export interface ChartSeries {
  kind: ChartKind;
  name?: string;
  values: (number | null)[];
  /** X-axis values (scatter chart). */
  x?: (number | null)[];
  color?: string;
  /** Colours of individual points (pie chart slices). */
  pointColors?: (string | undefined)[];
  /** The series is plotted on the secondary axis. */
  secondary?: boolean;
  /** The line has point markers. */
  markers?: boolean;
  /** Smoothed line. */
  smooth?: boolean;
  /** Value labels above the points. */
  labels?: boolean;
}

export interface ChartModel {
  title?: string;
  categories: string[];
  series: ChartSeries[];
  /** Bars are horizontal (bar chart). */
  horizontal?: boolean;
  stacking?: 'stacked' | 'percent';
  /** Doughnut chart: hole share 0–1. */
  hole?: number;
  legend?: 'r' | 'l' | 't' | 'b';
  xTitle?: string;
  yTitle?: string;
  /** Number format of the value axis (Excel format code). */
  valueFormat?: string;
  /** Number format of the categories when they are numbers (dates on a date axis). */
  categoryFormat?: string;
  /** Document theme colours for series without their own colour. */
  palette: string[];
}

export const DEFAULT_PALETTE = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];

/** Colour of the series number index: six theme colours, then their shades, as in Office. */
export function paletteColor(palette: string[], index: number): string {
  const base = palette[index % palette.length] ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
  const round = Math.floor(index / palette.length);
  if (!round) return base;
  const n = parseInt(base.slice(1), 16);
  const k = round % 2 ? 0.6 : 1.35;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(k < 1 ? v * k : v + (255 - v) * (k - 1))));
  return `#${((1 << 24) | (ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)}`;
}

function descend(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = node;
  for (const name of path) cur = child(cur, name);
  return cur;
}

function richText(node: XmlNode | undefined): string {
  if (!node) return '';
  const paras: string[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === '#text') continue;
      const name = localName(c.name);
      if (name === 'p') {
        let line = '';
        const runs = (p: XmlNode) => {
          for (const r of p.children) {
            if (r.name === '#text') continue;
            if (localName(r.name) === 't') line += textContent(r);
            else runs(r);
          }
        };
        runs(c);
        if (line) paras.push(line);
      } else walk(c);
    }
  };
  walk(node);
  return paras.join(' ');
}

/** Cached values of a reference: strings or numbers by point index. */
function cachedPoints(ref: XmlNode | undefined): { count: number; values: Map<number, string>; format?: string } {
  const cache = child(ref, 'numCache') ?? child(ref, 'strCache') ?? child(ref, 'numLit') ?? child(ref, 'strLit') ?? child(child(ref, 'multiLvlStrCache'), 'lvl');
  const values = new Map<number, string>();
  let max = -1;
  for (const pt of childrenOf(cache, 'pt')) {
    const idx = Number(attr(pt, 'idx'));
    if (!Number.isFinite(idx) || idx < 0 || idx > 100_000) continue;
    values.set(idx, textContent(child(pt, 'v')));
    if (idx > max) max = idx;
  }
  const declared = Number(attr(child(cache, 'ptCount'), 'val'));
  return { count: Math.min(Math.max(Number.isFinite(declared) ? declared : 0, max + 1), 100_000), values, format: textContent(child(cache, 'formatCode')) || undefined };
}

function numbers(ref: XmlNode | undefined): { list: (number | null)[]; format?: string } {
  const { count, values, format } = cachedPoints(child(ref, 'numRef') ?? ref);
  const list: (number | null)[] = [];
  for (let i = 0; i < count; i++) {
    const raw = values.get(i);
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    list.push(Number.isFinite(n) ? n : null);
  }
  return { list, format };
}

function strings(ref: XmlNode | undefined): string[] {
  const inner = child(ref, 'strRef') ?? child(ref, 'numRef') ?? child(ref, 'multiLvlStrRef') ?? ref;
  const { count, values } = cachedPoints(inner);
  const list: string[] = [];
  for (let i = 0; i < count; i++) list.push(values.get(i) ?? '');
  return list;
}

export type ColorResolver = (node: XmlNode | undefined) => string | undefined;

/** Colour from srgbClr or schemeClr with the theme palette applied. */
export function makeColorResolver(theme: Record<string, string>): ColorResolver {
  return (node) => {
    if (!node) return undefined;
    const srgb = child(node, 'srgbClr');
    const scheme = child(node, 'schemeClr');
    const sys = child(node, 'sysClr');
    const holder = srgb ?? scheme ?? sys;
    let color: string | undefined;
    if (srgb) color = `#${(attr(srgb, 'val') ?? '').toLowerCase()}`;
    else if (scheme) {
      const key = attr(scheme, 'val') ?? '';
      color = theme[{ tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }[key] ?? key];
    } else if (sys) color = `#${(attr(sys, 'lastClr') ?? '000000').toLowerCase()}`;
    if (!color || !/^#[0-9a-f]{6}$/.test(color)) return undefined;
    // Lightening and darkening: lumMod/lumOff, tint, shade.
    const mod = Number(attr(child(holder, 'lumMod'), 'val') ?? 100000) / 100000;
    const off = Number(attr(child(holder, 'lumOff'), 'val') ?? 0) / 100000;
    const tint = attr(child(holder, 'tint'), 'val');
    const shade = attr(child(holder, 'shade'), 'val');
    if (mod !== 1 || off !== 0 || tint || shade) {
      const n = parseInt(color.slice(1), 16);
      const ch = (v: number) => {
        let x = v / 255;
        x = x * mod + off;
        if (tint) x = x + (1 - x) * (1 - Number(tint) / 100000);
        if (shade) x = x * (Number(shade) / 100000);
        return Math.max(0, Math.min(255, Math.round(x * 255)));
      };
      color = `#${((1 << 24) | (ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)}`;
    }
    return color;
  };
}

/** Theme colours by name (dk1, lt1, accent1, …) from theme1.xml. */
export function readThemeColors(themeRoot: XmlNode | undefined): Record<string, string> {
  const scheme = descend(themeRoot, 'themeElements', 'clrScheme');
  const out: Record<string, string> = {};
  for (const node of childrenOf(scheme)) {
    const value = attr(child(node, 'srgbClr'), 'val') ?? attr(child(node, 'sysClr'), 'lastClr');
    if (value) out[localName(node.name)] = `#${value.toLowerCase()}`;
  }
  return out;
}

const KINDS: Record<string, ChartKind> = {
  barChart: 'bar', bar3DChart: 'bar', lineChart: 'line', line3DChart: 'line', stockChart: 'line', areaChart: 'area', area3DChart: 'area',
  surfaceChart: 'line', surface3DChart: 'line',
  pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'pie', ofPieChart: 'pie', scatterChart: 'scatter', bubbleChart: 'scatter', radarChart: 'radar',
};

/**
 * Newer chart types (chartex). No exact likeness: waterfall is shown as columns of increments,
 * funnel as horizontal bars, treemap and sunburst as a pie of shares,
 * histogram as columns per bin. Box-and-whisker and maps are not drawn.
 */
function parseChartEx(space: XmlNode | undefined, chart: XmlNode | undefined, palette: string[]): ChartModel | undefined {
  const data = new Map<string, { categories: string[]; values: (number | null)[] }>();
  for (const item of childrenOf(child(space, 'chartData'), 'data')) {
    const entry = { categories: [] as string[], values: [] as (number | null)[] };
    for (const dim of item.children) {
      const tag = localName(dim.name);
      if (tag !== 'strDim' && tag !== 'numDim') continue;
      // Hierarchical charts have several levels; take the most detailed one (it is stored first).
      const level = childrenOf(dim, 'lvl')[0];
      const type = attr(dim, 'type');
      for (const pt of childrenOf(level, 'pt')) {
        const idx = Number(attr(pt, 'idx'));
        if (!Number.isFinite(idx) || idx < 0 || idx > 20_000) continue;
        if (tag === 'strDim' && type === 'cat') entry.categories[idx] = textContent(pt);
        else if (tag === 'numDim' && (type === 'val' || type === 'size')) entry.values[idx] = Number.isFinite(Number(textContent(pt))) ? Number(textContent(pt)) : null;
      }
    }
    data.set(attr(item, 'id') ?? '0', entry);
  }
  const model: ChartModel = { categories: [], series: [], palette };
  const region = child(child(chart, 'plotArea'), 'plotAreaRegion');
  for (const ser of childrenOf(region, 'series')) {
    const layout = attr(ser, 'layoutId') ?? '';
    const source = data.get(attr(child(ser, 'dataId'), 'val') ?? '0');
    if (!source || layout === 'boxWhisker' || layout === 'regionMap' || layout === 'paretoLine') continue;
    let values = Array.from(source.values, (v) => v ?? null);
    let categories = Array.from(source.categories, (c) => c ?? '');
    let kind: ChartKind = 'bar';
    if (layout === 'treemap' || layout === 'sunburst') kind = 'pie';
    else if (layout === 'funnel') model.horizontal = true;
    else if (layout === 'clusteredColumn' && !categories.some(Boolean)) {
      // Histogram: the source numbers are distributed into bins of equal width.
      const numbers = values.filter((v): v is number => v !== null);
      if (numbers.length < 2) continue;
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      const bins = Math.max(2, Math.min(20, Math.ceil(Math.sqrt(numbers.length))));
      const width = (max - min) / bins || 1;
      const counts = new Array<number>(bins).fill(0);
      for (const v of numbers) counts[Math.min(bins - 1, Math.floor((v - min) / width))]++;
      const round = (v: number) => Math.round(v * 100) / 100;
      values = counts;
      categories = counts.map((_, i) => `${round(min + i * width)}–${round(min + (i + 1) * width)}`);
    }
    if (!values.some((v) => v !== null)) continue;
    const series: ChartSeries = { kind, values };
    const name = textContent(child(child(ser, 'tx'), 'txData')).trim();
    if (name) series.name = name;
    if (!model.categories.length) model.categories = categories;
    if (model.series.length < 50) model.series.push(series);
  }
  if (!model.series.length) return undefined;
  if (!model.categories.length || !model.categories.some(Boolean)) model.categories = model.series[0].values.map((_, i) => String(i + 1));
  const title = richText(child(child(chart, 'title'), 'tx')) || textContent(child(child(chart, 'title'), 'tx')).trim();
  if (title) model.title = title;
  return model;
}

/** Parses chartSpace. Returns undefined if the chart has no series of a known kind. */
export function parseChart(root: XmlNode | undefined, theme: Record<string, string> = {}): ChartModel | undefined {
  const space = root && localName(root.name) === 'chartSpace' ? root : child(root, 'chartSpace');
  const chart = child(space, 'chart');
  const plot = child(chart, 'plotArea');
  if (!plot) return undefined;
  const color = makeColorResolver(theme);
  const palette = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((k, i) => theme[k] ?? DEFAULT_PALETTE[i]);
  // Office 2016+ charts (waterfall, funnel, histogram and others) are described differently.
  if (child(plot, 'plotAreaRegion')) return parseChartEx(space, chart, palette);
  const model: ChartModel = { categories: [], series: [], palette };

  const secondaryAxes = new Set<string>();
  const valAxes = childrenOf(plot, 'valAx');
  // The secondary value axis is the one that crosses the category axis "at the end".
  valAxes.forEach((ax, i) => {
    if (i > 0 && attr(child(ax, 'crosses'), 'val') === 'max') secondaryAxes.add(attr(child(ax, 'axId'), 'val') ?? '');
  });

  for (const group of plot.children) {
    if (group.name === '#text') continue;
    const tag = localName(group.name);
    const kind = KINDS[tag];
    if (!kind) continue;
    if (tag === 'doughnutChart') model.hole = Math.min(0.9, Math.max(0.1, Number(attr(child(group, 'holeSize'), 'val') ?? 50) / 100));
    if (kind === 'bar') {
      if (attr(child(group, 'barDir'), 'val') === 'bar') model.horizontal = true;
    }
    const grouping = attr(child(group, 'grouping'), 'val');
    if (grouping === 'stacked') model.stacking = 'stacked';
    else if (grouping === 'percentStacked') model.stacking = 'percent';
    const secondary = childrenOf(group, 'axId').some((a) => secondaryAxes.has(attr(a, 'val') ?? ''));
    const groupLabels = attr(child(child(group, 'dLbls'), 'showVal'), 'val') === '1';
    const scatterStyle = attr(child(group, 'scatterStyle'), 'val') ?? '';
    for (const ser of childrenOf(group, 'ser')) {
      const cats = strings(child(ser, 'cat'));
      if (cats.length > model.categories.length) {
        model.categories = cats;
        // Categories given as numbers with a format (dates): the renderer formats them like cell values.
        const catFormat = cachedPoints(child(child(ser, 'cat'), 'numRef')).format;
        model.categoryFormat = catFormat && catFormat !== 'General' ? catFormat : undefined;
      }
      const val = numbers(child(ser, kind === 'scatter' ? 'yVal' : 'val'));
      if (!model.valueFormat && val.format && val.format !== 'General') model.valueFormat = val.format;
      const sp = child(ser, 'spPr');
      const lineColor = color(child(child(sp, 'ln'), 'solidFill'));
      const fillColor = color(child(sp, 'solidFill'));
      const noLine = !!child(child(sp, 'ln'), 'noFill');
      const marker = child(ser, 'marker');
      const series: ChartSeries = {
        kind,
        name: strings(child(ser, 'tx')).join(' ') || textContent(descend(ser, 'tx', 'v')) || undefined,
        values: val.list,
        color: kind === 'line' || kind === 'scatter' || kind === 'radar' ? (lineColor ?? fillColor ?? color(child(child(marker, 'spPr'), 'solidFill'))) : (fillColor ?? lineColor),
      };
      if (kind === 'scatter') {
        series.x = numbers(child(ser, 'xVal')).list;
        series.markers = noLine || scatterStyle === 'marker' || scatterStyle === 'lineMarker' || tag === 'bubbleChart';
        if (noLine || scatterStyle === 'marker' || tag === 'bubbleChart') series.kind = 'scatter';
        series.smooth = scatterStyle.startsWith('smooth');
        (series as ChartSeries & { noLine?: boolean }).noLine = noLine || scatterStyle === 'marker' || tag === 'bubbleChart';
      }
      if (kind === 'line') {
        series.markers = !!marker && attr(child(marker, 'symbol'), 'val') !== 'none';
        series.smooth = attr(child(ser, 'smooth'), 'val') === '1';
      }
      if (secondary) series.secondary = true;
      const ownLabels = child(ser, 'dLbls');
      if (ownLabels ? attr(child(ownLabels, 'showVal'), 'val') === '1' || attr(child(ownLabels, 'showPercent'), 'val') === '1' : groupLabels || attr(child(child(group, 'dLbls'), 'showPercent'), 'val') === '1') series.labels = true;
      const points = childrenOf(ser, 'dPt');
      if (points.length) {
        series.pointColors = [];
        for (const pt of points) {
          const idx = Number(attr(child(pt, 'idx'), 'val'));
          const c = color(child(child(pt, 'spPr'), 'solidFill'));
          if (Number.isFinite(idx) && idx >= 0 && idx < 10_000 && c) series.pointColors[idx] = c;
        }
      }
      model.series.push(series);
    }
  }
  if (!model.series.length) return undefined;
  if (!model.categories.length) {
    const longest = Math.max(...model.series.map((s) => s.values.length));
    model.categories = Array.from({ length: longest }, (_, i) => String(i + 1));
  }

  const title = child(chart, 'title');
  const autoDeleted = attr(child(chart, 'autoTitleDeleted'), 'val') === '1';
  if (title) model.title = richText(child(title, 'tx')) || (model.series.length === 1 ? model.series[0].name : undefined);
  else if (!autoDeleted && model.series.length === 1 && model.series[0].kind === 'pie') model.title = model.series[0].name;
  const legend = child(chart, 'legend');
  if (legend) {
    const pos = attr(child(legend, 'legendPos'), 'val') ?? 'r';
    model.legend = pos === 'b' ? 'b' : pos === 't' ? 't' : pos === 'l' ? 'l' : 'r';
  }
  const catAxis = child(plot, 'catAx') ?? child(plot, 'dateAx') ?? valAxes[0];
  const valAxis = child(plot, 'catAx') || child(plot, 'dateAx') ? valAxes[0] : valAxes[1];
  const axisTitle = (ax: XmlNode | undefined) => richText(descend(ax, 'title', 'tx')) || undefined;
  model.xTitle = axisTitle(model.horizontal ? valAxis : catAxis);
  model.yTitle = axisTitle(model.horizontal ? catAxis : valAxis);
  const axisFormat = attr(child(valAxis, 'numFmt'), 'formatCode');
  if (axisFormat && axisFormat !== 'General') model.valueFormat = axisFormat;
  return model;
}
