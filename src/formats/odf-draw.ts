/**
 * OpenDocument graphics shared by odt, ods and odp: shape outlines (draw:enhanced-geometry) and charts.
 * A shape outline in these files is given by drawing commands with formulas; the formulas are evaluated here
 * and the result becomes a simple path of segments and curves as fractions of the shape frame.
 */
import { DEFAULT_PALETTE, type ChartKind, type ChartModel, type ChartSeries } from '../core/chart';
import { child, childrenOf, decodeXmlBytes, localName, parseXml, type XmlNode } from '../core/xml';
import type { ZipReader } from '../core/zip';

// --- formulas ---

type Lookup = (name: string) => number;

/** Evaluates a draw:formula expression. ?name and $number references are resolved by lookup. */
function evaluate(source: string, lookup: Lookup): number {
  let pos = 0;
  const peek = () => {
    while (source[pos] === ' ') pos++;
    return source[pos];
  };
  const expr = (): number => {
    let value = term();
    for (;;) {
      const ch = peek();
      if (ch === '+') { pos++; value += term(); }
      else if (ch === '-') { pos++; value -= term(); }
      else return value;
    }
  };
  const term = (): number => {
    let value = factor();
    for (;;) {
      const ch = peek();
      if (ch === '*') { pos++; value *= factor(); }
      else if (ch === '/') { pos++; const d = factor(); value = d === 0 ? 0 : value / d; }
      else return value;
    }
  };
  const factor = (): number => {
    const ch = peek();
    if (ch === undefined) return 0;
    if (ch === '-') { pos++; return -factor(); }
    if (ch === '+') { pos++; return factor(); }
    if (ch === '(') {
      pos++;
      const value = expr();
      if (peek() === ')') pos++;
      return value;
    }
    if (ch === '?' || ch === '$') {
      const start = pos++;
      while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos])) pos++;
      return lookup(source.slice(start, pos));
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]*(?:[eE][-+]?[0-9]+)?/.exec(source.slice(pos));
      pos += m ? m[0].length : 1;
      return m ? Number(m[0]) || 0 : 0;
    }
    if (/[A-Za-z]/.test(ch)) {
      const start = pos;
      while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos])) pos++;
      const name = source.slice(start, pos);
      if (peek() !== '(') return lookup(name);
      pos++;
      const args: number[] = [];
      while (peek() !== undefined && peek() !== ')') {
        args.push(expr());
        if (peek() === ',') pos++;
      }
      if (peek() === ')') pos++;
      const [a = 0, b = 0, c = 0] = args;
      switch (name) {
        case 'abs': return Math.abs(a);
        case 'sqrt': return Math.sqrt(Math.max(0, a));
        case 'sin': return Math.sin(a);
        case 'cos': return Math.cos(a);
        case 'tan': return Math.tan(a);
        case 'atan': return Math.atan(a);
        case 'atan2': return Math.atan2(a, b);
        case 'min': return Math.min(a, b);
        case 'max': return Math.max(a, b);
        case 'if': return a > 0 ? b : c;
        default: return 0;
      }
    }
    pos++;
    return 0;
  };
  const value = expr();
  return Number.isFinite(value) ? value : 0;
}

/** Ellipse arc as Bézier curves: angles in radians, clockwise on screen. */
function arcCurves(cx: number, cy: number, rx: number, ry: number, from: number, sweep: number, out: number[][]): void {
  // An arc never needs more than a full turn; without this limit a malformed angle would produce millions of curves.
  if (!Number.isFinite(sweep) || !Number.isFinite(from)) return;
  if (Math.abs(sweep) > Math.PI * 2) sweep = Math.sign(sweep) * (Math.abs(sweep) % (Math.PI * 2) || Math.PI * 2);
  const parts = Math.max(1, Math.min(8, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)));
  const step = sweep / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < parts; i++) {
    const a = from + step * i;
    const b = a + step;
    out.push([
      cx + rx * (Math.cos(a) - k * Math.sin(a)), cy + ry * (Math.sin(a) + k * Math.cos(a)),
      cx + rx * (Math.cos(b) + k * Math.sin(b)), cy + ry * (Math.sin(b) - k * Math.cos(b)),
      cx + rx * Math.cos(b), cy + ry * Math.sin(b),
    ]);
  }
}

/**
 * Shape outline from draw:enhanced-geometry: M, L, C, Z commands with coordinates as fractions of the frame (0–1).
 * undefined: there is no outline or it was not parsed (the shape is then drawn as a rectangle).
 */
export function odfShapePath(geometry: XmlNode | undefined): (string | number)[] | undefined {
  const source = geometry?.attrs['draw:enhanced-path'];
  if (!geometry || !source) return undefined;
  const box = (geometry.attrs['svg:viewBox'] ?? '0 0 21600 21600').trim().split(/[\s,]+/).map(Number);
  const left = box[0] || 0;
  const top = box[1] || 0;
  const width = box[2] || 21600;
  const height = box[3] || 21600;
  const modifiers = (geometry.attrs['draw:modifiers'] ?? '').trim().split(/\s+/).map(Number);
  const formulas = new Map<string, string>();
  for (const eq of childrenOf(geometry, 'equation')) if (eq.attrs['draw:name']) formulas.set(eq.attrs['draw:name'], eq.attrs['draw:formula'] ?? '0');
  const cache = new Map<string, number>();
  const busy = new Set<string>();
  const lookup: Lookup = (name) => {
    if (name[0] === '$') return modifiers[Number(name.slice(1))] || 0;
    if (name[0] === '?') {
      const key = name.slice(1);
      const known = cache.get(key);
      if (known !== undefined) return known;
      const formula = formulas.get(key);
      if (formula === undefined || busy.has(key) || busy.size > 200) return 0;
      busy.add(key);
      const value = evaluate(formula, lookup);
      busy.delete(key);
      cache.set(key, value);
      return value;
    }
    switch (name) {
      case 'pi': return Math.PI;
      case 'left': return left;
      case 'top': return top;
      case 'right': return left + width;
      case 'bottom': return top + height;
      case 'width': case 'logwidth': return width;
      case 'height': case 'logheight': return height;
      case 'hasstroke': case 'hasfill': return 1;
      default: return 0;
    }
  };

  const tokens = source.trim().split(/[\s,]+/).filter(Boolean);
  const out: (string | number)[] = [];
  const nx = (x: number) => (x - left) / width;
  const ny = (y: number) => (y - top) / height;
  let cx = 0;
  let cy = 0;
  let command = '';
  let i = 0;
  let count = 0;
  const isCommand = (t: string) => /^[A-Za-z]$/.test(t);
  const take = (n: number): number[] | undefined => {
    if (i + n > tokens.length) return undefined;
    const values: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = tokens[i + k];
      if (isCommand(t)) return undefined;
      values.push(t[0] === '?' || t[0] === '$' ? lookup(t) : Number(t) || 0);
    }
    i += n;
    return values;
  };
  const moveTo = (x: number, y: number) => { out.push('M', nx(x), ny(y)); cx = x; cy = y; };
  const lineTo = (x: number, y: number) => { out.push('L', nx(x), ny(y)); cx = x; cy = y; };
  const curves = (list: number[][]) => {
    for (const c of list) {
      out.push('C', nx(c[0]), ny(c[1]), nx(c[2]), ny(c[3]), nx(c[4]), ny(c[5]));
      cx = c[4];
      cy = c[5];
    }
  };
  let guard = 0;
  while (i < tokens.length && guard++ < 20000 && out.length < 60000) {
    if (isCommand(tokens[i])) {
      command = tokens[i++];
      count = 0;
      if (command === 'Z') out.push('Z');
      continue;
    }
    switch (command) {
      case 'M': {
        const p = take(2);
        if (!p) { i++; break; }
        // After the first "move to" pair the remaining pairs are segments.
        if (count++ === 0) moveTo(p[0], p[1]);
        else lineTo(p[0], p[1]);
        break;
      }
      case 'L': {
        const p = take(2);
        if (!p) { i++; break; }
        lineTo(p[0], p[1]);
        break;
      }
      case 'C': {
        const p = take(6);
        if (!p) { i++; break; }
        curves([p]);
        break;
      }
      case 'Q': {
        const p = take(4);
        if (!p) { i++; break; }
        curves([[cx + ((p[0] - cx) * 2) / 3, cy + ((p[1] - cy) * 2) / 3, p[2] + ((p[0] - p[2]) * 2) / 3, p[3] + ((p[1] - p[3]) * 2) / 3, p[2], p[3]]]);
        break;
      }
      case 'X': case 'Y': {
        const p = take(2);
        if (!p) { i++; break; }
        // Quarter of an ellipse; the first starts along one axis, the next along the other.
        const alongX = (command === 'X') === (count++ % 2 === 0);
        const k = 0.5523;
        if (alongX) curves([[cx + k * (p[0] - cx), cy, p[0], p[1] - k * (p[1] - cy), p[0], p[1]]]);
        else curves([[cx, cy + k * (p[1] - cy), p[0] - k * (p[0] - cx), p[1], p[0], p[1]]]);
        break;
      }
      case 'A': case 'B': case 'W': case 'V': {
        const p = take(8);
        if (!p) { i++; break; }
        const ex = (p[0] + p[2]) / 2;
        const ey = (p[1] + p[3]) / 2;
        const rx = Math.abs(p[2] - p[0]) / 2;
        const ry = Math.abs(p[3] - p[1]) / 2;
        if (!rx || !ry) break;
        const a1 = Math.atan2((p[5] - ey) / ry, (p[4] - ex) / rx);
        const a2 = Math.atan2((p[7] - ey) / ry, (p[6] - ex) / rx);
        const clockwise = command === 'W' || command === 'V';
        let sweep = a2 - a1;
        if (clockwise) { while (sweep <= 1e-9) sweep += Math.PI * 2; }
        else { while (sweep >= -1e-9) sweep -= Math.PI * 2; }
        const sx = ex + rx * Math.cos(a1);
        const sy = ey + ry * Math.sin(a1);
        if (command === 'B' || command === 'V' || !out.length) moveTo(sx, sy);
        else lineTo(sx, sy);
        const list: number[][] = [];
        arcCurves(ex, ey, rx, ry, a1, sweep, list);
        curves(list);
        break;
      }
      case 'T': case 'U': {
        const p = take(6);
        if (!p) { i++; break; }
        const a1 = (p[4] * Math.PI) / 180;
        let sweep = ((p[5] - p[4]) * Math.PI) / 180;
        if (Math.abs(sweep) < 1e-9) sweep = Math.PI * 2;
        const sx = p[0] + p[2] * Math.cos(a1);
        const sy = p[1] + p[3] * Math.sin(a1);
        if (command === 'U' || !out.length) moveTo(sx, sy);
        else lineTo(sx, sy);
        const list: number[][] = [];
        arcCurves(p[0], p[1], p[2], p[3], a1, sweep, list);
        curves(list);
        break;
      }
      default:
        i++;
    }
  }
  // An outline of tens of thousands of points is not a shape outline: draw the frame instead.
  return out.length <= 20_000 && out.some((t) => t === 'L' || t === 'C') ? out : undefined;
}

/** true: the outline coincides with the shape frame (a plain rectangle): no need to draw it as a path. */
export function isPlainRectPath(path: (string | number)[]): boolean {
  if (path.includes('C')) return false;
  const numbers = path.filter((t): t is number => typeof t === 'number');
  if (numbers.length > 10 || !numbers.every((v) => Math.abs(v) < 1e-6 || Math.abs(v - 1) < 1e-6)) return false;
  // All four corners must be present: three of them make a triangle, not a rectangle.
  const corners = new Set<string>();
  for (let i = 0; i + 1 < numbers.length; i += 2) corners.add(`${Math.round(numbers[i])},${Math.round(numbers[i + 1])}`);
  return corners.size === 4;
}

// --- charts ---

const CHART_KINDS: Record<string, ChartKind> = { bar: 'bar', line: 'line', area: 'area', circle: 'pie', ring: 'pie', scatter: 'scatter', radar: 'radar', 'filled-radar': 'radar', bubble: 'scatter' };

function cellRef(ref: string): { r0: number; c0: number; r1: number; c1: number } | undefined {
  // An address like "local-table.$B$2:.$B$7" or "Sheet.B2:Sheet.B7".
  const cells = [...ref.matchAll(/\$?([A-Z]{1,3})\$?(\d+)/g)];
  if (!cells.length) return undefined;
  const col = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = cells[0];
  const b = cells[1] ?? a;
  return { r0: Number(a[2]) - 1, c0: col(a[1]), r1: Number(b[2]) - 1, c1: col(b[1]) };
}

/** Paragraph text: spaces and tabs are stored as separate elements in these files. */
function odfText(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = '';
  for (const c of node.children) {
    if (c.name === '#text') out += c.text;
    else if (c.name === 'text:s') out += ' '.repeat(Math.min(Number(c.attrs['text:c'] ?? 1) || 1, 100));
    else if (c.name === 'text:tab') out += '\t';
    else if (c.name === 'text:line-break') out += ' ';
    else out += odfText(c);
  }
  return out;
}

/** A chart from an embedded OpenDocument document (Object N/content.xml). */
export function parseOdfChart(root: XmlNode | undefined, external?: (sheet: string, r0: number, c0: number, r1: number, c1: number) => (string | number | null)[]): ChartModel | undefined {
  const find = (node: XmlNode | undefined, local: string): XmlNode | undefined => {
    if (!node) return undefined;
    for (const c of node.children) {
      if (localName(c.name) === local) return c;
      const inner = find(c, local);
      if (inner) return inner;
    }
    return undefined;
  };
  const outer = find(root, 'chart');
  const chart = child(outer, 'plot-area') ? outer : child(outer, 'chart');
  const plot = child(chart, 'plot-area');
  if (!chart || !plot) return undefined;

  // Look: the series colour and plot area properties lie in automatic styles.
  const styles = new Map<string, XmlNode>();
  for (const st of childrenOf(find(root, 'automatic-styles'), 'style')) if (st.attrs['style:name']) styles.set(st.attrs['style:name'], st);
  const chartProps = (name: string | undefined) => child(styles.get(name ?? ''), 'chart-properties');
  const colorOf = (name: string | undefined): string | undefined => {
    const g = child(styles.get(name ?? ''), 'graphic-properties');
    const fill = g?.attrs['draw:fill-color'];
    const stroke = g?.attrs['svg:stroke-color'];
    const color = g?.attrs['draw:fill'] === 'none' ? stroke : fill ?? stroke;
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined;
  };

  // Chart data is saved in an embedded table.
  const grid: (string | number | null)[][] = [];
  const table = find(chart, 'table');
  const readRows = (parent: XmlNode | undefined) => {
    for (const row of childrenOf(parent, 'table-row')) {
      const cells: (string | number | null)[] = [];
      for (const cell of childrenOf(row, 'table-cell')) {
        const repeat = Math.min(Number(cell.attrs['table:number-columns-repeated'] ?? 1) || 1, 1000);
        const type = cell.attrs['office:value-type'];
        const value = type === 'float' || type === 'percentage' || type === 'currency' ? Number(cell.attrs['office:value']) : odfText(child(cell, 'p')) || null;
        for (let i = 0; i < repeat && cells.length < 2000; i++) cells.push(typeof value === 'number' && !Number.isFinite(value) ? null : value);
      }
      if (grid.length < 20000) grid.push(cells);
    }
  };
  readRows(child(table, 'table-header-rows'));
  readRows(child(table, 'table-rows') ?? table);
  const range = (ref: string | undefined): (string | number | null)[] => {
    const r = ref ? cellRef(ref) : undefined;
    if (!r || !ref) return [];
    // A reference to a sheet of the workbook itself (in spreadsheets): values are taken from its cells.
    const sheet = /^\$?'?([^'.]*(?:''[^'.]*)*)'?\./.exec(ref)?.[1]?.replace(/''/g, "'") ?? '';
    if (external && sheet && sheet !== 'local-table') return external(sheet, r.r0, r.c0, r.r1, r.c1);
    const out: (string | number | null)[] = [];
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) out.push(grid[row]?.[col] ?? null);
    return out;
  };
  const numbers = (ref: string | undefined) => range(ref).map((v) => (typeof v === 'number' ? v : null));

  const baseKind = CHART_KINDS[(chart.attrs['chart:class'] ?? '').replace(/^chart:/, '')];
  if (!baseKind) return undefined;
  const plotProps = chartProps(plot.attrs['chart:style-name']);
  const model: ChartModel = { categories: [], series: [], palette: DEFAULT_PALETTE };
  const title = odfText(child(child(chart, 'title'), 'p')).trim();
  if (title) model.title = title;
  if (plotProps?.attrs['chart:vertical'] === 'true') model.horizontal = true;
  if (plotProps?.attrs['chart:percentage'] === 'true') model.stacking = 'percent';
  else if (plotProps?.attrs['chart:stacked'] === 'true') model.stacking = 'stacked';
  if ((chart.attrs['chart:class'] ?? '').endsWith('ring')) model.hole = 0.5;
  const legend = child(chart, 'legend');
  if (legend) {
    const position = legend.attrs['chart:legend-position'] ?? 'end';
    model.legend = position.startsWith('top') ? 't' : position.startsWith('bottom') ? 'b' : position === 'start' ? 'l' : 'r';
  }
  for (const axis of childrenOf(plot, 'axis')) {
    const dimension = axis.attrs['chart:dimension'];
    const axisTitle = odfText(child(child(axis, 'title'), 'p')).trim();
    if (axisTitle && dimension === 'x') model.xTitle = axisTitle;
    else if (axisTitle && dimension === 'y' && !model.yTitle) model.yTitle = axisTitle;
    const categories = child(axis, 'categories')?.attrs['table:cell-range-address'];
    if (categories && !model.categories.length) model.categories = range(categories).map((v) => (v === null ? '' : String(v)));
  }
  for (const node of childrenOf(plot, 'series')) {
    const kind = CHART_KINDS[(node.attrs['chart:class'] ?? '').replace(/^chart:/, '')] ?? baseKind;
    const values = numbers(node.attrs['chart:values-cell-range-address']);
    if (!values.length) continue;
    const series: ChartSeries = { kind, values };
    const name = range(node.attrs['chart:label-cell-address'])[0];
    if (name !== null && name !== undefined && String(name).trim()) series.name = String(name);
    const color = colorOf(node.attrs['chart:style-name']);
    if (color) series.color = color;
    if (node.attrs['chart:attached-axis'] === 'secondary-y') series.secondary = true;
    if (kind === 'scatter') {
      const domain = child(node, 'domain')?.attrs['table:cell-range-address'];
      if (domain) series.x = numbers(domain);
    }
    if (kind === 'line' && chartProps(node.attrs['chart:style-name'])?.attrs['chart:symbol-type'] && chartProps(node.attrs['chart:style-name'])?.attrs['chart:symbol-type'] !== 'none') series.markers = true;
    if (kind === 'pie') {
      const colors: (string | undefined)[] = [];
      for (const point of childrenOf(node, 'data-point')) {
        const repeat = Math.min(Number(point.attrs['chart:repeated'] ?? 1) || 1, 1000);
        for (let k = 0; k < repeat; k++) colors.push(colorOf(point.attrs['chart:style-name']));
      }
      if (colors.some(Boolean)) series.pointColors = colors;
    }
    if (model.series.length < 100) model.series.push(series);
  }
  if (!model.series.length) return undefined;
  if (!model.categories.length) model.categories = model.series[0].values.map((_, i) => String(i + 1));
  return model;
}

/** Embedded objects of a document (charts): address from draw:object → chart model. */
export async function loadOdfCharts(zip: ZipReader, root: XmlNode | undefined): Promise<Map<string, ChartModel>> {
  const hrefs = new Set<string>();
  const walk = (node: XmlNode | undefined, depth: number) => {
    if (!node || depth > 60) return;
    for (const c of node.children) {
      if (c.name === 'draw:object' && c.attrs['xlink:href']) hrefs.add(c.attrs['xlink:href']);
      else walk(c, depth + 1);
    }
  };
  walk(root, 0);
  const charts = new Map<string, ChartModel>();
  for (const href of [...hrefs].slice(0, 100)) {
    const entry = zip.get(`${href.replace(/^\.\//, '').replace(/\/$/, '')}/content.xml`);
    if (!entry) continue;
    try {
      const chart = parseOdfChart(parseXml(decodeXmlBytes(await zip.read(entry))));
      if (chart) charts.set(href, chart);
    } catch {
      // The object was not parsed: its replacement picture stays.
    }
  }
  return charts;
}

/**
 * Shape position with draw:transform applied: top-left corner of the unrotated frame and rotation in degrees.
 * Transforms are applied in the order written, to the shape centre.
 */
export function odfTransform(transform: string | undefined, w: number, h: number, px: (value: string | undefined) => number, x = 0, y = 0): { x: number; y: number; rot: number } | undefined {
  if (!transform) return undefined;
  let cx = x + w / 2;
  let cy = y + h / 2;
  let angle = 0;
  let found = false;
  for (const m of transform.matchAll(/(translate|rotate)\s*\(([^)]*)\)/g)) {
    const args = m[2].trim().split(/[\s,]+/);
    found = true;
    if (m[1] === 'translate') {
      cx += px(args[0]);
      cy += px(args[1] ?? '0');
    } else {
      const a = Number(args[0]) || 0;
      [cx, cy] = [cx * Math.cos(a) + cy * Math.sin(a), -cx * Math.sin(a) + cy * Math.cos(a)];
      angle += a;
    }
  }
  if (!found) return undefined;
  return { x: cx - w / 2, y: cy - h / 2, rot: (-angle * 180) / Math.PI };
}
