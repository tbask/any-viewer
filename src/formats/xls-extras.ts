/**
 * Extras for binary xls parsing: pictures, shapes and charts on a sheet, conditional formatting.
 * A chart in this format is a nested record stream; next to the description it holds cached series values.
 */
import { DEFAULT_PALETTE, type ChartKind, type ChartModel, type ChartSeries } from '../core/chart';
import type { DocImage } from '../core/docmodel';
import { blipImage } from '../core/images';
import { indexedColor, type CellStyle, type Merge, type SheetBuilder, type SheetObject, type StyleTable } from '../core/workbook';
import type { XmlNode } from '../core/xml';
import { applyConditional, type Conditional } from './xlsx-extras';

const node = (name: string, attrs: Record<string, string> = {}, children: XmlNode[] = [], text = ''): XmlNode => ({
  name,
  attrs,
  children: text ? [{ name: '#text', attrs: {}, children: [], text }, ...children] : children,
  text: '',
});

/** Workbook pictures from the shared drawing store (MSODRAWINGGROUP records). */
export function readBlipStore(bytes: Uint8Array): (DocImage | undefined)[] {
  const out: (DocImage | undefined)[] = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const walk = (start: number, end: number, depth: number) => {
    for (let p = start; p + 8 <= end; ) {
      const verInst = v.getUint16(p, true);
      const type = v.getUint16(p + 2, true);
      const len = v.getUint32(p + 4, true);
      const next = Math.min(end, p + 8 + len);
      if (type === 0xf007) out.push(blipImage(bytes.subarray(0, next), p));
      else if ((verInst & 0x0f) === 0x0f && depth < 6) walk(p + 8, next, depth + 1);
      if (next <= p) break;
      p = next;
    }
  };
  walk(0, bytes.length, 0);
  return out;
}

const ICON_SETS = ['3Arrows', '3ArrowsGray', '3Flags', '3TrafficLights1', '3TrafficLights2', '3Signs', '3Symbols', '3Symbols2', '4Arrows', '4ArrowsGray', '4RedToBlack', '4Rating', '4TrafficLights', '5Arrows', '5ArrowsGray', '5Rating', '5Quarters'];
const OPERATORS = ['', 'between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual'];
const CFVO_TYPES: Record<number, string> = { 1: 'num', 2: 'min', 3: 'max', 4: 'percent', 5: 'percentile', 7: 'formula' };
const THEME = ['ffffff', '000000', 'e7e6e6', '44546a', '4472c4', 'ed7d31', 'a5a5a5', 'ffc000', '5b9bd5', '70ad47'];

/** Excel functions by their numbers in a binary formula: name and argument count (−1: variable). */
const FUNCTIONS: Record<number, [string, number]> = {
  0: ['COUNT', -1], 1: ['IF', -1], 3: ['ISERROR', 1], 4: ['SUM', -1], 5: ['AVERAGE', -1], 6: ['MIN', -1], 7: ['MAX', -1], 8: ['ROW', -1], 9: ['COLUMN', -1],
  24: ['ABS', 1], 25: ['INT', 1], 27: ['ROUND', 2], 31: ['MID', 3], 32: ['LEN', 1], 33: ['VALUE', 1], 34: ['TRUE', 0], 35: ['FALSE', 0], 36: ['AND', -1], 37: ['OR', -1],
  38: ['NOT', 1], 39: ['MOD', 2], 65: ['DATE', 3], 67: ['DAY', 1], 68: ['MONTH', 1], 69: ['YEAR', 1], 70: ['WEEKDAY', -1], 74: ['NOW', 0], 82: ['SEARCH', -1],
  112: ['LOWER', 1], 113: ['UPPER', 1], 115: ['LEFT', -1], 116: ['RIGHT', -1], 117: ['EXACT', 2], 118: ['TRIM', 1], 124: ['FIND', -1], 127: ['ISTEXT', 1],
  128: ['ISNUMBER', 1], 129: ['ISBLANK', 1], 169: ['COUNTA', -1], 221: ['TODAY', 0], 345: ['SUMIF', -1], 346: ['COUNTIF', 2], 347: ['COUNTBLANK', 1], 480: ['IFERROR', 2],
};
const BINARY = ['+', '-', '*', '/', '^', '&', '<', '<=', '=', '>=', '>', '<>'];

/**
 * A formula from the binary xls form (reverse Polish notation) → text in the usual form.
 * Relative references in conditional formatting are stored as offsets from the top-left cell of the range (row0, col0).
 * undefined: the formula has something that cannot be translated (references to other sheets, names, rare functions).
 */
export function formulaText(data: Uint8Array, at: number, length: number, row0: number, col0: number, decode: (bytes: Uint8Array) => string): string | undefined {
  if (length <= 0 || at + length > data.length) return undefined;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = at + length;
  const stack: string[] = [];
  const letters = (col: number) => {
    let out = '';
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    return out;
  };
  const ref = (rowRaw: number, colRaw: number, offsets: boolean): string | undefined => {
    const rowRel = (colRaw & 0x8000) !== 0;
    const colRel = (colRaw & 0x4000) !== 0;
    let row = rowRaw;
    let col = colRaw & 0xff;
    if (offsets) {
      // Signed offsets: 16 bits for the row, 8 for the column.
      if (rowRel) row = row0 + ((rowRaw << 16) >> 16);
      if (colRel) col = col0 + ((col << 24) >> 24);
    }
    if (row < 0 || row > 65535 || col < 0 || col > 255) return undefined;
    return `${colRel ? '' : '$'}${letters(col)}${rowRel ? '' : '$'}${row + 1}`;
  };
  let p = at;
  while (p < end) {
    const token = data[p++];
    const base = token >= 0x40 ? (token & 0x1f) | 0x20 : token;
    if (token >= 0x03 && token <= 0x0e) {
      const right = stack.pop();
      const left = stack.pop();
      if (left === undefined || right === undefined) return undefined;
      stack.push(`${left}${BINARY[token - 3]}${right}`);
    } else if (token === 0x12 || token === 0x13) {
      const x = stack.pop();
      if (x === undefined) return undefined;
      stack.push(`${token === 0x13 ? '-' : '+'}${x}`);
    } else if (token === 0x14) {
      const x = stack.pop();
      if (x === undefined) return undefined;
      stack.push(`${x}%`);
    } else if (token === 0x15) {
      const x = stack.pop();
      if (x === undefined) return undefined;
      stack.push(`(${x})`);
    } else if (token === 0x17) {
      if (p + 2 > end) return undefined;
      const count = data[p];
      const wide = (data[p + 1] & 1) !== 0;
      const bytes = data.subarray(p + 2, p + 2 + count * (wide ? 2 : 1));
      p += 2 + bytes.length;
      stack.push(`"${(wide ? new TextDecoder('utf-16le').decode(bytes) : decode(bytes)).replace(/"/g, '""')}"`);
    } else if (token === 0x19) {
      if (p + 3 > end) return undefined;
      const option = data[p];
      const value = v.getUint16(p + 1, true);
      p += 3;
      if (option & 0x04) p += (value + 1) * 2;
      else if (option & 0x10) {
        const x = stack.pop();
        if (x === undefined) return undefined;
        stack.push(`SUM(${x})`);
      }
    } else if (token === 0x1d) {
      stack.push(data[p++] ? 'TRUE' : 'FALSE');
    } else if (token === 0x1e) {
      stack.push(String(v.getUint16(p, true)));
      p += 2;
    } else if (token === 0x1f) {
      stack.push(String(v.getFloat64(p, true)));
      p += 8;
    } else if (base === 0x21 || base === 0x22) {
      let count = -1;
      if (base === 0x22) count = data[p++] & 0x7f;
      const fn = FUNCTIONS[v.getUint16(p, true) & 0x7fff];
      p += 2;
      if (!fn) return undefined;
      if (count < 0) count = fn[1];
      if (count < 0 || count > stack.length) return undefined;
      const args = count ? stack.splice(stack.length - count, count) : [];
      stack.push(`${fn[0]}(${args.join(',')})`);
    } else if (base === 0x24 || base === 0x2c) {
      if (p + 4 > end) return undefined;
      const text = ref(v.getUint16(p, true), v.getUint16(p + 2, true), base === 0x2c);
      p += 4;
      if (!text) return undefined;
      stack.push(text);
    } else if (base === 0x25 || base === 0x2d) {
      if (p + 8 > end) return undefined;
      const a = ref(v.getUint16(p, true), v.getUint16(p + 4, true), base === 0x2d);
      const b = ref(v.getUint16(p + 2, true), v.getUint16(p + 6, true), base === 0x2d);
      p += 8;
      if (!a || !b) return undefined;
      stack.push(`${a}:${b}`);
    } else return undefined;
  }
  return stack.length === 1 ? stack[0] : undefined;
}

interface DrawingShape {
  anchor?: number[];
  blip?: number;
  fill?: string;
  stroke?: string;
  type: number;
}

interface ChartText {
  text?: string;
  link?: number;
}

/** Collector of one sheet's extras: receives all sheet records in order. */
export class XlsSheetExtras {
  private readonly objects: SheetObject[] = [];
  private readonly raw = new Map<number, number | string>();
  private readonly conditionals: Conditional[] = [];
  private current: { ranges: Merge[]; id: number; rules: { rule: Conditional['rules'][number]; dxfnLength: number }[] } | null = null;
  private readonly byId = new Map<number, { rule: Conditional['rules'][number]; dxfnLength: number }[]>();
  private priority = 1000;
  // Drawings: a chunk of shape description accumulates until the object record.
  private drawing: Uint8Array[] = [];
  private pendingObject: { object: SheetObject; id: number; kind: number } | null = null;
  private readonly textTargets = new Map<number, SheetObject>();
  // Chart.
  private chart: ChartModel | null = null;
  private chartTarget: SheetObject | null = null;
  private stack: number[] = [];
  private last = 0;
  private series: (ChartSeries & { group: number; x?: (number | null)[] })[] = [];
  private currentSeries = -1;
  private groups: { kind: ChartKind; secondary: boolean; horizontal?: boolean; stacking?: 'stacked' | 'percent'; hole?: number }[] = [];
  private axisParent = 0;
  private texts: ChartText[] = [];
  private cacheKind = 0;
  private categories: string[] = [];
  private formatSeries = -1;
  private formatPoint = 0xffff;
  private aiId = -1;

  constructor(
    private readonly blips: (DocImage | undefined)[],
    private readonly palette: string[] | undefined,
    private readonly decode: (bytes: Uint8Array) => string,
    /** Cell values by a formula reference: sheet reference index and range bounds. */
    private readonly resolve: (sheetRef: number, r0: number, r1: number, c0: number, c1: number) => (number | string | null)[] = () => [],
  ) {}

  value(row: number, col: number, value: number | string): void {
    if (this.raw.size < 400_000 && col < 16384) this.raw.set(row * 16384 + col, value);
  }

  private color(index: number): string | undefined {
    if (index < 8 || index >= 64) return undefined;
    const c = indexedColor(index, this.palette);
    return c ? (c.startsWith('#') ? c : `#${c}`).toLowerCase() : undefined;
  }

  /** A top-level sheet record (not from a chart stream). */
  record(id: number, data: Uint8Array, texts: Map<number, string>): void {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (id) {
      case 0x00ec:
        this.drawing.push(data);
        break;
      case 0x005d:
        this.object(data, v, texts);
        break;
      case 0x01b0:
      case 0x0879: {
        const at = id === 0x0879 ? 12 : 0;
        if (data.length < at + 14) break;
        const count = v.getUint16(at + 12, true);
        const ranges: Merge[] = [];
        for (let i = 0; i < count && at + 14 + i * 8 + 8 <= data.length; i++) {
          const p = at + 14 + i * 8;
          ranges.push({ r0: v.getUint16(p, true), r1: v.getUint16(p + 2, true), c0: v.getUint16(p + 4, true), c1: v.getUint16(p + 6, true) });
        }
        this.flush();
        this.current = { ranges, id: v.getUint16(at + 2, true) >> 1, rules: [] };
        break;
      }
      case 0x01b1:
        if (this.current) this.classicRule(data, v);
        break;
      case 0x087a:
        if (this.current) this.modernRule(data, v);
        break;
      case 0x087b:
        this.extension(data, v);
        break;
    }
  }

  private flush(): void {
    if (this.current?.rules.length && this.conditionals.length < 200) {
      this.conditionals.push({ ranges: this.current.ranges, rules: this.current.rules.map((r) => r.rule) });
      this.byId.set(this.current.id, this.current.rules);
    }
    this.current = null;
  }

  /** A formula of a single constant → its text (as in xlsx); otherwise undefined. */
  private constant(data: Uint8Array, at: number, length: number): string | undefined {
    if (length < 1 || at + length > data.length) return undefined;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const token = data[at];
    if (token === 0x1e && length === 3) return String(v.getUint16(at + 1, true));
    if (token === 0x1f && length === 9) return String(v.getFloat64(at + 1, true));
    if (token === 0x17 && length >= 3) {
      const count = data[at + 1];
      const wide = (data[at + 2] & 1) !== 0;
      const bytes = data.subarray(at + 3, at + 3 + count * (wide ? 2 : 1));
      const text = wide ? new TextDecoder('utf-16le').decode(bytes) : this.decode(bytes);
      return `"${text.replace(/"/g, '""')}"`;
    }
    return undefined;
  }

  /** Formatting from a "differential format" description (font and fill): colours come from the workbook palette. */
  private dxfStyle(data: Uint8Array, at: number, length: number): CellStyle | undefined {
    if (length < 6 || at + length > data.length) return undefined;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flags = v.getUint32(at, true);
    const style: CellStyle = {};
    let p = at + 6;
    if (flags & (1 << 25)) p += v.getUint16(at + 4, true) & 1 ? v.getUint16(p, true) : 2;
    if (flags & (1 << 26)) {
      if (p + 118 > at + length) return undefined;
      const color = v.getInt32(p + 80, true);
      const fontColor = color >= 0 ? this.color(color) : undefined;
      if (fontColor) style.color = fontColor;
      if (v.getUint32(p + 100, true) === 0 && v.getUint16(p + 72, true) >= 600) style.bold = true;
      if (!(v.getUint32(p + 88, true) & 2) && v.getUint32(p + 68, true) & 2) style.italic = true;
      p += 118;
    }
    if (flags & (1 << 27)) p += 8;
    if (flags & (1 << 28)) p += 8;
    if (flags & (1 << 29) && p + 4 <= at + length) {
      const colors = v.getUint16(p + 2, true);
      const fill = this.color((colors >> 7) & 0x7f) ?? this.color(colors & 0x7f);
      if (fill) style.fill = fill;
    }
    return Object.keys(style).length ? style : undefined;
  }

  private classicRule(data: Uint8Array, v: DataView): void {
    if (data.length < 6) return;
    const type = data[0];
    const length1 = v.getUint16(2, true);
    const length2 = v.getUint16(4, true);
    const dxfnLength = data.length - 6 - length1 - length2;
    if (dxfnLength < 0) return;
    const style = this.dxfStyle(data, 6, dxfnLength);
    const first = this.constant(data, 6 + dxfnLength, length1);
    const second = this.constant(data, 6 + dxfnLength + length1, length2);
    const formulas = [first, second].filter((f): f is string => f !== undefined).map((f) => node('formula', {}, [], f));
    const usable = type === 1 && first !== undefined && (length2 === 0 || second !== undefined);
    // Formula rule: the formula is translated to text, as in xlsx; what cannot be translated is skipped
    // (its slot in the list stays so that rule numbers do not shift).
    const origin = this.current!.ranges[0];
    const expression = type === 2 && origin ? formulaText(data, 6 + dxfnLength, length1, origin.r0, origin.c0, this.decode) : undefined;
    const rule = expression
      ? { type: 'expression', priority: this.priority++, node: node('cfRule', { type: 'expression' }, [node('formula', {}, [], expression)]), style }
      : { type: usable ? 'cellIs' : 'unsupported', priority: this.priority++, node: node('cfRule', { type: 'cellIs', operator: OPERATORS[data[1]] ?? '' }, formulas), style };
    this.current!.rules.push({ rule, dxfnLength });
  }

  /** Extension of a regular rule: exact formatting colours (in the rule record itself they are reduced to the palette). */
  private extension(data: Uint8Array, v: DataView): void {
    if (data.length < 30 || v.getUint32(12, true) !== 0 || !data[25]) return;
    this.flush();
    const entry = this.byId.get(v.getUint16(16, true))?.[v.getUint16(18, true)];
    if (!entry) return;
    const start = 30 + entry.dxfnLength;
    if (start + 8 > data.length) return;
    const count = v.getUint16(start + 6, true);
    const style: CellStyle = { ...entry.rule.style };
    let p = start + 8;
    for (let i = 0; i < count && p + 4 <= data.length; i++) {
      const type = v.getUint16(p, true);
      const size = v.getUint16(p + 2, true);
      if (size < 4 || p + size > data.length) break;
      if ((type === 4 || type === 5 || type === 13) && size >= 12) {
        const color = this.fullColor(v.getUint16(p + 4, true), v.getUint32(p + 8, true), data, p + 8);
        if (color && type === 13) style.color = color;
        else if (color && (type === 5 || !style.fill)) style.fill = color;
      }
      p += size;
    }
    entry.rule.style = style;
  }

  private fullColor(kind: number, value: number, data: Uint8Array, at: number): string | undefined {
    if (kind === 2) return `#${[data[at], data[at + 1], data[at + 2]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (kind === 1) return this.color(value);
    if (kind === 3) return THEME[value] ? `#${THEME[value]}` : undefined;
    return undefined;
  }

  /** Excel 2007+ rules: colour scale, data bar, icon set. Collected in the same form as in xlsx. */
  private modernRule(data: Uint8Array, v: DataView): void {
    if (data.length < 26) return;
    const type = data[12];
    const length1 = v.getUint16(14, true);
    const length2 = v.getUint16(16, true);
    const dxfSize = v.getUint32(18, true);
    let p = 22 + (dxfSize ? dxfSize : 2) + length1 + length2;
    if (p + 2 > data.length) return;
    p += 2 + v.getUint16(p, true); // range formula
    if (p + 6 > data.length) return;
    p += 6 + data[p + 5]; // flags, priority, template and its parameters
    const cfvo = (): XmlNode | undefined => {
      if (p + 3 > data.length) return undefined;
      const kind = data[p];
      const formulaLength = v.getUint16(p + 1, true);
      p += 3 + formulaLength;
      const attrs: Record<string, string> = { type: CFVO_TYPES[kind] ?? 'num' };
      if (formulaLength === 0 && kind !== 2 && kind !== 3) {
        if (p + 8 > data.length) return undefined;
        attrs.val = String(v.getFloat64(p, true));
        p += 8;
      }
      return node('cfvo', attrs);
    };
    const color = (): XmlNode | undefined => {
      if (p + 16 > data.length) return undefined;
      const c = this.fullColor(v.getUint32(p, true), v.getUint32(p + 4, true), data, p + 4);
      p += 16;
      return node('color', c ? { rgb: `ff${c.slice(1)}` } : {});
    };
    let body: XmlNode | undefined;
    let name = '';
    if (type === 3 && p + 6 <= data.length) {
      const points = data[p + 3];
      const colors = data[p + 4];
      p += 6;
      const items: XmlNode[] = [];
      for (let i = 0; i < points; i++) {
        const item = cfvo();
        if (!item) return;
        items.push(item);
        p += 8; // position of a point on the scale
      }
      for (let i = 0; i < colors; i++) {
        p += 8;
        const item = color();
        if (!item) return;
        items.push(item);
      }
      name = 'colorScale';
      body = node('colorScale', {}, items);
    } else if (type === 4 && p + 6 <= data.length) {
      p += 6;
      const bar = color();
      const low = cfvo();
      const high = cfvo();
      if (!bar || !low || !high) return;
      name = 'dataBar';
      body = node('dataBar', {}, [low, high, bar]);
    } else if (type === 6 && p + 6 <= data.length) {
      const states = data[p + 3];
      const set = ICON_SETS[data[p + 4]] ?? '3TrafficLights1';
      const reverse = (data[p + 5] & 4) !== 0;
      p += 6;
      const items: XmlNode[] = [];
      for (let i = 0; i < states; i++) {
        const item = cfvo();
        if (!item) return;
        items.push(item);
        p += 5;
      }
      name = 'iconSet';
      body = node('iconSet', reverse ? { iconSet: set, reverse: '1' } : { iconSet: set }, items);
    }
    if (!body) return;
    this.current!.rules.push({ rule: { type: name, priority: this.priority++, node: node('cfRule', { type: name }, [body]), style: undefined }, dxfnLength: 0 });
  }

  // --- sheet objects ---

  private shapeOf(): DrawingShape {
    const total = this.drawing.reduce((n, part) => n + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of this.drawing) {
      bytes.set(part, offset);
      offset += part.length;
    }
    this.drawing = [];
    const v = new DataView(bytes.buffer);
    const shape: DrawingShape = { type: 0 };
    const walk = (start: number, end: number, depth: number) => {
      for (let p = start; p + 8 <= end; ) {
        const verInst = v.getUint16(p, true);
        const type = v.getUint16(p + 2, true);
        const len = v.getUint32(p + 4, true);
        const body = p + 8;
        // The last container of a chunk may be "open": its continuation lies in the following records.
        const next = Math.min(end, body + len);
        if ((verInst & 0x0f) === 0x0f) {
          if (depth < 8) walk(body, next, depth + 1);
        } else if (type === 0xf00a) shape.type = verInst >> 4;
        else if (type === 0xf010 && len >= 18) {
          shape.anchor = [];
          for (let i = 0; i < 8; i++) shape.anchor.push(v.getUint16(body + 2 + i * 2, true));
        } else if (type === 0xf00b) {
          const count = verInst >> 4;
          for (let i = 0; i < count && body + i * 6 + 6 <= next; i++) {
            const head = v.getUint16(body + i * 6, true);
            const value = v.getUint32(body + i * 6 + 2, true);
            const id = head & 0x3fff;
            if (id === 260 && !(head & 0x8000)) shape.blip = value;
            else if (id === 385 || id === 448) {
              const flags = value >>> 24;
              const color = flags & 0x08 ? this.color(value & 0xff) : flags ? undefined : `#${[value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
              if (id === 385) shape.fill = color;
              else shape.stroke = color;
            }
          }
        }
        if (next <= p) break;
        p = next;
      }
    };
    walk(0, bytes.length, 0);
    return shape;
  }

  private object(data: Uint8Array, v: DataView, texts: Map<number, string>): void {
    void texts;
    const shape = this.shapeOf();
    this.pendingObject = null;
    if (data.length < 8 || v.getUint16(0, true) !== 0x15) return;
    const kind = v.getUint16(4, true);
    const id = v.getUint16(6, true);
    const a = shape.anchor;
    // Cell comments are objects too, but they are shown differently.
    if (!a || kind === 0x19) return;
    const object: SheetObject = { c0: a[0], dx0: a[1] / 1024, r0: a[2], dy0: a[3] / 256, c1: a[4], dx1: a[5] / 1024, r1: a[6], dy1: a[7] / 256 };
    if (kind === 8) {
      const image = shape.blip ? this.blips[shape.blip - 1] : undefined;
      if (!image) return;
      object.image = image;
      this.objects.push(object);
    } else if (kind === 5) {
      this.pendingObject = { object, id, kind };
    } else {
      if (shape.fill) object.fill = shape.fill;
      if (shape.stroke) object.stroke = shape.stroke;
      if (shape.type === 3) object.shape = 'ellipse';
      else if (shape.type === 2) object.shape = 'round';
      this.textTargets.set(id, object);
      if (this.objects.length < 300) this.objects.push(object);
    }
  }

  // --- chart ---

  beginChart(): void {
    this.chart = { categories: [], series: [], palette: DEFAULT_PALETTE };
    this.chartTarget = this.pendingObject?.kind === 5 ? this.pendingObject.object : null;
    this.pendingObject = null;
    this.stack = [];
    this.series = [];
    this.groups = [];
    this.texts = [];
    this.categories = [];
    this.currentSeries = -1;
    this.axisParent = 0;
    this.cacheKind = 0;
  }

  chartRecord(id: number, data: Uint8Array): void {
    if (!this.chart) return;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const parent = this.stack[this.stack.length - 1] ?? 0;
    switch (id) {
      case 0x1033:
        this.stack.push(this.last);
        if (this.last === 0x1025) this.texts.push({});
        return;
      case 0x1034: {
        const closed = this.stack.pop();
        if (closed === 0x1003) this.currentSeries = -1;
        if (closed === 0x1006) this.formatSeries = -1;
        return;
      }
      case 0x1003:
        this.series.push({ kind: 'bar', values: [], group: 0 });
        this.currentSeries = this.series.length - 1;
        break;
      case 0x1051: {
        this.aiId = data.length ? data[0] : -1;
        // A reference to sheet cells: series values or category labels.
        const s = this.series[this.currentSeries];
        if (!s || parent !== 0x1003 || data.length < 9 || data[1] !== 2) break;
        const token = data[8] & 0x1f;
        let cells: (number | string | null)[] = [];
        if (token === 0x1b && data.length >= 19) cells = this.resolve(v.getUint16(9, true), v.getUint16(11, true), v.getUint16(13, true), v.getUint16(15, true) & 0xff, v.getUint16(17, true) & 0xff);
        else if (token === 0x1a && data.length >= 15) cells = this.resolve(v.getUint16(9, true), v.getUint16(11, true), v.getUint16(11, true), v.getUint16(13, true) & 0xff, v.getUint16(13, true) & 0xff);
        if (!cells.length) break;
        if (this.aiId === 1) s.values = cells.map((c) => (typeof c === 'number' ? c : null));
        else if (this.aiId === 2) {
          s.x = cells.map((c) => (typeof c === 'number' ? c : null));
          if (this.currentSeries === 0) this.categories = cells.map((c) => (c === null ? '' : String(c)));
        }
        break;
      }
      case 0x100d: {
        if (data.length < 4) break;
        const count = data[2];
        const wide = (data[3] & 1) !== 0;
        const bytes = data.subarray(4, 4 + count * (wide ? 2 : 1));
        const text = wide ? new TextDecoder('utf-16le').decode(bytes) : this.decode(bytes);
        if (parent === 0x1003 && this.currentSeries >= 0 && this.aiId === 0) this.series[this.currentSeries].name = text;
        else if (this.stack.includes(0x1025) && this.texts.length) this.texts[this.texts.length - 1].text = text;
        break;
      }
      case 0x1027:
        if (this.stack.includes(0x1025) && this.texts.length && data.length >= 2) this.texts[this.texts.length - 1].link = v.getUint16(0, true);
        break;
      case 0x1045:
        if (this.currentSeries >= 0 && data.length >= 2) this.series[this.currentSeries].group = v.getUint16(0, true);
        break;
      case 0x1006:
        if (data.length >= 4) {
          this.formatPoint = v.getUint16(0, true);
          this.formatSeries = parent === 0x1003 ? this.currentSeries : -1;
        }
        break;
      case 0x100a:
      case 0x1007: {
        // Series colour: fill for bars and slices, line for line charts.
        const s = this.series[this.formatSeries];
        if (!s || parent !== 0x1006 || this.formatPoint !== 0xffff || data.length < 4) break;
        const color = `#${[data[0], data[1], data[2]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
        const automatic = id === 0x100a ? data.length >= 10 && (v.getUint16(10, true) & 1) !== 0 : data.length >= 10 && (v.getUint16(8, true) & 1) !== 0;
        if (automatic) break;
        if (id === 0x100a) (s as { fillColor?: string }).fillColor = color;
        else (s as { lineColor?: string }).lineColor = color;
        break;
      }
      case 0x1041:
        this.axisParent = data.length >= 2 ? v.getUint16(0, true) : 0;
        break;
      case 0x1014:
        this.groups.push({ kind: 'bar', secondary: this.axisParent === 1 });
        break;
      case 0x1017:
      case 0x1018:
      case 0x1019:
      case 0x101a:
      case 0x101b:
      case 0x103e:
      case 0x1040: {
        const group = this.groups[this.groups.length - 1];
        if (!group || parent !== 0x1014) break;
        const flags = (at: number) => (data.length >= at + 2 ? v.getUint16(at, true) : 0);
        if (id === 0x1017) {
          group.kind = 'bar';
          if (flags(4) & 1) group.horizontal = true;
          if (flags(4) & 4) group.stacking = 'percent';
          else if (flags(4) & 2) group.stacking = 'stacked';
        } else if (id === 0x1018 || id === 0x101a) {
          group.kind = id === 0x1018 ? 'line' : 'area';
          if (flags(0) & 2) group.stacking = 'percent';
          else if (flags(0) & 1) group.stacking = 'stacked';
        } else if (id === 0x1019) {
          group.kind = 'pie';
          if (flags(2) > 0) group.hole = Math.min(0.9, flags(2) / 100);
        } else if (id === 0x101b) group.kind = 'scatter';
        else group.kind = 'radar';
        break;
      }
      case 0x1015:
        this.chart.legend = 'r';
        break;
      case 0x1065:
        this.cacheKind = data.length >= 2 ? v.getUint16(0, true) : 0;
        break;
      case 0x0203:
      case 0x0204: {
        if (data.length < 6 || !this.cacheKind) break;
        const point = v.getUint16(0, true);
        const index = v.getUint16(2, true);
        if (point > 100_000) break;
        const s = this.series[index];
        if (id === 0x0203 && data.length >= 14 && s) {
          const value = v.getFloat64(6, true);
          const target = this.cacheKind === 1 ? s.values : this.cacheKind === 2 ? (s.x ??= []) : undefined;
          if (target) {
            while (target.length < point) target.push(null);
            target[point] = value;
          }
          if (this.cacheKind === 2 && index === 0) this.categories[point] = String(value);
        } else if (id === 0x0204 && this.cacheKind === 2 && index === 0 && data.length >= 9) {
          const count = v.getUint16(6, true);
          const wide = (data[8] & 1) !== 0;
          const bytes = data.subarray(9, 9 + count * (wide ? 2 : 1));
          this.categories[point] = wide ? new TextDecoder('utf-16le').decode(bytes) : this.decode(bytes);
        }
        break;
      }
    }
    this.last = id;
  }

  endChart(): void {
    const chart = this.chart;
    const target = this.chartTarget;
    this.chart = null;
    this.chartTarget = null;
    if (!chart || !target) return;
    const main = this.groups[0];
    for (const s of this.series) {
      const group = this.groups[s.group] ?? main;
      if (!s.values.length || !group) continue;
      const kind = group.kind;
      const extra = s as { fillColor?: string; lineColor?: string };
      const series: ChartSeries = { kind, values: s.values };
      if (s.name) series.name = s.name;
      const color = kind === 'line' || kind === 'scatter' || kind === 'radar' ? extra.lineColor ?? extra.fillColor : extra.fillColor ?? extra.lineColor;
      if (color && kind !== 'pie') series.color = color;
      if (group.secondary) series.secondary = true;
      if (kind === 'scatter' && s.x) series.x = s.x;
      chart.series.push(series);
    }
    if (!chart.series.length || !main) return;
    if (main.horizontal) chart.horizontal = true;
    if (main.stacking) chart.stacking = main.stacking;
    if (main.hole) chart.hole = main.hole;
    const count = Math.max(...chart.series.map((s) => s.values.length));
    chart.categories = Array.from({ length: count }, (_, i) => this.categories[i] ?? String(i + 1));
    for (const t of this.texts) {
      if (!t.text) continue;
      if (t.link === 1) chart.title = t.text;
      else if (t.link === 2) chart.yTitle = t.text;
      else if (t.link === 3) chart.xTitle = t.text;
    }
    target.chart = chart;
    if (this.objects.length < 300) this.objects.push(target);
  }

  /** Transfers what was collected into the sheet. */
  finish(builder: SheetBuilder, styles: StyleTable, texts: Map<number, string>): void {
    this.flush();
    for (const [id, object] of this.textTargets) {
      const text = texts.get(id)?.trim();
      if (text) object.text = text;
    }
    for (const object of this.objects) {
      if (object.image || object.chart || object.text || object.fill) builder.addObject(object);
    }
    if (this.conditionals.length) {
      for (const c of this.conditionals) c.rules = c.rules.filter((r) => r.type !== 'unsupported');
      applyConditional(this.conditionals.filter((c) => c.rules.length), this.raw, builder, styles, (n) => (n?.attrs.rgb ? `#${n.attrs.rgb.slice(-6).toLowerCase()}` : undefined));
    }
  }
}
