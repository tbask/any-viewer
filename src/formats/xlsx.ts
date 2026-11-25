/**
 * Reader of xlsx (Office Open XML SpreadsheetML).
 * A workbook is a zip archive of XML: shared strings, styles, a file per sheet. Sheets are parsed as a stream and lazily:
 * until the user opens a sheet, its XML is not read.
 */
import { builtinFormat, createLocale, formatGeneral, formatValue, type NumFmtLocale } from '../core/numfmt';
import { indexedColor, parseCellRef, parseRangeRef, SheetBuilder, StyleTable, type CellRun, type CellStyle, type SheetModel, type Workbook, type WorkbookOptions } from '../core/workbook';
import { attr, child, childrenOf, decodeXmlBytes, localName, parseXml, parseXmlSax, type XmlNode } from '../core/xml';
import { makeColorResolver, readThemeColors } from '../core/chart';
import { ZipReader } from '../core/zip';
import { applyConditional, applyTableStyle, inConditional, needsAllValues, parseConditional, parseSparklines, sheetNumbers, readComments, readDrawing, readRels, type Conditional } from './xlsx-extras';

interface Xf {
  format: string | undefined;
  style: number;
  /** Style for numeric values: without explicit alignment numbers are right-aligned, as in Excel. */
  numStyle: number;
}

/** Lightens (tint > 0) or darkens (tint < 0) a colour: this is how xlsx gives shades of theme colours. */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const out = tint < 0 ? v * (1 + tint) : v + (255 - v) * tint;
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Strings like _x000D_ in xlsx are escaped control characters. */
function unescapeXlsx(s: string): string {
  return s.indexOf('_x') < 0 ? s : s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

async function readXml(zip: ZipReader, path: string): Promise<XmlNode | undefined> {
  const entry = zip.get(path);
  if (!entry) return undefined;
  return parseXml(decodeXmlBytes(await zip.read(entry)));
}

/** Shared strings; `rich` holds the formatted runs of strings that have more than one format. */
interface SharedStrings {
  list: string[];
  rich: Map<number, CellRun[]>;
}

async function readSharedStrings(zip: ZipReader, path: string, theme: string[]): Promise<SharedStrings> {
  const entry = zip.get(path);
  const out: SharedStrings = { list: [], rich: new Map() };
  if (!entry) return out;
  let cur = '';
  let inT = false;
  let phonetic = 0;
  let runs: CellRun[] = [];
  let run: CellRun | undefined;
  let inRPr = false;
  parseXmlSax(decodeXmlBytes(await zip.read(entry)), {
    open(name, attrs) {
      const n = localName(name);
      if (n === 'si') {
        cur = '';
        runs = [];
      } else if (n === 'rPh') phonetic++;
      else if (n === 't') inT = true;
      else if (n === 'r' && phonetic === 0) run = { t: '' };
      else if (n === 'rPr') inRPr = true;
      else if (inRPr && run) {
        const off = attrs.val === '0' || attrs.val === 'false';
        if (n === 'b') run.bold = !off;
        else if (n === 'i') run.italic = !off;
        else if (n === 'strike') run.strike = !off;
        else if (n === 'u') run.underline = attrs.val !== 'none';
        else if (n === 'sz') run.size = Number(attrs.val) || undefined;
        else if (n === 'rFont') run.font = attrs.val;
        else if (n === 'vertAlign') {
          if (attrs.val === 'superscript') run.sup = true;
          else if (attrs.val === 'subscript') run.sub = true;
        } else if (n === 'color') {
          const color = attrs.rgb && attrs.rgb.length >= 6 ? `#${attrs.rgb.slice(-6).toLowerCase()}` : attrs.theme !== undefined ? theme[Number(attrs.theme)] : undefined;
          if (color && color !== '#000000') run.color = color;
        }
      }
    },
    close(name) {
      const n = localName(name);
      if (n === 'si') {
        if (runs.length > 1 && out.rich.size < 5000 && runs.some((r) => Object.keys(r).length > 1)) out.rich.set(out.list.length, runs);
        out.list.push(unescapeXlsx(cur));
      } else if (n === 'rPh') phonetic--;
      else if (n === 't') inT = false;
      else if (n === 'rPr') inRPr = false;
      else if (n === 'r' && run) {
        run.t = unescapeXlsx(run.t);
        if (run.t) runs.push(run);
        run = undefined;
      }
    },
    text(t) {
      if (inT && phonetic === 0) {
        cur += t;
        if (run) run.t += t;
        else if (t) runs.push({ t: unescapeXlsx(t) });
      }
    },
  });
  return out;
}

function readTheme(root: XmlNode | undefined): string[] {
  const scheme = child(child(root, 'themeElements'), 'clrScheme');
  if (!scheme) return [];
  const byName: Record<string, string> = {};
  for (const node of childrenOf(scheme)) {
    const srgb = child(node, 'srgbClr');
    const sys = child(node, 'sysClr');
    const value = attr(srgb, 'val') ?? attr(sys, 'lastClr');
    if (value) byName[localName(node.name)] = `#${value.toLowerCase()}`;
  }
  // Order of theme indices in SpreadsheetML: light 1, dark 1, light 2, dark 2, accents.
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((k) => byName[k]);
}

function readColor(node: XmlNode | undefined, theme: string[]): string | undefined {
  if (!node) return undefined;
  const rgb = attr(node, 'rgb');
  const tint = Number(attr(node, 'tint') ?? 0) || 0;
  let color: string | undefined;
  if (rgb && rgb.length >= 6) color = `#${rgb.slice(-6).toLowerCase()}`;
  else if (attr(node, 'theme') !== undefined) color = theme[Number(attr(node, 'theme'))];
  else if (attr(node, 'indexed') !== undefined) color = indexedColor(Number(attr(node, 'indexed')));
  return color ? applyTint(color, tint) : undefined;
}

/** An Excel fill pattern as a CSS background image. */
export function patternCss(type: string, ink: string): string {
  const stripe = (angle: number, step: number, width: number) => `repeating-linear-gradient(${angle}deg, ${ink} 0 ${width}px, transparent ${width}px ${step}px)`;
  const alpha = (part: number) => Math.round(part * 255).toString(16).padStart(2, '0');
  const shade = (part: number) => `linear-gradient(${ink}${alpha(part)}, ${ink}${alpha(part)})`;
  switch (type) {
    case 'darkGray': return shade(0.75);
    case 'mediumGray': return shade(0.5);
    case 'lightGray': return shade(0.25);
    case 'gray125': return shade(0.125);
    case 'gray0625': return shade(0.0625);
    case 'darkHorizontal': return stripe(0, 4, 2);
    case 'lightHorizontal': return stripe(0, 4, 1);
    case 'darkVertical': return stripe(90, 4, 2);
    case 'lightVertical': return stripe(90, 4, 1);
    case 'darkDown': return stripe(45, 5, 2);
    case 'lightDown': return stripe(45, 5, 1);
    case 'darkUp': return stripe(135, 5, 2);
    case 'lightUp': return stripe(135, 5, 1);
    case 'darkGrid': return `${stripe(0, 4, 2)}, ${stripe(90, 4, 2)}`;
    case 'lightGrid': return `${stripe(0, 4, 1)}, ${stripe(90, 4, 1)}`;
    case 'darkTrellis': return `${stripe(45, 4, 2)}, ${stripe(135, 4, 2)}`;
    case 'lightTrellis': return `${stripe(45, 5, 1)}, ${stripe(135, 5, 1)}`;
    default: return shade(0.5);
  }
}

function readStyles(root: XmlNode | undefined, theme: string[], styles: StyleTable): { xfs: Xf[]; dxfs: CellStyle[] } {
  if (!root) return { xfs: [], dxfs: [] };
  const formats = new Map<number, string>();
  for (const f of childrenOf(child(root, 'numFmts'), 'numFmt')) {
    const id = Number(attr(f, 'numFmtId'));
    const code = attr(f, 'formatCode');
    if (code !== undefined) formats.set(id, code);
  }
  const fonts = childrenOf(child(root, 'fonts'), 'font').map((f) => {
    const flag = (name: string) => {
      const n = child(f, name);
      return !!n && attr(n, 'val') !== '0' && attr(n, 'val') !== 'false';
    };
    let color = readColor(child(f, 'color'), theme);
    if (color === '#000000') color = undefined;
    const u = child(f, 'u');
    const size = Number(attr(child(f, 'sz'), 'val'));
    return { bold: flag('b'), italic: flag('i'), color, underline: !!u && attr(u, 'val') !== 'none', strike: flag('strike'), size: Number.isFinite(size) && size > 0 ? size : undefined, name: attr(child(f, 'name'), 'val') };
  });
  const baseSize = fonts[0]?.size ?? 11;
  const baseFont = fonts[0]?.name;
  const fills = childrenOf(child(root, 'fills'), 'fill').map((f): { color?: string; image?: string } | undefined => {
    const gradient = child(f, 'gradientFill');
    if (gradient) {
      const stops = childrenOf(gradient, 'stop').map((st) => `${readColor(child(st, 'color'), theme) ?? '#ffffff'} ${Math.round(Number(attr(st, 'position') ?? 0) * 100)}%`);
      if (stops.length < 2) return undefined;
      const image = attr(gradient, 'type') === 'path' ? `radial-gradient(${stops.join(', ')})` : `linear-gradient(${90 + (Number(attr(gradient, 'degree') ?? 0) || 0)}deg, ${stops.join(', ')})`;
      return { image };
    }
    const pattern = child(f, 'patternFill');
    const type = attr(pattern, 'patternType');
    if (!pattern || !type || type === 'none') return undefined;
    const fg = readColor(child(pattern, 'fgColor'), theme);
    const bg = readColor(child(pattern, 'bgColor'), theme);
    if (type === 'solid') return fg ? { color: fg } : undefined;
    // A pattern: lines or dots of the foreground colour over the background colour.
    const ink = fg ?? '#000000';
    return { color: bg && bg !== '#000000' ? bg : undefined, image: patternCss(type, ink) };
  });

  const LINE: Record<string, string> = { thin: 's', hair: 'o', medium: 'm', thick: 'k', double: 'd', dashed: 'h', dotted: 'o', dashDot: 'h', dashDotDot: 'h', mediumDashed: 'h', mediumDashDot: 'h', mediumDashDotDot: 'h', slantDashDot: 'h' };
  const borders = childrenOf(child(root, 'borders'), 'border').map((b) => {
    let letters = '';
    let lines = '';
    let color: string | undefined;
    const side = (names: string[], letter: string) => {
      for (const name of names) {
        const node = child(b, name);
        const st = attr(node, 'style');
        if (!st || st === 'none') continue;
        letters += letter;
        lines += LINE[st] ?? 's';
        const c = readColor(child(node, 'color'), theme);
        if (c && c !== '#000000') color ??= c;
        return;
      }
    };
    side(['top'], 't');
    side(['right', 'end'], 'r');
    side(['bottom'], 'b');
    side(['left', 'start'], 'l');
    return { letters, lines: /[^s]/.test(lines) ? lines : undefined, color };
  });

  // Conditional formatting styles: they change only what is set in them.
  const dxfs = childrenOf(child(root, 'dxfs'), 'dxf').map((dxf) => {
    const style: CellStyle = {};
    const font = child(dxf, 'font');
    const on = (name: string) => {
      const n = child(font, name);
      return !!n && attr(n, 'val') !== '0' && attr(n, 'val') !== 'false';
    };
    if (on('b')) style.bold = true;
    if (on('i')) style.italic = true;
    if (on('strike')) style.strike = true;
    const fontColor = readColor(child(font, 'color'), theme);
    if (fontColor) style.color = fontColor;
    const pattern = child(child(dxf, 'fill'), 'patternFill');
    const fill = readColor(child(pattern, 'bgColor'), theme) ?? readColor(child(pattern, 'fgColor'), theme);
    if (fill) style.fill = fill;
    return style;
  });

  const xfs = childrenOf(child(root, 'cellXfs'), 'xf').map((xf) => {
    const fmtId = Number(attr(xf, 'numFmtId') ?? 0);
    const font = fonts[Number(attr(xf, 'fontId') ?? 0)];
    const fill = fills[Number(attr(xf, 'fillId') ?? 0)];
    const alignment = child(xf, 'alignment');
    const horizontal = attr(alignment, 'horizontal');
    const style: CellStyle = {};
    if (font?.bold) style.bold = true;
    if (font?.italic) style.italic = true;
    if (font?.color) style.color = font.color;
    if (font?.underline) style.underline = true;
    if (font?.strike) style.strike = true;
    if (font?.size && Math.abs(font.size - baseSize) >= 0.5) style.size = Math.round((font.size / baseSize) * 11 * 10) / 10;
    if (attr(alignment, 'wrapText') === '1' || attr(alignment, 'wrapText') === 'true') style.wrap = true;
    const vertical = attr(alignment, 'vertical');
    if (vertical === 'top') style.valign = 'top';
    else if (vertical === 'center') style.valign = 'middle';
    if (fill?.color) style.fill = fill.color;
    if (fill?.image) style.fillImage = fill.image;
    const border = borders[Number(attr(xf, 'borderId') ?? 0)];
    if (border?.letters) {
      style.border = border.letters;
      if (border.lines) style.lines = border.lines;
      if (border.color) style.lineColor = border.color;
    }
    if (font?.name && font.name !== baseFont) style.font = font.name;
    const rotation = Number(attr(alignment, 'textRotation') ?? 0);
    if (rotation === 255) style.rot = 255;
    else if (rotation > 0 && rotation <= 180) style.rot = rotation <= 90 ? rotation : 90 - rotation;
    if (horizontal === 'center' || horizontal === 'right' || horizontal === 'left') style.align = horizontal;
    else if (horizontal === 'centerContinuous') style.align = 'center';
    return {
      format: formats.get(fmtId) ?? builtinFormat(fmtId),
      style: styles.add(style),
      numStyle: styles.add(style.align ? style : { ...style, align: 'right' }),
    };
  });
  return { xfs, dxfs };
}

interface SheetRef {
  name: string;
  path: string;
}

function parseSheet(xml: string, sst: SharedStrings, xfs: Xf[], locale: NumFmtLocale, date1904: boolean, maxRows: number, rightStyle: number, conditional: Conditional[], raw: Map<number, number | string>): SheetBuilder {
  const allValues = needsAllValues(conditional);
  const builder = new SheetBuilder(maxRows);
  let row = -1;
  let col = -1;
  let cellType = '';
  let cellXf: Xf | undefined;
  let value = '';
  let collecting = false;
  let inCell = false;
  let inInline = false;

  const finishCell = () => {
    if (row < 0 || col < 0) return;
    let text = '';
    let numeric = false;
    let richRuns: CellRun[] | undefined;
    if (value !== '' || cellType === 'inlineStr') {
      switch (cellType) {
        case 's':
          text = sst.list[Number(value)] ?? '';
          richRuns = sst.rich.get(Number(value));
          break;
        case 'str':
        case 'inlineStr':
          text = unescapeXlsx(value);
          break;
        case 'b':
          text = value === '1' ? locale.trueText : locale.falseText;
          break;
        case 'e':
        case 'd':
          text = value;
          break;
        default: {
          const num = Number(value);
          numeric = Number.isFinite(num);
          text = numeric ? (cellXf?.format ? formatValue(num, cellXf.format, locale, date1904) : formatGeneral(num, locale)) : value;
        }
      }
    }
    builder.set(row, col, text, (numeric ? cellXf?.numStyle : cellXf?.style) ?? (numeric ? rightStyle : 0));
    if (richRuns) builder.setRich(row, col, richRuns);
    // Conditional formatting needs source values, not formatted text.
    if (conditional.length && text !== '' && raw.size < 400_000 && (allValues || inConditional(conditional, row, col))) raw.set(row * 16384 + col, numeric ? Number(value) : text);
  };

  parseXmlSax(xml, {
    open(name, attrs) {
      const n = localName(name);
      if (n === 'c') {
        const ref = attrs.r ? parseCellRef(attrs.r) : null;
        if (ref) {
          row = ref.row;
          col = ref.col;
        } else {
          col++;
        }
        cellType = attrs.t ?? '';
        cellXf = attrs.s !== undefined ? xfs[Number(attrs.s)] : xfs[0];
        value = '';
        inCell = true;
      } else if (n === 'v' && inCell) {
        collecting = true;
      } else if (n === 'is' && inCell) {
        inInline = true;
      } else if (n === 't' && inInline) {
        collecting = true;
      } else if (n === 'row') {
        const r = Number(attrs.r);
        row = Number.isFinite(r) && r > 0 ? r - 1 : row + 1;
        col = -1;
        if (attrs.hidden === '1' || attrs.hidden === 'true') builder.hideRow(row);
        const ht = Number(attrs.ht);
        if (attrs.ht !== undefined && Number.isFinite(ht)) builder.setHeight(row, ht);
      } else if (n === 'col') {
        const min = Number(attrs.min);
        const max = Math.min(Number(attrs.max), min + 2000);
        const width = Number(attrs.width);
        if (attrs.hidden === '1' || attrs.hidden === 'true') for (let c = min; c <= Math.min(Number(attrs.max), 16384); c++) builder.hideCol(c - 1);
        else if (Number.isFinite(width)) for (let c = min; c <= max; c++) builder.setWidth(c - 1, width);
      } else if (n === 'sheetFormatPr') {
        const w = Number(attrs.defaultColWidth);
        if (Number.isFinite(w) && w > 0) builder.defaultWidth = w;
        const h = Number(attrs.defaultRowHeight);
        if (Number.isFinite(h) && h > 0) builder.defaultHeight = h;
      } else if (n === 'mergeCell') {
        const m = attrs.ref ? parseRangeRef(attrs.ref) : null;
        if (m) builder.addMerge(m);
      }
    },
    close(name) {
      const n = localName(name);
      if (n === 'c') {
        finishCell();
        inCell = false;
        inInline = false;
        collecting = false;
      } else if (n === 'v' || n === 't') {
        collecting = false;
      } else if (n === 'is') {
        inInline = false;
      }
    },
    text(t) {
      if (collecting) value += t;
    },
  });
  return builder;
}

export async function openXlsx(blob: Blob, options: WorkbookOptions): Promise<Workbook> {
  const zip = await ZipReader.open(blob);
  const workbookPath = 'xl/workbook.xml';
  const workbook = await readXml(zip, workbookPath);
  if (!workbook) throw new Error('The file has no workbook (xl/workbook.xml)');

  const rels = new Map<string, string>();
  const relsRoot = await readXml(zip, 'xl/_rels/workbook.xml.rels');
  for (const rel of childrenOf(relsRoot, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) rels.set(id, resolvePath(workbookPath, target));
  }
  const pathByType = (suffix: string, fallback: string) => {
    for (const rel of childrenOf(relsRoot, 'Relationship')) {
      if ((attr(rel, 'Type') ?? '').endsWith(suffix)) return resolvePath(workbookPath, attr(rel, 'Target') ?? fallback);
    }
    return fallback;
  };

  const sheets: SheetRef[] = [];
  /** All workbook sheets, hidden ones included: sparklines may refer to them. */
  const allSheets = new Map<string, string>();
  let index = 0;
  for (const sheet of childrenOf(child(workbook, 'sheets'), 'sheet')) {
    index++;
    const state = attr(sheet, 'state');
    const rid = sheet.attrs['r:id'] ?? attr(sheet, 'id');
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${index}.xml`;
    if (/worksheets\//.test(path)) allSheets.set(attr(sheet, 'name') ?? '', path);
    if (state === 'hidden' || state === 'veryHidden') continue;
    // Chart sheets and macro sheets are not tables.
    if (!/worksheets\//.test(path)) continue;
    sheets.push({ name: attr(sheet, 'name') ?? `Sheet ${index}`, path });
  }
  if (sheets.length === 0) throw new Error('The workbook has no sheets with data');

  const pr = child(workbook, 'workbookPr');
  const date1904 = attr(pr, 'date1904') === '1' || attr(pr, 'date1904') === 'true';
  const locale = createLocale(options.lang);
  const styles = new StyleTable();
  const themeRoot = await readXml(zip, pathByType('/theme', 'xl/theme/theme1.xml'));
  const theme = readTheme(themeRoot);
  const { xfs, dxfs } = readStyles(await readXml(zip, pathByType('/styles', 'xl/styles.xml')), theme, styles);
  const themeColor = makeColorResolver(readThemeColors(themeRoot));
  const sst = await readSharedStrings(zip, pathByType('/sharedStrings', 'xl/sharedStrings.xml'), theme);

  const opened = new Map<number, SheetModel>();
  return {
    sheets: sheets.map((s) => s.name),
    async openSheet(i) {
      let model = opened.get(i);
      if (!model) {
        const xml = decodeXmlBytes(await zip.read(sheets[i].path));
        const conditional = parseConditional(xml, dxfs);
        const raw = new Map<number, number | string>();
        const builder = parseSheet(xml, sst, xfs, locale, date1904, options.maxRows, styles.add({ align: 'right' }), conditional, raw);
        if (conditional.length) applyConditional(conditional, raw, builder, styles, themeColor);
        // Sparklines: data comes from cells of this or another sheet.
        for (const spark of parseSparklines(xml)) {
          try {
            const path = spark.sheet !== undefined && spark.sheet !== sheets[i].name ? allSheets.get(spark.sheet) : sheets[i].path;
            if (!path) continue;
            const values = sheetNumbers(path === sheets[i].path ? xml : decodeXmlBytes(await zip.read(path)), spark.range);
            if (!values.some((v) => v !== null)) continue;
            const base = styles.list[builder.styleAt(spark.row, spark.col)] ?? {};
            builder.restyle(spark.row, spark.col, styles.add({ ...base, spark: { kind: spark.kind, values, color: spark.color, ...(spark.negative ? { negative: spark.negative } : {}) } }), true);
          } catch {
            // A sparkline without data is simply not drawn.
          }
        }
        // Comments, pictures, charts and shapes lie in separate parts related to the sheet.
        for (const rel of (await readRels(zip, sheets[i].path)).values()) {
          if (rel.external) continue;
          try {
            if (rel.type === 'comments') await readComments(zip, rel.target, builder);
            else if (rel.type === 'drawing') await readDrawing(zip, rel.target, builder, themeRoot, (c) => builder.widthOf(c) * 7 + 5, (r) => (builder.heightOf(r) * 96) / 72);
            else if (rel.type === 'table' || rel.type === 'pivotTable') await applyTableStyle(zip, rel.target, rel.type === 'table' ? 'table' : 'pivot', builder, styles, theme);
          } catch {
            // A failure in an extra part must not prevent showing the table itself.
          }
        }
        model = builder.build(styles.list);
        opened.set(i, model);
      }
      return model;
    },
  };
}
