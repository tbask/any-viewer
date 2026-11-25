/**
 * Common model of a text document for docx, odt, rtf and doc.
 * Parsers build it in a worker; the renderer turns the model into DOM (without innerHTML: file content
 * is never interpreted as markup).
 *
 * The model describes content and basic formatting, not exact page layout:
 * a document is shown as one continuous scroll, without pages.
 */

import type { ChartModel } from './chart';
import type { SlideShape } from './slidemodel';

/** Formatting of a text run. A flag value of 0 means "explicitly off" (needed for style inheritance). */
export interface RunStyle {
  b?: 0 | 1;
  i?: 0 | 1;
  u?: 0 | 1;
  s?: 0 | 1;
  va?: 'sup' | 'sub' | '';
  /** Font size in points. */
  size?: number;
  color?: string;
  bg?: string;
  mono?: 0 | 1;
  /** Font name from the document. */
  font?: string;
  /** Letter outline colour (WordArt). */
  outline?: string;
  /** Text shadow. */
  shadow?: 0 | 1;
  /** Hidden text: does not reach the model (parsers need it only for style inheritance). */
  hide?: 0 | 1;
  /** Small capitals or all capitals. */
  caps?: 'small' | 'all' | '';
  /** Letter spacing in points (negative: condensed). */
  ls?: number;
  /** Horizontal character scale: 1.5 is 150%. */
  scale?: number;
  /** Underline kind other than a single line. */
  ul?: 'double' | 'wavy' | 'dotted' | 'dashed';
  /** Double strikethrough. */
  ds?: 0 | 1;
  /** Overline. */
  over?: 0 | 1;
  /** Glow colour. */
  glow?: string;
}

/** Equation: a tree of fractions, powers, roots and plain text. */
export type MathNode =
  | { t: 'text'; v: string; upright?: boolean }
  | { t: 'row'; items: MathNode[] }
  | { t: 'frac'; num: MathNode; den: MathNode }
  | { t: 'script'; base: MathNode; sub?: MathNode; sup?: MathNode }
  | { t: 'rad'; deg?: MathNode; e: MathNode }
  /** Sum, integral and similar signs with limits and the expression under the sign. */
  | { t: 'nary'; chr: string; sub?: MathNode; sup?: MathNode; e: MathNode }
  | { t: 'delim'; open: string; close: string; sep: string; items: MathNode[] }
  /** A bar or accent above an expression. */
  | { t: 'over'; e: MathNode; mark: string }
  | { t: 'lim'; e: MathNode; lim: MathNode; upper?: boolean }
  | { t: 'matrix'; rows: MathNode[][] };

export type Inline =
  | { k: 'text'; text: string; s?: RunStyle; href?: string }
  | { k: 'br' }
  | { k: 'tab' }
  | {
      k: 'img';
      id: string;
      w?: number;
      h?: number;
      /** Text wraps around the picture on the other side. */
      float?: 'left' | 'right';
      /** The picture lies behind the text: offset in pixels from the paragraph corner. */
      behind?: { x: number; y: number };
      /** Fractions cut off the left, top, right and bottom. */
      crop?: [number, number, number, number];
      /** CSS border, e.g. `2px solid #ff0000`. */
      border?: string;
      /** Rotation in degrees. */
      rot?: number;
    }
  | { k: 'math'; node: MathNode; /** Font size in points, if the formula has its own frame. */ size?: number };

/** Paragraph formatting; indents and spacing in points. */
export interface ParaStyle {
  align?: 'left' | 'center' | 'right' | 'justify';
  ml?: number;
  mr?: number;
  /** First-line indent (negative: hanging). */
  ti?: number;
  mt?: number;
  mb?: number;
  /** Line spacing as a multiplier. */
  lh?: number;
  /** Heading level 1–6. */
  heading?: number;
  bg?: string;
  /** Paragraph border colour. */
  border?: string;
  /** Drop cap: how many lines tall and how many leading characters. */
  dropCap?: { lines: number; chars: number };
  /** Tab stops, in points from the left text edge. */
  tabs?: TabStop[];
}
export interface TabStop {
  pos: number;
  align?: 'right' | 'center' | 'decimal';
  /** Leader character that fills the gap: `.`, `-` or `_`. */
  leader?: string;
}


export interface TabStop {
  pos: number;
  align?: 'right' | 'center' | 'decimal';
  /** Leader character that fills the gap: `.`, `-` or `_`. */
  leader?: string;
}

export interface TableCell {
  blocks: Block[];
  colSpan?: number;
  rowSpan?: number;
  bg?: string;
  /** The cell is absorbed by a vertical merge and is not output. */
  skip?: boolean;
  /** Vertical text: top to bottom or bottom to top. */
  vert?: 'tb' | 'bt';
  /** Vertical alignment of the content. */
  va?: 'middle' | 'bottom';
}

export interface TableRow {
  cells: TableCell[];
  /** Minimum row height in points. */
  h?: number;
  /** Header row (repeated on every page in the source). */
  head?: boolean;
}

export type Block =
  | { k: 'p'; runs: Inline[]; s?: ParaStyle; marker?: string; level?: number }
  | { k: 'table'; rows: TableRow[]; widths?: number[]; float?: 'left' | 'right'; w?: number }
  /** A frame or text box: its own blocks, optionally floated beside the text. */
  | { k: 'frame'; blocks: Block[]; float?: 'left' | 'right'; w?: number; bg?: string; border?: string }
  | { k: 'pagebreak' }
  /** Separator of a service part of the document with a caption: header/footer, footnotes, comments. */
  | { k: 'rule'; label?: string }
  /** Chart; sizes in pixels. */
  | { k: 'chart'; chart: ChartModel; w: number; h: number }
  /** Canvas with shapes (Word shapes, SmartArt); shape coordinates are pixels from the canvas corner. */
  | { k: 'canvas'; w: number; h: number; shapes: SlideShape[] };

export interface DocImage {
  mime: string;
  data: ArrayBuffer;
}

export interface DocModel {
  blocks: Block[];
  /** Page watermark ("CONFIDENTIAL"). */
  watermark?: string;
  /** Picture watermark: an image id. */
  watermarkImage?: string;
  /** Page background colour. */
  pageBg?: string;
  images: Record<string, DocImage>;
  /** Page width and side margins in points, if known. */
  pageWidth?: number;
  marginLeft?: number;
  marginRight?: number;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Image MIME type by file name; undefined: a format the browser cannot show (emf, wmf, tiff). */
export function imageMime(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? undefined : IMAGE_MIME[path.slice(dot + 1).toLowerCase()];
}

/** Image MIME type by signature in the data. */
export function sniffImageMime(b: Uint8Array): string | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return undefined;
}

/** Lays a partial style over a base one (undefined values do not overwrite base values). */
export function mergeStyle<T extends object>(base: T | undefined, over: Partial<T> | undefined): T {
  const out = { ...(base as T) };
  if (over) {
    for (const key in over) {
      const v = over[key];
      if (v !== undefined) (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

/** Removes "off" flags and empty values from a style: only what matters reaches the model. */
export function compactRunStyle(style: RunStyle): RunStyle | undefined {
  const out: RunStyle = {};
  let any = false;
  for (const key in style) {
    const v = (style as Record<string, unknown>)[key];
    if (v !== undefined && v !== 0 && v !== '') {
      (out as Record<string, unknown>)[key] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Captions of the service parts of a document; they come from the viewer settings. */
export interface DocPartLabels {
  header?: string;
  footer?: string;
  footnotes?: string;
  endnotes?: string;
  comments?: string;
}

/** Whether the blocks have anything to show (text or a picture). */
export function hasVisibleContent(blocks: Block[]): boolean {
  return blocks.some((b) => (b.k === 'p' ? b.runs.some((r) => r.k === 'img' || r.k === 'math' || (r.k === 'text' && r.text.trim() !== '')) : b.k === 'table' || b.k === 'chart' || b.k === 'canvas'));
}

/** Appends a service part to the document under a captioned separator. Empty parts are skipped. */
export function appendPart(out: Block[], label: string | undefined, part: Block[], atStart = false): void {
  if (!hasVisibleContent(part)) return;
  if (atStart) out.unshift(...part, { k: 'rule', label });
  else out.push({ k: 'rule', label }, ...part);
}

/** Puts the footnote or comment number at the start of its first paragraph. */
export function prefixNote(blocks: Block[], mark: string): Block[] {
  const first = blocks.find((b) => b.k === 'p');
  if (first && first.k === 'p') first.runs.unshift({ k: 'text', text: `${mark} `, s: { va: 'sup' } });
  else blocks.unshift({ k: 'p', runs: [{ k: 'text', text: mark, s: { va: 'sup' } }] });
  return blocks;
}

/** A number in the given list numbering system. */
export function formatCounter(n: number, format: string): string {
  switch (format) {
    case 'lowerLetter':
    case 'a':
      return letters(n, 'abcdefghijklmnopqrstuvwxyz');
    case 'upperLetter':
    case 'A':
      return letters(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    case 'russianLower':
    case 'а, б, .., я, аа, аб, ... (cyrillic alphabet sequence)':
    case 'а':
      return letters(n, 'абвгдежзиклмнопрстуфхцчшщэюя');
    case 'russianUpper':
    case 'А':
      return letters(n, 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ');
    case 'lowerRoman':
    case 'i':
      return roman(n).toLowerCase();
    case 'upperRoman':
    case 'I':
      return roman(n);
    case 'decimalZero':
      return n < 10 ? `0${n}` : String(n);
    case 'none':
      return '';
    default:
      return String(n);
  }
}

function letters(n: number, alphabet: string): string {
  if (n <= 0) return String(n);
  const len = alphabet.length;
  const repeat = Math.floor((n - 1) / len) + 1;
  return alphabet[(n - 1) % len].repeat(Math.min(repeat, 10));
}

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, sym] of table) {
    while (n >= value) {
      out += sym;
      n -= value;
    }
  }
  return out;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

export function highlightColor(name: string | undefined): string | undefined {
  return name ? HIGHLIGHT[name] : undefined;
}

/** Normalises a colour to #rrggbb; "auto" and invalid values are dropped. */
export function hexColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.startsWith('#') ? value.slice(1) : value;
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : undefined;
}

/**
 * Restores horizontal cell merges and column widths from cell boundaries.
 * In rtf and doc every table row has its own list of right cell edges; the common column grid is
 * the union of all edges. A cell spanning several grid columns gets a colSpan.
 * @returns grid column widths, or undefined if the edges are unknown
 */
export function applyCellEdges(rows: TableRow[], rowEdges: (number[] | undefined)[]): number[] | undefined {
  const all = new Set<number>();
  for (let r = 0; r < rows.length; r++) {
    const edges = rowEdges[r];
    if (!edges || edges.length < rows[r].cells.length) return undefined;
    for (const e of edges) all.add(e);
  }
  // Edges that differ by a couple of units count as one: many editors write them that way.
  const grid: number[] = [];
  for (const e of [...all].sort((a, b) => a - b)) {
    if (!grid.length || e - grid[grid.length - 1] > 15) grid.push(e);
  }
  if (grid.length === 0) return undefined;
  const indexOf = (edge: number) => {
    let best = 0;
    for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i] - edge) < Math.abs(grid[best] - edge)) best = i;
    return best;
  };
  for (let r = 0; r < rows.length; r++) {
    const edges = rowEdges[r]!;
    let prev = -1;
    rows[r].cells.forEach((cell, i) => {
      const at = indexOf(edges[i]);
      const span = at - prev;
      if (span > 1) cell.colSpan = span;
      prev = Math.max(prev, at);
    });
  }
  const widths = grid.map((e, i) => e - (i === 0 ? Math.min(0, grid[0] - 1) : grid[i - 1]));
  return widths.every((w) => w > 0) ? widths : undefined;
}

/**
 * CSS font-family value for a document font: the font itself (if the device has it)
 * and a fallback family of the same class: serif, sans-serif or monospace.
 */
export function fontFamilyCss(name: string): string {
  const clean = name.replace(/["\\;{}]/g, '').trim();
  const generic = /courier|consolas|mono|lucida console/i.test(clean)
    ? 'monospace'
    : /sans/i.test(clean)
      ? 'sans-serif'
      : /times|serif|georgia|garamond|cambria|palatino|bookman|book antiqua|century|minion|constantia|liberation serif|pt astra/i.test(clean)
        ? 'serif'
        : 'sans-serif';
  const fallback = generic === 'serif' ? '"Times New Roman", Times, serif' : generic === 'monospace' ? 'ui-monospace, Consolas, monospace' : 'Arial, Helvetica, sans-serif';
  return `"${clean}", ${fallback}`;
}
