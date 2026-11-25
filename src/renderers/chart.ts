/**
 * Draws a chart as SVG from the model read from the file. Sizes are given from outside; the content is vector,
 * and text from the file enters the document only as text nodes.
 */
import { paletteColor, type ChartModel, type ChartSeries } from '../core/chart';
import { createLocale, formatGeneral, formatValue, type NumFmtLocale } from '../core/numfmt';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#404040';
const MUTED = '#595959';
const GRID = '#d9d9d9';

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A "round" step for axis ticks. */
function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

interface Scale {
  min: number;
  max: number;
  step: number;
}

export function axisScale(lo: number, hi: number, ticks = 6): Scale {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, step: 0.2 };
  // The value axis starts at zero unless the data lies too far from it, as in Excel.
  if (lo > 0 && lo < hi * 0.84) lo = 0;
  if (hi < 0 && hi > lo * 0.84) hi = 0;
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  const step = niceStep(hi - lo, ticks);
  let min = Math.floor(lo / step + 1e-9) * step;
  let max = Math.ceil(hi / step - 1e-9) * step;
  // Headroom at the top so that the tallest column does not touch the edge.
  if (max === hi && hi > 0) max += step;
  if (min === lo && lo < 0) min -= step;
  return { min, max, step };
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

export function renderChart(source: ChartModel, width: number, height: number, lang?: string): SVGSVGElement {
  const locale: NumFmtLocale = createLocale(lang);
  // Numeric categories with a number format (dates on an axis) are shown formatted, not as serial numbers.
  const categoryFormat = source.categoryFormat;
  const model: ChartModel = categoryFormat ? { ...source, categories: source.categories.map((c) => (c !== '' && Number.isFinite(Number(c)) ? formatValue(Number(c), categoryFormat, locale) : c)) } : source;
  const svg = node('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  svg.style.display = 'block';
  svg.style.fontFamily = 'Calibri, "Segoe UI", Arial, sans-serif';
  svg.appendChild(node('rect', { x: 0.5, y: 0.5, width: width - 1, height: height - 1, fill: '#ffffff', stroke: GRID }));
  const font = Math.max(8, Math.min(12, Math.round(Math.min(width, height) / 26)));
  const fmt = (v: number, percent = false): string => {
    if (percent) return `${Math.round(v * 100)}%`;
    if (model.valueFormat) {
      try {
        return formatValue(v, model.valueFormat, locale).trim();
      } catch {
        /* non-standard format code: output as is */
      }
    }
    return formatGeneral(Math.abs(v) >= 1e6 || Number.isInteger(v) ? v : Number(v.toPrecision(6)), locale);
  };
  const seriesColor = (s: ChartSeries, i: number) => s.color ?? paletteColor(model.palette, i);

  let top = 8;
  let bottom = height - 8;
  let left = 8;
  let right = width - 8;
  if (model.title) {
    const size = Math.round(font * 1.35);
    svg.appendChild(node('text', { x: width / 2, y: top + size, 'text-anchor': 'middle', 'font-size': size, fill: MUTED }, truncate(model.title, Math.floor(width / (size * 0.55)))));
    top += size + 12;
  }

  const isPie = model.series.every((s) => s.kind === 'pie');
  // --- legend ---
  const legendItems = isPie
    ? model.categories.map((c, i) => ({ label: c, color: model.series[0].pointColors?.[i] ?? paletteColor(model.palette, i), line: false }))
    : model.series.map((s, i) => ({ label: s.name ?? `${i + 1}`, color: seriesColor(s, i), line: s.kind === 'line' || s.kind === 'radar' || (s.kind === 'scatter' && !(s as { noLine?: boolean }).noLine) }));
  if (model.legend && legendItems.length && (isPie || model.series.length > 0)) {
    const g = node('g', { 'font-size': font, fill: MUTED });
    const mark = (x: number, y: number, item: (typeof legendItems)[number]) => {
      if (item.line) g.appendChild(node('line', { x1: x, y1: y, x2: x + 16, y2: y, stroke: item.color, 'stroke-width': 2.2 }));
      else g.appendChild(node('rect', { x: x + 3, y: y - 4.5, width: 9, height: 9, fill: item.color }));
    };
    if (model.legend === 'b' || model.legend === 't') {
      const maxChars = Math.max(6, Math.floor(width / legendItems.length / (font * 0.55)) - 4);
      const widths = legendItems.map((it) => 26 + truncate(it.label, maxChars).length * font * 0.55);
      // Wrap into rows when it does not fit into one.
      const lines: number[][] = [[]];
      let used = 0;
      widths.forEach((w, i) => {
        if (used + w > width - 16 && lines[lines.length - 1].length) {
          lines.push([]);
          used = 0;
        }
        lines[lines.length - 1].push(i);
        used += w;
      });
      const lineH = font + 6;
      const blockH = Math.min(lines.length, 4) * lineH;
      const y0 = model.legend === 'b' ? bottom - blockH + lineH / 2 : top + lineH / 2;
      lines.slice(0, 4).forEach((line, li) => {
        const total = line.reduce((s, i) => s + widths[i], 0);
        let x = (width - total) / 2;
        for (const i of line) {
          mark(x, y0 + li * lineH, legendItems[i]);
          g.appendChild(node('text', { x: x + 20, y: y0 + li * lineH + font * 0.35 }, truncate(legendItems[i].label, maxChars)));
          x += widths[i];
        }
      });
      if (model.legend === 'b') bottom -= blockH + 6;
      else top += blockH + 6;
    } else {
      const maxChars = Math.max(6, Math.floor((width * 0.28) / (font * 0.55)));
      const longest = Math.max(...legendItems.map((it) => truncate(it.label, maxChars).length));
      const w = 26 + longest * font * 0.55;
      const lineH = font + 7;
      const shown = legendItems.slice(0, Math.max(1, Math.floor((bottom - top) / lineH)));
      const x = model.legend === 'l' ? left : right - w;
      let y = (top + bottom) / 2 - (shown.length * lineH) / 2 + lineH / 2;
      for (const item of shown) {
        mark(x, y, item);
        g.appendChild(node('text', { x: x + 20, y: y + font * 0.35 }, truncate(item.label, maxChars)));
        y += lineH;
      }
      if (model.legend === 'l') left += w + 8;
      else right -= w + 8;
    }
    svg.appendChild(g);
  }

  // --- pie and doughnut ---
  if (isPie) {
    const s = model.series[0];
    const values = s.values.map((v) => (v !== null && v > 0 ? v : 0));
    const total = values.reduce((a, b) => a + b, 0);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const r = Math.max(10, Math.min(right - left, bottom - top) / 2 - (s.labels ? font + 4 : 4));
    const hole = model.hole ? r * model.hole : 0;
    let angle = -Math.PI / 2;
    const point = (a: number, rad: number) => `${(cx + Math.cos(a) * rad).toFixed(2)} ${(cy + Math.sin(a) * rad).toFixed(2)}`;
    values.forEach((v, i) => {
      if (!total || !v) return;
      const sweep = (v / total) * Math.PI * 2;
      const end = angle + sweep;
      const fill = s.pointColors?.[i] ?? paletteColor(model.palette, i);
      if (sweep >= Math.PI * 2 - 1e-6) {
        svg.appendChild(node('circle', { cx, cy, r: hole ? (r + hole) / 2 : r, fill: hole ? 'none' : fill, stroke: hole ? fill : '#ffffff', 'stroke-width': hole ? r - hole : 1 }));
      } else {
        const large = sweep > Math.PI ? 1 : 0;
        const d = hole
          ? `M ${point(angle, r)} A ${r} ${r} 0 ${large} 1 ${point(end, r)} L ${point(end, hole)} A ${hole} ${hole} 0 ${large} 0 ${point(angle, hole)} Z`
          : `M ${cx} ${cy} L ${point(angle, r)} A ${r} ${r} 0 ${large} 1 ${point(end, r)} Z`;
        svg.appendChild(node('path', { d, fill, stroke: '#ffffff', 'stroke-width': 1 }));
      }
      if (s.labels && sweep > 0.12) {
        const mid = angle + sweep / 2;
        const lr = hole ? (r + hole) / 2 : r * 0.68;
        svg.appendChild(node('text', { x: cx + Math.cos(mid) * lr, y: cy + Math.sin(mid) * lr + font * 0.35, 'text-anchor': 'middle', 'font-size': font, fill: '#ffffff' }, `${Math.round((v / total) * 100)}%`));
      }
      angle = end;
    });
    return svg;
  }

  // --- radar ---
  if (model.series.every((s) => s.kind === 'radar')) {
    const n = model.categories.length;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const r = Math.max(10, Math.min(right - left, bottom - top) / 2 - font * 2);
    const all = model.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const scale = axisScale(Math.min(0, ...all), Math.max(...all, 0), 4);
    const at = (i: number, v: number) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const rr = ((v - scale.min) / (scale.max - scale.min)) * r;
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
    };
    for (let v = scale.min + scale.step; v <= scale.max + 1e-9; v += scale.step) {
      svg.appendChild(node('polygon', { points: Array.from({ length: n }, (_, i) => at(i, v).map((x) => x.toFixed(1)).join(',')).join(' '), fill: 'none', stroke: GRID }));
    }
    model.categories.forEach((c, i) => {
      const [x, y] = at(i, scale.max * 1.08 - scale.min * 0.08);
      svg.appendChild(node('text', { x, y: y + font * 0.35, 'text-anchor': 'middle', 'font-size': font, fill: MUTED }, truncate(c, 14)));
    });
    model.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => at(i, v ?? scale.min).map((x) => x.toFixed(1)).join(',')).join(' ');
      svg.appendChild(node('polygon', { points: pts, fill: 'none', stroke: seriesColor(s, si), 'stroke-width': 2 }));
    });
    return svg;
  }

  // --- charts with axes ---
  const isScatter = model.series.every((s) => s.kind === 'scatter' || !!s.x);
  const n = model.categories.length;
  const percent = model.stacking === 'percent';
  const stacked = !!model.stacking;
  const primary = model.series.filter((s) => !s.secondary);
  const secondary = model.series.filter((s) => s.secondary);

  /** Value bounds of a series group, taking stacking into account. */
  const extent = (list: ChartSeries[]): [number, number] => {
    if (percent) return [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    const stackable = list.filter((s) => s.kind === 'bar' || s.kind === 'area');
    if (stacked && stackable.length) {
      for (let i = 0; i < n; i++) {
        let pos = 0;
        let neg = 0;
        for (const s of stackable) {
          const v = s.values[i] ?? 0;
          if (v >= 0) pos += v;
          else neg += v;
        }
        hi = Math.max(hi, pos);
        lo = Math.min(lo, neg);
      }
    }
    for (const s of list) {
      if (stacked && (s.kind === 'bar' || s.kind === 'area')) continue;
      for (const v of s.values) {
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return [lo, hi];
  };
  const [lo1, hi1] = extent(primary.length ? primary : model.series);
  const yScale = percent ? { min: 0, max: 1, step: 0.2 } : axisScale(lo1, hi1, Math.max(3, Math.floor((bottom - top) / 34)));
  let y2Scale: Scale | undefined;
  if (secondary.length && primary.length) {
    const [lo2, hi2] = extent(secondary);
    y2Scale = axisScale(lo2, hi2, Math.max(3, Math.floor((bottom - top) / 34)));
  }
  let xScale: Scale | undefined;
  if (isScatter) {
    const xs = model.series.flatMap((s) => (s.x ?? []).filter((v): v is number => v !== null));
    xScale = axisScale(Math.min(...xs), Math.max(...xs), Math.max(3, Math.floor((right - left) / 70)));
  }

  const ticks = (s: Scale) => {
    const out: number[] = [];
    for (let k = 0; k <= Math.round((s.max - s.min) / s.step) && k < 60; k++) out.push(s.min + k * s.step);
    return out;
  };
  const yTicks = ticks(yScale);
  const yLabels = yTicks.map((v) => fmt(Number(v.toPrecision(12)), percent));
  const horizontal = !!model.horizontal && !isScatter;

  // Margins for axis labels.
  if (model.yTitle) left += font + 8;
  if (model.xTitle) bottom -= font + 8;
  const valueLabelW = Math.max(...yLabels.map((l) => l.length)) * font * 0.58 + 8;
  const catChars = Math.max(1, ...model.categories.map((c) => c.length));
  if (horizontal) {
    left += Math.min((right - left) * 0.35, catChars * font * 0.58 + 10);
    bottom -= font + 8;
  } else {
    left += valueLabelW;
    bottom -= font + 8;
    if (y2Scale) right -= Math.max(...ticks(y2Scale).map((v) => fmt(v).length)) * font * 0.58 + 8;
  }
  const plotW = Math.max(20, right - left);
  const plotH = Math.max(20, bottom - top);
  const g = node('g', { 'font-size': font, fill: MUTED });
  svg.appendChild(g);

  /** Position of a value along the value axis (pixels from the start of the plot area). */
  const along = (v: number, s: Scale, length: number) => ((v - s.min) / (s.max - s.min)) * length;
  const valueX = (v: number, s = yScale) => left + along(v, s, plotW);
  const valueY = (v: number, s = yScale) => bottom - along(v, s, plotH);

  // Grid and value axis labels.
  yTicks.forEach((v, k) => {
    if (horizontal) {
      const x = valueX(v);
      g.appendChild(node('line', { x1: x, y1: top, x2: x, y2: bottom, stroke: GRID }));
      g.appendChild(node('text', { x, y: bottom + font + 4, 'text-anchor': 'middle' }, yLabels[k]));
    } else {
      const y = valueY(v);
      g.appendChild(node('line', { x1: left, y1: y, x2: right, y2: y, stroke: GRID }));
      g.appendChild(node('text', { x: left - 6, y: y + font * 0.35, 'text-anchor': 'end' }, yLabels[k]));
    }
  });
  if (y2Scale && !horizontal) {
    for (const v of ticks(y2Scale)) g.appendChild(node('text', { x: right + 6, y: valueY(v, y2Scale) + font * 0.35 }, fmt(Number(v.toPrecision(12)))));
  }
  if (model.yTitle) {
    const cy = (top + bottom) / 2;
    g.appendChild(node('text', { x: 14, y: cy, 'text-anchor': 'middle', transform: `rotate(-90 14 ${cy})` }, truncate(model.yTitle, 40)));
  }
  if (model.xTitle) g.appendChild(node('text', { x: (left + right) / 2, y: height - 10, 'text-anchor': 'middle' }, truncate(model.xTitle, 60)));

  // Category labels.
  const band = (horizontal ? plotH : plotW) / Math.max(1, n);
  if (isScatter && xScale) {
    for (const v of ticks(xScale)) {
      const x = left + along(v, xScale, plotW);
      g.appendChild(node('text', { x, y: bottom + font + 4, 'text-anchor': 'middle' }, fmt(Number(v.toPrecision(12)))));
    }
  } else if (horizontal) {
    const every = Math.max(1, Math.ceil((font + 4) / band));
    model.categories.forEach((c, i) => {
      if (i % every) return;
      // As in Excel: the first category is at the bottom.
      const y = bottom - band * (i + 0.5);
      g.appendChild(node('text', { x: left - 6, y: y + font * 0.35, 'text-anchor': 'end' }, truncate(c, Math.floor((left - 12) / (font * 0.58)))));
    });
  } else {
    const maxChars = Math.max(3, Math.floor(band / (font * 0.58)));
    const every = Math.max(1, Math.ceil((Math.min(catChars, 8) * font * 0.58 + 6) / band));
    model.categories.forEach((c, i) => {
      if (i % every) return;
      g.appendChild(node('text', { x: left + band * (i + 0.5), y: bottom + font + 4, 'text-anchor': 'middle' }, truncate(c, Math.max(maxChars * every, 4))));
    });
  }

  const zero = (s: Scale) => Math.min(Math.max(0, s.min), s.max);
  const label = (x: number, y: number, v: number, anchor = 'middle') => g.appendChild(node('text', { x, y, 'text-anchor': anchor, fill: INK }, fmt(v)));

  // --- bars ---
  const bars = model.series.filter((s) => s.kind === 'bar');
  if (bars.length) {
    const groups = stacked ? 1 : bars.length;
    const inner = band * 0.68;
    const barSize = inner / groups;
    const posTotals = new Array<number>(n).fill(0);
    const negTotals = new Array<number>(n).fill(0);
    const sums = percent ? Array.from({ length: n }, (_, i) => bars.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0)) : [];
    bars.forEach((s, bi) => {
      const si = model.series.indexOf(s);
      const scale = s.secondary && y2Scale ? y2Scale : yScale;
      const fill = seriesColor(s, si);
      for (let i = 0; i < n; i++) {
        let v = s.values[i];
        if (v === null || v === undefined) continue;
        const raw = v;
        if (percent) v = sums[i] ? v / sums[i] : 0;
        let from = zero(scale);
        let to = v;
        if (stacked) {
          from = v >= 0 ? posTotals[i] : negTotals[i];
          to = from + v;
          if (v >= 0) posTotals[i] = to;
          else negTotals[i] = to;
        }
        const offset = band * i + (band - inner) / 2 + (stacked ? 0 : bi * barSize);
        const fillColor = s.pointColors?.[i] ?? fill;
        if (horizontal) {
          const x0 = valueX(Math.min(from, to), scale);
          const x1 = valueX(Math.max(from, to), scale);
          const y = bottom - offset - barSize;
          g.appendChild(node('rect', { x: x0, y, width: Math.max(0.5, x1 - x0), height: Math.max(1, barSize - 1), fill: fillColor }));
          if (s.labels) label(x1 + 4, y + barSize / 2 + font * 0.35, raw, 'start');
        } else {
          const y0 = valueY(Math.max(from, to), scale);
          const y1 = valueY(Math.min(from, to), scale);
          const x = left + offset;
          g.appendChild(node('rect', { x, y: y0, width: Math.max(1, barSize - 1), height: Math.max(0.5, y1 - y0), fill: fillColor }));
          if (s.labels) label(x + barSize / 2, stacked ? (y0 + y1) / 2 + font * 0.35 : y0 - 4, raw);
        }
      }
    });
  }

  // --- areas, lines, points ---
  const areaTotals = new Array<number>(n).fill(0);
  model.series.forEach((s, si) => {
    if (s.kind === 'bar' || s.kind === 'pie') return;
    const scale = s.secondary && y2Scale ? y2Scale : yScale;
    const stroke = seriesColor(s, si);
    const pts: [number, number, number][] = [];
    const base: [number, number][] = [];
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      let x: number;
      if (isScatter && xScale) {
        const xv = s.x?.[i];
        if (xv === null || xv === undefined) return;
        x = left + along(xv, xScale, plotW);
      } else x = left + band * (i + 0.5);
      let value = v;
      if (s.kind === 'area' && stacked) {
        base.push([x, valueY(areaTotals[i], scale)]);
        areaTotals[i] += v;
        value = areaTotals[i];
      }
      pts.push([x, valueY(value, scale), v]);
    });
    if (!pts.length) return;
    const path = pts.map((p, k) => `${k ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    if (s.kind === 'area') {
      const floor = base.length ? base.reverse().map((p) => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') : `L ${pts[pts.length - 1][0].toFixed(1)} ${valueY(zero(scale), scale)} L ${pts[0][0].toFixed(1)} ${valueY(zero(scale), scale)}`;
      g.appendChild(node('path', { d: `${path} ${floor} Z`, fill: stroke, 'fill-opacity': 0.85 }));
      return;
    }
    const noLine = (s as { noLine?: boolean }).noLine;
    if (!noLine) g.appendChild(node('path', { d: path, fill: 'none', stroke, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (s.markers || noLine || pts.length === 1) for (const p of pts) g.appendChild(node('circle', { cx: p[0], cy: p[1], r: 3.2, fill: stroke }));
    if (s.labels) for (const p of pts) label(p[0], p[1] - 7, p[2]);
  });

  // Axes on top of the data.
  const axis = { stroke: '#bfbfbf' };
  if (horizontal) g.appendChild(node('line', { x1: valueX(zero(yScale)), y1: top, x2: valueX(zero(yScale)), y2: bottom, ...axis }));
  else g.appendChild(node('line', { x1: left, y1: valueY(zero(yScale)), x2: right, y2: valueY(zero(yScale)), ...axis }));
  return svg;
}
