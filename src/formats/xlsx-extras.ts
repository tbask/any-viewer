/**
 * Extras of an xlsx sheet: conditional formatting, cell comments, pictures, charts and shapes.
 */
import { formulaIsTrue, parseFormula } from '../core/formula';
import { parseChart, readThemeColors, makeColorResolver } from '../core/chart';
import { loadImage } from '../core/images';
import { parseCellRef, parseRangeRef, type CellStyle, type Merge, type SheetBuilder, type SheetObject, type StyleTable } from '../core/workbook';
import { attr, child, childrenOf, decodeXmlBytes, localName, parseXml, textContent, type XmlNode } from '../core/xml';
import type { ZipReader } from '../core/zip';

export function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export async function readXmlPart(zip: ZipReader, path: string): Promise<XmlNode | undefined> {
  const entry = zip.get(path);
  if (!entry) return undefined;
  try {
    return parseXml(decodeXmlBytes(await zip.read(entry)));
  } catch {
    return undefined; // a damaged part must not affect the rest
  }
}

export interface Rel {
  target: string;
  type: string;
  external: boolean;
}

/** Relationships of a document part: id → path and type. */
export async function readRels(zip: ZipReader, partPath: string): Promise<Map<string, Rel>> {
  const slash = partPath.lastIndexOf('/');
  const root = await readXmlPart(zip, `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`);
  const out = new Map<string, Rel>();
  for (const rel of childrenOf(root, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || !target) continue;
    const external = attr(rel, 'TargetMode') === 'External';
    out.set(id, { target: external ? target : resolvePath(partPath, target), type: (attr(rel, 'Type') ?? '').replace(/^.*\//, ''), external });
  }
  return out;
}

// ----- conditional formatting -----

interface Rule {
  type: string;
  priority: number;
  node: XmlNode;
  style?: CellStyle;
}

export interface Conditional {
  ranges: Merge[];
  rules: Rule[];
}

type Raw = number | string;

/** Parses conditionalFormatting blocks cut out of the sheet XML. */
export function parseConditional(sheetXml: string, dxfs: CellStyle[]): Conditional[] {
  const start = sheetXml.indexOf('<conditionalFormatting');
  const endTag = '</conditionalFormatting>';
  const end = sheetXml.lastIndexOf(endTag);
  if (start < 0 || end < start) return [];
  let root: XmlNode;
  try {
    root = parseXml(`<r>${sheetXml.slice(start, end + endTag.length)}</r>`);
  } catch {
    return [];
  }
  const out: Conditional[] = [];
  for (const block of childrenOf(child(root, 'r') ?? root, 'conditionalFormatting')) {
    const ranges = (attr(block, 'sqref') ?? '').split(/\s+/).map((r) => parseRangeRef(r)).filter((r): r is Merge => !!r);
    if (!ranges.length) continue;
    const rules = childrenOf(block, 'cfRule').map((node) => {
      const dxf = attr(node, 'dxfId');
      return { type: attr(node, 'type') ?? '', priority: Number(attr(node, 'priority') ?? 0), node, style: dxf !== undefined ? dxfs[Number(dxf)] : undefined };
    });
    if (rules.length && out.length < 200) out.push({ ranges, rules });
  }
  return out;
}

/** true: there are formulas among the rules; they may need values of any sheet cells. */
export function needsAllValues(list: Conditional[]): boolean {
  return list.some((c) => c.rules.some((r) => r.type === 'expression'));
}

export function inConditional(list: Conditional[], row: number, col: number): boolean {
  for (const c of list) for (const r of c.ranges) if (row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1) return true;
  return false;
}

const constant = (formula: string | undefined): Raw | undefined => {
  if (formula === undefined) return undefined;
  const f = formula.trim();
  if (/^-?\d+(\.\d+)?(E[-+]?\d+)?$/i.test(f)) return Number(f);
  const m = /^"(.*)"$/.exec(f);
  return m ? m[1].replace(/""/g, '"') : undefined;
};

const mix = (a: string, b: string, t: number): string => {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((x >> shift) & 255) + (((y >> shift) & 255) - ((x >> shift) & 255)) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
};

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
};

const ICON_SETS: Record<string, { char: string; color: string }[]> = {
  arrows3: [{ char: '↓', color: '#d8392b' }, { char: '→', color: '#e6a700' }, { char: '↑', color: '#2e9e44' }],
  arrows4: [{ char: '↓', color: '#d8392b' }, { char: '↘', color: '#e6a700' }, { char: '↗', color: '#e6a700' }, { char: '↑', color: '#2e9e44' }],
  arrows5: [{ char: '↓', color: '#d8392b' }, { char: '↘', color: '#e6a700' }, { char: '→', color: '#e6a700' }, { char: '↗', color: '#e6a700' }, { char: '↑', color: '#2e9e44' }],
  lights3: [{ char: '●', color: '#d8392b' }, { char: '●', color: '#e6a700' }, { char: '●', color: '#2e9e44' }],
  lights4: [{ char: '●', color: '#1f2328' }, { char: '●', color: '#d8392b' }, { char: '●', color: '#e6a700' }, { char: '●', color: '#2e9e44' }],
  symbols3: [{ char: '✖', color: '#d8392b' }, { char: '!', color: '#e6a700' }, { char: '✔', color: '#2e9e44' }],
  flags3: [{ char: '⚑', color: '#d8392b' }, { char: '⚑', color: '#e6a700' }, { char: '⚑', color: '#2e9e44' }],
  rating5: [{ char: '○', color: '#6b7280' }, { char: '◔', color: '#6b7280' }, { char: '◑', color: '#6b7280' }, { char: '◕', color: '#6b7280' }, { char: '●', color: '#6b7280' }],
};
function iconSet(name: string): { char: string; color: string }[] {
  const count = Number(name[0]) || 3;
  if (/Arrows/i.test(name)) return ICON_SETS[`arrows${count}`] ?? ICON_SETS.arrows3;
  if (/Symbols/i.test(name)) return ICON_SETS.symbols3;
  if (/Flags/i.test(name)) return ICON_SETS.flags3;
  if (/Rating|Quarters|Boxes/i.test(name)) return ICON_SETS.rating5.slice(5 - Math.min(count, 5));
  return count === 4 ? ICON_SETS.lights4 : count === 5 ? [ICON_SETS.lights3[0], ICON_SETS.lights3[0], ICON_SETS.lights3[1], ICON_SETS.lights3[2], ICON_SETS.lights3[2]] : ICON_SETS.lights3;
}

/** Applies the rules to an already filled sheet. raw is the source cell values from the rule ranges. */
export function applyConditional(list: Conditional[], raw: Map<number, Raw>, builder: SheetBuilder, styles: StyleTable, color: (node: XmlNode | undefined) => string | undefined): void {
  for (const cond of list) {
    const cells: { row: number; col: number; value: Raw | undefined }[] = [];
    for (const r of cond.ranges) {
      // A "whole column" range is limited to the cells that have values.
      for (const [key, value] of raw) {
        const row = Math.floor(key / 16384);
        const col = key % 16384;
        if (row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1) cells.push({ row, col, value });
      }
    }
    if (!cells.length) continue;
    const nums = cells.map((c) => c.value).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    const min = nums[0] ?? 0;
    const max = nums[nums.length - 1] ?? 0;
    const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    const counts = new Map<Raw, number>();
    for (const c of cells) if (c.value !== undefined) counts.set(c.value, (counts.get(c.value) ?? 0) + 1);
    const threshold = (cfvo: XmlNode | undefined, fallback: number): number => {
      const type = attr(cfvo, 'type');
      const val = Number(attr(cfvo, 'val'));
      if (type === 'min') return min;
      if (type === 'max') return max;
      if (type === 'num' && Number.isFinite(val)) return val;
      if (type === 'percent' && Number.isFinite(val)) return min + ((max - min) * val) / 100;
      if (type === 'percentile' && Number.isFinite(val)) return percentile(nums, val / 100);
      return fallback;
    };
    const restyle = (cell: { row: number; col: number }, patch: CellStyle) => {
      const base = styles.list[builder.styleAt(cell.row, cell.col)] ?? {};
      builder.restyle(cell.row, cell.col, styles.add({ ...base, ...patch }));
    };

    // Less important rules first, so that more important ones land on top.
    for (const rule of [...cond.rules].sort((a, b) => b.priority - a.priority)) {
      const node = rule.node;
      if (rule.type === 'colorScale') {
        const scale = child(node, 'colorScale');
        const stops = childrenOf(scale, 'cfvo');
        const colors = childrenOf(scale, 'color').map((c) => color({ name: 'x', attrs: {}, text: '', children: [toClr(c)] }) ?? readRgb(c));
        if (stops.length < 2 || colors.length < stops.length || colors.some((c) => !c)) continue;
        const points = stops.map((s, i) => threshold(s, i === 0 ? min : i === stops.length - 1 ? max : percentile(nums, 0.5)));
        for (const cell of cells) {
          if (typeof cell.value !== 'number') continue;
          let k = 0;
          while (k < points.length - 2 && cell.value > points[k + 1]) k++;
          const span = points[k + 1] - points[k];
          const t = span > 0 ? Math.min(1, Math.max(0, (cell.value - points[k]) / span)) : 0;
          restyle(cell, { fill: mix(colors[k]!, colors[k + 1]!, t) });
        }
      } else if (rule.type === 'dataBar') {
        const bar = child(node, 'dataBar');
        const stops = childrenOf(bar, 'cfvo');
        const barColor = readRgb(child(bar, 'color')) ?? '#638ec6';
        const lo = Math.min(threshold(stops[0], min), 0 > min ? min : threshold(stops[0], min));
        const hi = threshold(stops[1], max);
        for (const cell of cells) {
          if (typeof cell.value !== 'number') continue;
          const part = hi > lo ? Math.min(1, Math.max(0, (cell.value - lo) / (hi - lo))) : 0;
          restyle(cell, { bar: { part: Math.round(part * 100) / 100, color: barColor } });
        }
      } else if (rule.type === 'iconSet') {
        const set = child(node, 'iconSet');
        const icons = iconSet(attr(set, 'iconSet') ?? '3TrafficLights1');
        const stops = childrenOf(set, 'cfvo');
        const reverse = attr(set, 'reverse') === '1';
        const points = stops.map((s, i) => threshold(s, min + ((max - min) * i) / Math.max(1, stops.length)));
        for (const cell of cells) {
          if (typeof cell.value !== 'number') continue;
          let k = 0;
          for (let i = 1; i < points.length; i++) {
            const inclusive = attr(stops[i], 'gte') !== '0';
            if (inclusive ? cell.value >= points[i] : cell.value > points[i]) k = i;
          }
          const icon = icons[Math.min(reverse ? icons.length - 1 - k : k, icons.length - 1)];
          if (icon) restyle(cell, { icon });
        }
      } else if (rule.style) {
        const formulas = childrenOf(node, 'formula').map((f) => constant(textContent(f)));
        const op = attr(node, 'operator') ?? '';
        const text = (attr(node, 'text') ?? '').toLowerCase();
        const rank = Number(attr(node, 'rank') ?? 10);
        let test: ((v: Raw | undefined) => boolean) | undefined;
        if (rule.type === 'cellIs') {
          const [a, b] = formulas;
          if (a === undefined) continue;
          const cmp = (v: Raw | undefined, x: Raw) => (typeof v === typeof x ? (v! < x ? -1 : v! > x ? 1 : 0) : NaN);
          test = (v) => {
            if (v === undefined) return false;
            const c = cmp(v, a);
            switch (op) {
              case 'greaterThan': return c > 0;
              case 'greaterThanOrEqual': return c >= 0;
              case 'lessThan': return c < 0;
              case 'lessThanOrEqual': return c <= 0;
              case 'equal': return c === 0;
              case 'notEqual': return c !== 0;
              case 'between': return b !== undefined && c >= 0 && cmp(v, b) <= 0;
              case 'notBetween': return b !== undefined && (c < 0 || cmp(v, b) > 0);
              default: return false;
            }
          };
        } else if (rule.type === 'top10') {
          const bottom = attr(node, 'bottom') === '1';
          const count = attr(node, 'percent') === '1' ? Math.max(1, Math.floor((nums.length * rank) / 100)) : rank;
          const edge = bottom ? nums[Math.min(count, nums.length) - 1] : nums[Math.max(0, nums.length - count)];
          test = (v) => typeof v === 'number' && (bottom ? v <= edge : v >= edge);
        } else if (rule.type === 'aboveAverage') {
          const below = attr(node, 'aboveAverage') === '0';
          const equal = attr(node, 'equalAverage') === '1';
          test = (v) => typeof v === 'number' && (below ? v < avg || (equal && v === avg) : v > avg || (equal && v === avg));
        } else if (rule.type === 'duplicateValues') test = (v) => v !== undefined && (counts.get(v) ?? 0) > 1;
        else if (rule.type === 'uniqueValues') test = (v) => v !== undefined && counts.get(v) === 1;
        else if (rule.type === 'containsText') test = (v) => v !== undefined && !!text && String(v).toLowerCase().includes(text);
        else if (rule.type === 'notContainsText') test = (v) => v !== undefined && !!text && !String(v).toLowerCase().includes(text);
        else if (rule.type === 'beginsWith') test = (v) => v !== undefined && !!text && String(v).toLowerCase().startsWith(text);
        else if (rule.type === 'endsWith') test = (v) => v !== undefined && !!text && String(v).toLowerCase().endsWith(text);
        if (rule.type === 'expression') {
          // Formula rule: it is written for the top-left cell of the range; for the others references are shifted.
          const tree = parseFormula(textContent(child(node, 'formula')));
          const origin = cond.ranges[0];
          if (!tree || !origin || !rule.style) continue;
          const cellValue = (r: number, c: number) => raw.get(r * 16384 + c) ?? null;
          for (const cell of cells.slice(0, 50_000)) {
            if (formulaIsTrue(tree, { cell: cellValue, dRow: cell.row - origin.r0, dCol: cell.col - origin.c0, row: cell.row, col: cell.col })) restyle(cell, rule.style);
          }
          continue;
        }
        if (!test) continue;
        for (const cell of cells) if (test(cell.value)) restyle(cell, rule.style);
      }
    }
  }
}

function readRgb(node: XmlNode | undefined): string | undefined {
  const rgb = attr(node, 'rgb');
  return rgb && rgb.length >= 6 ? `#${rgb.slice(-6).toLowerCase()}` : undefined;
}
/** A SpreadsheetML colour (theme="4") as a DrawingML node, to parse it with the shared code. */
function toClr(node: XmlNode): XmlNode {
  const theme = attr(node, 'theme');
  const names = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
  if (theme !== undefined && names[Number(theme)]) return { name: 'a:schemeClr', attrs: { val: names[Number(theme)] }, text: '', children: [] };
  return { name: 'a:srgbClr', attrs: { val: (attr(node, 'rgb') ?? '').slice(-6) }, text: '', children: [] };
}

// ----- comments -----

export async function readComments(zip: ZipReader, path: string, builder: SheetBuilder): Promise<void> {
  const root = await readXmlPart(zip, path);
  const authors = childrenOf(child(root, 'authors'), 'author').map((a) => textContent(a));
  for (const comment of childrenOf(child(root, 'commentList'), 'comment')) {
    const ref = parseCellRef(attr(comment, 'ref') ?? '');
    if (!ref) continue;
    let text = '';
    const walk = (n: XmlNode) => {
      for (const c of n.children) {
        if (c.name === '#text') continue;
        if (localName(c.name) === 't') text += textContent(c);
        else walk(c);
      }
    };
    walk(comment);
    text = text.replace(/_x000D_/g, '').trim();
    const author = authors[Number(attr(comment, 'authorId'))];
    // Excel usually starts the text with the author's name itself; if not, it is added.
    if (author && text && !text.startsWith(author)) text = `${author}: ${text}`;
    builder.addNote(ref.row, ref.col, text);
  }
}

// ----- pictures, charts, shapes -----

const EMU_PER_PX = 9525;

export async function readDrawing(zip: ZipReader, path: string, builder: SheetBuilder, themeRoot: XmlNode | undefined, colWidthPx: (col: number) => number, rowHeightPx: (row: number) => number): Promise<void> {
  const root = await readXmlPart(zip, path);
  if (!root) return;
  const rels = await readRels(zip, path);
  const theme = readThemeColors(themeRoot);
  const color = makeColorResolver(theme);
  const wsDr = localName(root.name) === 'wsDr' ? root : (child(root, 'wsDr') ?? root);
  for (const anchor of wsDr.children) {
    if (anchor.name === '#text') continue;
    const kind = localName(anchor.name);
    if (kind !== 'twoCellAnchor' && kind !== 'oneCellAnchor') continue;
    const marker = (node: XmlNode | undefined) => {
      const col = Number(textContent(child(node, 'col')));
      const row = Number(textContent(child(node, 'row')));
      const colOff = Number(textContent(child(node, 'colOff'))) / EMU_PER_PX;
      const rowOff = Number(textContent(child(node, 'rowOff'))) / EMU_PER_PX;
      return { col, row, dx: Math.min(1, Math.max(0, colOff / colWidthPx(col))), dy: Math.min(1, Math.max(0, rowOff / rowHeightPx(row))) };
    };
    const from = marker(child(anchor, 'from'));
    if (!Number.isFinite(from.col) || !Number.isFinite(from.row)) continue;
    let to = child(anchor, 'to') ? marker(child(anchor, 'to')) : undefined;
    if (!to) {
      // One-cell anchor: the size is given explicitly; convert it to cells.
      const ext = child(anchor, 'ext');
      let w = Number(attr(ext, 'cx')) / EMU_PER_PX + from.dx * colWidthPx(from.col);
      let h = Number(attr(ext, 'cy')) / EMU_PER_PX + from.dy * rowHeightPx(from.row);
      let col = from.col;
      let row = from.row;
      while (w > colWidthPx(col) && col < from.col + 200) w -= colWidthPx(col++);
      while (h > rowHeightPx(row) && row < from.row + 2000) h -= rowHeightPx(row++);
      to = { col, row, dx: Math.min(1, w / colWidthPx(col)), dy: Math.min(1, h / rowHeightPx(row)) };
    }
    const object: SheetObject = { r0: from.row, c0: from.col, r1: to.row, c1: to.col, dx0: from.dx, dy0: from.dy, dx1: to.dx, dy1: to.dy };

    // An object for new Office versions may be wrapped in an "alternate content" choice: take the main variant.
    const wrapped = child(anchor, 'AlternateContent');
    const holder = wrapped ? child(wrapped, 'Choice') ?? child(wrapped, 'Fallback') ?? anchor : anchor;
    const pic = child(holder, 'pic');
    const frame = child(holder, 'graphicFrame');
    const sp = child(holder, 'sp') ?? child(holder, 'cxnSp');
    if (pic) {
      const blip = child(child(pic, 'blipFill'), 'blip');
      const rel = rels.get(blip?.attrs['r:embed'] ?? '');
      const entry = rel && !rel.external ? zip.get(rel.target) : undefined;
      if (!rel || !entry) continue;
      try {
        const image = loadImage(rel.target, await zip.read(entry));
        if (!image) continue;
        object.image = image;
      } catch {
        continue;
      }
    } else if (frame) {
      const findChart = (n: XmlNode): XmlNode | undefined => {
        for (const c of n.children) {
          if (c.name === '#text') continue;
          if (localName(c.name) === 'chart' && c.attrs['r:id']) return c;
          const deep = findChart(c);
          if (deep) return deep;
        }
        return undefined;
      };
      const rel = rels.get(findChart(frame)?.attrs['r:id'] ?? '');
      const chart = rel ? parseChart(await readXmlPart(zip, rel.target), theme) : undefined;
      if (!chart) continue;
      object.chart = chart;
    } else if (sp) {
      const spPr = child(sp, 'spPr');
      const paras: string[] = [];
      for (const p of childrenOf(child(sp, 'txBody'), 'p')) {
        let line = '';
        const walk = (n: XmlNode) => {
          for (const c of n.children) {
            if (c.name === '#text') continue;
            if (localName(c.name) === 't') line += textContent(c);
            else if (localName(c.name) === 'br') line += '\n';
            else walk(c);
          }
        };
        walk(p);
        paras.push(line);
      }
      object.text = paras.join('\n').trim() || undefined;
      const noFill = !!child(spPr, 'noFill');
      object.fill = noFill ? undefined : (color(child(spPr, 'solidFill')) ?? color(child(child(child(spPr, 'gradFill'), 'gsLst'), 'gs')) ?? (object.text !== undefined || localName(sp.name) === 'sp' ? theme.accent1 : undefined));
      const ln = child(spPr, 'ln');
      object.stroke = child(ln, 'noFill') ? undefined : (color(child(ln, 'solidFill')) ?? (localName(sp.name) === 'cxnSp' ? theme.accent1 : undefined));
      const geom = attr(child(spPr, 'prstGeom'), 'prst') ?? 'rect';
      object.shape = /ellipse|circle/i.test(geom) ? 'ellipse' : /round/i.test(geom) ? 'round' : 'rect';
      if (!object.text && !object.fill && !object.stroke) continue;
    } else {
      continue;
    }
    builder.addObject(object);
  }
}

/** Sheet sparklines: the cell, the chart kind and the data range (possibly on another sheet). */
export function parseSparklines(sheetXml: string): { row: number; col: number; kind: 'line' | 'column' | 'stacked'; color: string; negative?: string; sheet?: string; range: Merge }[] {
  const start = sheetXml.indexOf('<x14:sparklineGroups');
  const endTag = '</x14:sparklineGroups>';
  const end = sheetXml.indexOf(endTag, start);
  if (start < 0 || end < 0) return [];
  let root: XmlNode;
  try {
    root = parseXml(sheetXml.slice(start, end + endTag.length));
  } catch {
    return [];
  }
  const groups = root.name.endsWith('sparklineGroups') ? root : child(root, 'sparklineGroups');
  const out: ReturnType<typeof parseSparklines> = [];
  for (const group of childrenOf(groups, 'sparklineGroup')) {
    const type = attr(group, 'type');
    const kind = type === 'column' ? 'column' : type === 'stacked' ? 'stacked' : 'line';
    const color = readRgb(child(group, 'colorSeries')) ?? '#376092';
    const negative = attr(group, 'negative') === '1' ? readRgb(child(group, 'colorNegative')) : undefined;
    for (const item of childrenOf(child(group, 'sparklines'), 'sparkline')) {
      const formula = textContent(child(item, 'f')).trim();
      const at = parseRangeRef(textContent(child(item, 'sqref')).trim().split(/\s+/)[0] ?? '');
      const bang = formula.lastIndexOf('!');
      const range = parseRangeRef(formula.slice(bang + 1).replace(/\$/g, ''));
      if (!at || !range || out.length >= 2000) continue;
      const sheet = bang > 0 ? formula.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : undefined;
      out.push({ row: at.r0, col: at.c0, kind, color, negative, sheet, range });
    }
  }
  return out;
}

/** Numbers from sheet cells by its XML, without a full parse; needed for data from another sheet. */
export function sheetNumbers(sheetXml: string, range: Merge): (number | null)[] {
  const out: (number | null)[] = [];
  if ((range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1) > 500) return out;
  const letters = (col: number) => {
    let s = '';
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const m = new RegExp(`<c r="${letters(c)}${r + 1}"([^>]*)>(?:<f[^>]*/>|<f[^>]*>[^<]*</f>)?<v>([^<]*)</v>`).exec(sheetXml);
      // A chart does not need strings and booleans.
      const value = m && !/ t="(s|str|b|e|inlineStr)"/.test(m[1]) ? Number(m[2]) : NaN;
      out.push(Number.isFinite(value) ? value : null);
    }
  }
  return out;
}

function mixColor(color: string, toward: string, part: number): string {
  const a = parseInt(color.slice(1), 16);
  const b = parseInt(toward.slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - part) + ((b >> shift) & 255) * part);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/**
 * Built-in styles of "smart" tables and pivot tables. The file stores only the style name
 * (TableStyleMedium9, PivotStyleLight16); the look is reproduced by its family and accent colour:
 * a header row, banded rows and a totals row. Formatting set on a cell itself wins over the table style.
 * `theme` is the workbook theme in SpreadsheetML order (light 1, dark 1, light 2, dark 2, six accents).
 */
export async function applyTableStyle(zip: ZipReader, path: string, kind: 'table' | 'pivot', builder: SheetBuilder, styles: StyleTable, theme: string[]): Promise<void> {
  const root = await readXmlPart(zip, path);
  if (!root) return;
  const info = child(root, kind === 'table' ? 'tableStyleInfo' : 'pivotTableStyleInfo');
  const match = /^(?:Table|Pivot)Style(Light|Medium|Dark)(\d+)$/.exec(attr(info, 'name') ?? '');
  const location = kind === 'table' ? root : child(root, 'location');
  const ref = attr(location, 'ref') ? parseRangeRef(attr(location, 'ref')!) : null;
  if (!match || !ref || ref.r1 - ref.r0 > 20_000 || ref.c1 - ref.c0 > 200) return;
  const family = match[1];
  const number = Number(match[2]);
  const index = (number - 1) % 7;
  const accent = index === 0 ? '#000000' : theme[3 + index] ?? '#4472c4';
  const light = mixColor(accent, '#ffffff', index === 0 ? 0.85 : 0.8);
  const mid = mixColor(accent, '#ffffff', index === 0 ? 0.7 : 0.6);
  const stripes = attr(info, 'showRowStripes') === '1';
  const headerRows = kind === 'table' ? Number(attr(root, 'headerRowCount') ?? 1) : Math.max(1, Number(attr(location, 'firstDataRow') ?? 1));
  const totalRows = kind === 'table' ? Number(attr(root, 'totalsRowCount') ?? 0) : 1;
  const filledHeader = family === 'Dark' || family === 'Medium' || (family === 'Light' && number >= 8 && number <= 14);
  const put = (row: number, col: number, extra: CellStyle) => {
    const own = styles.list[builder.styleAt(row, col)] ?? {};
    const merged: CellStyle = { ...extra, ...own };
    if (extra.border && own.border) merged.border = [...new Set(extra.border + own.border)].join('');
    // The text colour of a filled header belongs with its fill.
    if (extra.fill && !own.fill && extra.color) merged.color = extra.color;
    builder.restyle(row, col, styles.add(merged));
  };
  for (let row = ref.r0; row <= ref.r1; row++) {
    const header = row < ref.r0 + headerRows;
    const total = totalRows > 0 && row > ref.r1 - totalRows;
    const band = (row - ref.r0 - headerRows) % 2 === 0;
    for (let col = ref.c0; col <= ref.c1; col++) {
      if (header) {
        if (kind === 'pivot') put(row, col, { bold: true, fill: light, border: 'b', lineColor: accent });
        else if (filledHeader) put(row, col, { bold: true, fill: family === 'Dark' ? mixColor(accent, '#000000', 0.5) : accent, color: '#ffffff' });
        else put(row, col, { bold: true, border: 'b', lineColor: accent });
      } else if (total) {
        put(row, col, { bold: true, border: 't', lines: kind === 'table' ? 'd' : 's', lineColor: accent });
      } else if (family === 'Dark') {
        put(row, col, { fill: band ? accent : mixColor(accent, '#000000', 0.2), color: '#ffffff' });
      } else if (kind === 'table' && family === 'Medium' && ((number >= 8 && number <= 14) || number >= 22)) {
        put(row, col, { fill: band || !stripes ? mid : light });
      } else if (kind === 'table' && stripes && band) {
        put(row, col, { fill: light });
      } else if (kind === 'table' && family === 'Light' && number >= 15) {
        put(row, col, { border: 'trbl', lineColor: accent });
      }
    }
  }
}
