/**
 * Common model of a tabular document for csv, xlsx, ods and xls.
 * Format parsers fill a SheetBuilder; the grid reads rows through a SheetModel.
 */

import type { ChartModel } from './chart';

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Text colour, #rrggbb. */
  color?: string;
  /** Fill colour, #rrggbb. */
  fill?: string;
  /** Cell borders: side letters t, r, b, l (for example "tb" or "trbl"). */
  border?: string;
  underline?: boolean;
  strike?: boolean;
  /** Font size in points if it differs from the default (11). */
  size?: number;
  /** Word wrap inside the cell. */
  wrap?: boolean;
  valign?: 'top' | 'middle';
  /** "Data bar" conditional formatting: fill share of the cell 0–1 and the bar colour. */
  bar?: { part: number; color: string };
  /** "Icon set" conditional formatting: a symbol before the value and its colour. */
  icon?: { char: string; color: string };
  /** Sparkline, a small chart in a cell: kind, values (null: a gap) and colour. */
  spark?: { kind: 'line' | 'column' | 'stacked'; values: (number | null)[]; color: string; negative?: string };
  /** Typeface, if it differs from the workbook default. */
  font?: string;
  /**
   * Line kinds of the borders, one character per letter of `border`:
   * s thin, m medium, k thick, d double, h dashed, o dotted.
   */
  lines?: string;
  /** Border colour, if not the default. */
  lineColor?: string;
  /** Pattern or gradient fill as a CSS background image, drawn over `fill`. */
  fillImage?: string;
  /** Text rotation in degrees counter-clockwise (−90…90); 255 is letters stacked top to bottom. */
  rot?: number;
}

/** A run of formatted text inside a cell. */
export interface CellRun {
  t: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  size?: number;
  font?: string;
  sup?: boolean;
  sub?: boolean;
}

/** An object above the sheet cells: a picture, a chart or a shape with text. */
export interface SheetObject {
  /** Anchor: row and column of the top-left and bottom-right corners and the offset inside the cell as a fraction of its size. */
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  dx0?: number;
  dy0?: number;
  dx1?: number;
  dy1?: number;
  /** Instead of the bottom-right corner: the offset from the anchor cell corner and the size in pixels (at 100% zoom). */
  ox?: number;
  oy?: number;
  w?: number;
  h?: number;
  image?: { mime: string; data: ArrayBuffer };
  chart?: ChartModel;
  text?: string;
  fill?: string;
  stroke?: string;
  shape?: 'rect' | 'round' | 'ellipse';
}

/** Merged cells; bounds are inclusive. */
export interface Merge {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface TableMeta {
  rowCount: number;
  columnCount: number;
  /** Column widths in characters. */
  columnWidths: number[];
  /** true if not all rows are shown (the limit was hit). */
  truncated: boolean;
  /** Style table; index 0 is reserved for "no style". */
  styles?: CellStyle[];
  merges?: Merge[];
  /**
   * Original row and column numbers (zero-based) when some are hidden in the file and not shown:
   * the grid headers then have gaps, as in Excel.
   */
  rowLabels?: number[];
  colLabels?: number[];
  /** Row heights that differ from the default: row number → how many times taller than the default. */
  rowHeights?: Record<number, number>;
  /** Cell comments: the key is "row:column". */
  notes?: Record<string, string>;
  /** Cells with several formats inside one text: the key is "row:column". */
  rich?: Record<string, CellRun[]>;
  /** Pictures, charts and shapes of the sheet. */
  objects?: SheetObject[];
}

export interface RowBlock {
  rows: (string[] | undefined)[];
  /** Cell style indices, parallel to rows. Absent if there are no styles. */
  styles?: (number[] | undefined)[];
}

export interface SheetModel {
  meta: TableMeta;
  getRows(start: number, end: number): RowBlock;
}

export interface Workbook {
  /** Names of the visible sheets. */
  sheets: string[];
  openSheet(index: number): Promise<SheetModel>;
}

export interface WorkbookOptions {
  maxRows: number;
  fallbackEncoding?: string;
  /** Language for number separators and month names (BCP 47). */
  lang?: string;
  /** Password for an encrypted xls workbook. */
  password?: string;
}

export const MIN_COL_CHARS = 4;
export const MAX_COL_CHARS = 40;
export const DEFAULT_COL_CHARS = 9;
const MAX_MERGES = 20_000;

/** The standard Excel indexed palette (indices 0–63). */
const INDEXED_COLORS = (
  '000000,FFFFFF,FF0000,00FF00,0000FF,FFFF00,FF00FF,00FFFF,000000,FFFFFF,FF0000,00FF00,0000FF,FFFF00,FF00FF,00FFFF,' +
  '800000,008000,000080,808000,800080,008080,C0C0C0,808080,9999FF,993366,FFFFCC,CCFFFF,660066,FF8080,0066CC,CCCCFF,000080,FF00FF,FFFF00,00FFFF,800080,800000,008080,0000FF,00' +
  'CCFF,CCFFFF,CCFFCC,FFFF99,99CCFF,FF99CC,CC99FF,FFCC99,3366FF,33CCCC,99CC00,FFCC00,FF9900,FF6600,666699,969696,003366,339966,003300,333300,993300,993366,333399,333333'
).split(',');

export function indexedColor(index: number, palette?: string[]): string | undefined {
  if (palette && palette[index]) return palette[index];
  const hex = INDEXED_COLORS[index];
  return hex ? `#${hex.toLowerCase()}` : undefined;
}

/** Style table without duplicates. */
export class StyleTable {
  readonly list: CellStyle[] = [{}];
  private index = new Map<string, number>();

  add(style: CellStyle | undefined): number {
    if (!style) return 0;
    let empty = true;
    for (const k in style) {
      const v = (style as Record<string, unknown>)[k];
      if (v !== undefined && v !== false && v !== '') empty = false;
    }
    if (empty) return 0;
    const key = JSON.stringify(Object.keys(style).sort().map((k) => [k, (style as Record<string, unknown>)[k]]));
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(style);
      this.index.set(key, id);
    }
    return id;
  }
}

/** Accumulator of sheet data. Rows are sparse: empty rows and cells take no memory. */
export class SheetBuilder {
  private rows: (string[] | undefined)[] = [];
  private styleRows: (number[] | undefined)[] = [];
  private widths = new Map<number, number>();
  private merges: Merge[] = [];
  private hiddenRows = new Set<number>();
  private heights = new Map<number, number>();
  private notes = new Map<number, string>();
  private rich = new Map<number, CellRun[]>();
  private objects: SheetObject[] = [];
  /** Default row height in points. */
  defaultHeight = 15;
  private hiddenCols = new Set<number>();
  private maxRow = -1;
  private maxCol = -1;
  private maxStyleRow = -1;
  private maxStyleCol = -1;
  private hasStyles = false;
  truncated = false;
  defaultWidth = DEFAULT_COL_CHARS;

  constructor(private readonly maxRows: number) {}

  /** Text of a cell already written to the sheet. */
  textAt(row: number, col: number): string {
    return this.rows[row]?.[col] ?? '';
  }

  set(row: number, col: number, text: string, style = 0): void {
    if (row >= this.maxRows) {
      this.truncated = true;
      return;
    }
    if (text === '' && style === 0) return;
    if (col > 16383 || row < 0 || col < 0) return;
    if (text !== '') {
      (this.rows[row] ??= [])[col] = text;
    }
    if (style !== 0) {
      (this.styleRows[row] ??= [])[col] = style;
      this.hasStyles = true;
    }
    if (text !== '') {
      if (row > this.maxRow) this.maxRow = row;
      if (col > this.maxCol) this.maxCol = col;
    } else {
      if (row > this.maxStyleRow) this.maxStyleRow = row;
      if (col > this.maxStyleCol) this.maxStyleCol = col;
    }
  }

  setWidth(col: number, chars: number): void {
    if (col >= 0 && col <= 16383 && chars > 0) this.widths.set(col, chars);
  }

  /** Row height in points. */
  setHeight(row: number, points: number): void {
    if (row >= 0 && row < this.maxRows && points > 0 && this.heights.size < 200_000) this.heights.set(row, points);
  }

  /** Formatted runs of a cell whose text has already been set. */
  setRich(row: number, col: number, runs: CellRun[]): void {
    if (runs.length > 1 && row >= 0 && row < this.maxRows && col >= 0 && col <= 16383 && this.rich.size < 5000) this.rich.set(row * 16384 + col, runs);
  }

  addNote(row: number, col: number, text: string): void {
    if (text && row >= 0 && col >= 0 && col <= 16383 && this.notes.size < 20_000) this.notes.set(row * 16384 + col, text);
  }

  addObject(object: SheetObject): void {
    if (this.objects.length < 300) this.objects.push(object);
  }

  /** Column width in characters and row height in points, as given in the file. */
  widthOf(col: number): number {
    return this.widths.get(col) ?? this.defaultWidth;
  }

  heightOf(row: number): number {
    return this.heights.get(row) ?? this.defaultHeight;
  }

  /** Cell style (0: no style). */
  styleAt(row: number, col: number): number {
    return this.styleRows[row]?.[col] ?? 0;
  }

  /** Changes the style of an already written cell (conditional formatting). */
  restyle(row: number, col: number, style: number, content = false): void {
    if (row >= this.maxRows || row < 0 || col < 0 || col > 16383) return;
    (this.styleRows[row] ??= [])[col] = style;
    if (!style) return;
    this.hasStyles = true;
    // A cell that shows something by its style alone (a sparkline) counts as content: the sheet must reach it.
    if (content) {
      if (row > this.maxRow) this.maxRow = row;
      if (col > this.maxCol) this.maxCol = col;
    } else {
      if (row > this.maxStyleRow) this.maxStyleRow = row;
      if (col > this.maxStyleCol) this.maxStyleCol = col;
    }
  }

  /** Rows and columns hidden in the file are not shown: Excel does the same. */
  hideRow(row: number): void {
    if (row >= 0 && row < 1_048_576) this.hiddenRows.add(row);
  }

  hideCol(col: number): void {
    if (col >= 0 && col <= 16383) this.hiddenCols.add(col);
  }

  /** Removes hidden rows and columns, remembering the original numbers of the remaining ones. */
  private dropHidden(rowCount: number, columnCount: number): { rowLabels?: number[]; colLabels?: number[] } {
    const out: { rowLabels?: number[]; colLabels?: number[] } = {};
    const hasRows = [...this.hiddenRows].some((r) => r < rowCount);
    const hasCols = [...this.hiddenCols].some((c) => c < columnCount);
    if (!hasRows && !hasCols) return out;
    const keepRows: number[] = [];
    for (let r = 0; r < rowCount; r++) if (!this.hiddenRows.has(r)) keepRows.push(r);
    const keepCols: number[] = [];
    for (let c = 0; c < columnCount; c++) if (!this.hiddenCols.has(c)) keepCols.push(c);
    const pick = <T>(row: T[] | undefined): T[] | undefined => {
      if (!row || !hasCols) return row;
      const next: T[] = [];
      keepCols.forEach((c, i) => {
        if (row[c] !== undefined) next[i] = row[c];
      });
      return next;
    };
    this.rows = keepRows.map((r) => pick(this.rows[r]));
    this.styleRows = keepRows.map((r) => pick(this.styleRows[r]));
    if (hasCols) {
      const widths = new Map<number, number>();
      keepCols.forEach((c, i) => {
        const w = this.widths.get(c);
        if (w !== undefined) widths.set(i, w);
      });
      this.widths = widths;
    }
    // Merges shrink to their visible part; completely hidden ones disappear.
    const rowIndex = new Map(keepRows.map((r, i) => [r, i]));
    const colIndex = new Map(keepCols.map((c, i) => [c, i]));
    const span = (from: number, to: number, index: Map<number, number>): [number, number] | null => {
      let first = -1;
      let lastSeen = -1;
      for (let i = from; i <= to; i++) {
        const v = index.get(i);
        if (v === undefined) continue;
        if (first < 0) first = v;
        lastSeen = v;
      }
      return first < 0 ? null : [first, lastSeen];
    };
    const merges: Merge[] = [];
    for (const m of this.merges) {
      const rs = span(m.r0, Math.min(m.r1, m.r0 + 100_000), rowIndex);
      const cs = span(m.c0, m.c1, colIndex);
      if (rs && cs && (rs[1] > rs[0] || cs[1] > cs[0])) merges.push({ r0: rs[0], r1: rs[1], c0: cs[0], c1: cs[1] });
    }
    this.merges = merges;
    const heights = new Map<number, number>();
    for (const [r, h] of this.heights) {
      const i = rowIndex.get(r);
      if (i !== undefined) heights.set(i, h);
    }
    this.heights = heights;
    const notes = new Map<number, string>();
    for (const [key, text] of this.notes) {
      const r = rowIndex.get(Math.floor(key / 16384));
      const c = colIndex.get(key % 16384);
      if (r !== undefined && c !== undefined) notes.set(r * 16384 + c, text);
    }
    this.notes = notes;
    const rich = new Map<number, CellRun[]>();
    for (const [key, runs] of this.rich) {
      const r = rowIndex.get(Math.floor(key / 16384));
      const c = colIndex.get(key % 16384);
      if (r !== undefined && c !== undefined) rich.set(r * 16384 + c, runs);
    }
    this.rich = rich;
    // Objects are anchored to cells: shift them together with the remaining rows and columns.
    const shift = (value: number, keep: number[]) => {
      let lo = 0;
      let hi = keep.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keep[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const o of this.objects) {
      o.r0 = shift(o.r0, keepRows);
      o.r1 = shift(o.r1, keepRows);
      o.c0 = shift(o.c0, keepCols);
      o.c1 = shift(o.c1, keepCols);
    }
    if (hasRows) out.rowLabels = keepRows;
    if (hasCols) out.colLabels = keepCols;
    return out;
  }

  private rowHeightRatios(rowCount: number): Record<number, number> | undefined {
    const out: Record<number, number> = {};
    let any = false;
    for (const [r, h] of this.heights) {
      const ratio = Math.round((h / this.defaultHeight) * 100) / 100;
      if (r < rowCount && Math.abs(ratio - 1) > 0.08) {
        out[r] = Math.min(Math.max(ratio, 0.4), 30);
        any = true;
      }
    }
    return any ? out : undefined;
  }

  addMerge(m: Merge): void {
    if (this.merges.length < MAX_MERGES && (m.r1 > m.r0 || m.c1 > m.c0)) this.merges.push(m);
  }

  build(styles: CellStyle[]): SheetModel {
    // Empty styled cells extend the sheet only slightly beyond the data:
    // otherwise a column "painted to the end" would turn the sheet into thousands of empty rows.
    let rowCount = this.maxRow < 0 ? 0 : Math.max(this.maxRow, Math.min(this.maxStyleRow, this.maxRow + 50)) + 1;
    let columnCount = this.maxCol < 0 ? 0 : Math.max(this.maxCol, Math.min(this.maxStyleCol, this.maxCol + 10)) + 1;
    // The sheet must fit its pictures and charts even if there is no data under them.
    for (const o of this.objects) {
      rowCount = Math.max(rowCount, Math.min(o.r1 + 2, this.maxRows, rowCount + 400));
      columnCount = Math.max(columnCount, Math.min(o.c1 + 2, 16384, columnCount + 60));
    }
    this.merges = this.merges.filter((m) => m.r0 < rowCount && m.c0 < Math.max(columnCount, 1));
    for (const m of this.merges) if (m.c1 + 1 > columnCount) columnCount = Math.min(m.c1 + 1, 16384);
    const { rowLabels, colLabels } = this.dropHidden(rowCount, columnCount);
    if (rowLabels) rowCount = rowLabels.length;
    if (colLabels) columnCount = colLabels.length;
    const merges = this.merges;

    // Columns without a given width get one fitted to the content of the first rows.
    const widths = new Array<number>(columnCount).fill(0);
    const auto = new Array<number>(columnCount).fill(0);
    const sample = Math.min(rowCount, 200);
    const inMerge = (r: number, c: number) => merges.some((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1 && m.c1 > m.c0);
    for (let r = 0; r < sample; r++) {
      const row = this.rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (!v || this.widths.has(c)) continue;
        if (merges.length && merges.length < 500 && inMerge(r, c)) continue; // a wide header must not inflate the column
        let len = 0;
        for (const line of v.split('\n')) if (line.length > len) len = line.length;
        if (len > auto[c]) auto[c] = len;
      }
    }
    for (let c = 0; c < columnCount; c++) {
      const explicit = this.widths.get(c);
      widths[c] = explicit !== undefined ? Math.min(Math.max(explicit, 1.5), 80) : Math.min(Math.max(auto[c] + 1, this.defaultWidth, MIN_COL_CHARS), MAX_COL_CHARS);
    }

    const rows = this.rows;
    const styleRows = this.hasStyles ? this.styleRows : undefined;
    return {
      meta: {
        rowCount,
        columnCount,
        columnWidths: widths,
        truncated: this.truncated,
        styles: styleRows ? styles : undefined,
        merges: merges.length ? merges : undefined,
        rowLabels,
        colLabels,
        rowHeights: this.rowHeightRatios(rowCount),
        rich: this.rich.size ? Object.fromEntries([...this.rich].filter(([k]) => Math.floor(k / 16384) < rowCount).map(([k, v]) => [`${Math.floor(k / 16384)}:${k % 16384}`, v])) : undefined,
        notes: this.notes.size ? Object.fromEntries([...this.notes].filter(([k]) => Math.floor(k / 16384) < rowCount).map(([k, v]) => [`${Math.floor(k / 16384)}:${k % 16384}`, v])) : undefined,
        objects: this.objects.length ? this.objects : undefined,
      },
      getRows(start, end) {
        const from = Math.max(0, start);
        const to = Math.min(rowCount, end);
        const block: RowBlock = { rows: [] };
        if (styleRows) block.styles = [];
        for (let r = from; r < to; r++) {
          block.rows.push(rows[r]);
          if (styleRows) block.styles!.push(styleRows[r]);
        }
        return block;
      },
    };
  }
}

/** "A1" → { row: 0, col: 0 }. Returns null for an invalid reference. */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c === 36 /* $ */) continue;
    if (c >= 65 && c <= 90) col = col * 26 + (c - 64);
    else if (c >= 97 && c <= 122) col = col * 26 + (c - 96);
    else break;
  }
  let row = 0;
  let digits = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c === 36) continue;
    if (c < 48 || c > 57) return null;
    row = row * 10 + (c - 48);
    digits++;
  }
  if (col === 0 || digits === 0 || row === 0) return null;
  return { row: row - 1, col: col - 1 };
}

export function parseRangeRef(ref: string): Merge | null {
  const [a, b] = ref.split(':');
  const start = parseCellRef(a);
  const end = b ? parseCellRef(b) : start;
  if (!start || !end) return null;
  return { r0: Math.min(start.row, end.row), c0: Math.min(start.col, end.col), r1: Math.max(start.row, end.row), c1: Math.max(start.col, end.col) };
}
