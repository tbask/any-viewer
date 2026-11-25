/**
 * Reader of docx (Office Open XML WordprocessingML).
 *
 * Supported: paragraphs and headings, style inheritance, text emphasis and colours, lists
 * (numbered and bulleted, multi-level), tables with merged cells, pictures,
 * hyperlinks, page breaks, fields (the field result is shown), footnotes, comments, headers/footers, shapes and charts.
 * Not supported: exact pagination.
 */
import { loadImage } from '../core/images';
import type { DocImage } from '../core/docmodel';
import {
  appendPart, compactRunStyle, formatCounter, hasVisibleContent, hexColor, highlightColor, mergeStyle, prefixNote,
  type Block, type DocPartLabels, type DocModel, type Inline, type ParaStyle, type RunStyle, type TableCell, type TableRow, type TabStop,
} from '../core/docmodel';
import { symbolChar } from '../core/symbols';
import type { DocOptions } from './documents';
import { makeColorResolver, parseChart, readThemeColors, type ChartModel } from '../core/chart';
import type { SlideShape } from '../core/slidemodel';
import { blocksToParas, parseDiagramDrawing, shapeLook } from './drawingml';
import { parseOmml } from './omml';
import { openXlsx } from './xlsx';
import { attr, child, childrenOf, decodeXmlBytes, localName, parseXml, type XmlNode } from '../core/xml';
import { ZipReader } from '../core/zip';

const TWIP = 1 / 20; // points in one twip
const EMU_PER_PX = 9525;

interface StyleDef {
  basedOn?: string;
  name: string;
  run: RunStyle;
  para: ParaStyle;
  numId?: string;
  ilvl?: number;
}

interface NumLevel {
  format: string;
  text: string;
  start: number;
  /** Font of the marker (bullets are often characters of a symbol font). */
  font?: string;
  ml?: number;
  ti?: number;
}

const on = (node: XmlNode | undefined): 0 | 1 | undefined => {
  if (!node) return undefined;
  const v = attr(node, 'val');
  return v === '0' || v === 'false' || v === 'off' ? 0 : 1;
};
const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Document theme fonts: "minor" (body) and "major" (headings). Filled while the file is parsed. */
let themeFonts: { minor?: string; major?: string } = {};

function parseRunProps(rPr: XmlNode | undefined): RunStyle {
  if (!rPr) return {};
  const s: RunStyle = {};
  s.b = on(child(rPr, 'b'));
  s.i = on(child(rPr, 'i'));
  s.s = on(child(rPr, 'strike'));
  s.ds = on(child(rPr, 'dstrike'));
  s.hide = on(child(rPr, 'vanish'));
  const u = child(rPr, 'u');
  if (u) {
    const kind = attr(u, 'val') ?? 'single';
    s.u = kind === 'none' ? 0 : 1;
    if (/double/i.test(kind)) s.ul = 'double';
    else if (/wav/i.test(kind)) s.ul = 'wavy';
    else if (/dot/i.test(kind)) s.ul = 'dotted';
    else if (/dash/i.test(kind)) s.ul = 'dashed';
  }
  const smallCaps = on(child(rPr, 'smallCaps'));
  const caps = on(child(rPr, 'caps'));
  if (caps !== undefined || smallCaps !== undefined) s.caps = caps ? 'all' : smallCaps ? 'small' : '';
  const spacing = num(attr(child(rPr, 'spacing'), 'val'));
  if (spacing !== undefined) s.ls = spacing * TWIP;
  const scale = num(attr(child(rPr, 'w'), 'val'));
  if (scale && scale !== 100) s.scale = scale / 100;
  // Text effects: the classic ones (shadow, outline, emboss) and those of Word 2010+ (w14:shadow, w14:glow, w14:textOutline).
  for (const c of rPr.children) {
    if (c.name === '#text') continue;
    const name = localName(c.name);
    if (name === 'shadow' || name === 'emboss' || name === 'imprint') {
      if (c.name.startsWith('w14:') ? c.children.length > 0 : on(c) === 1) s.shadow = 1;
    } else if (name === 'outline' && on(c) === 1) s.outline = '#404040';
    else if (name === 'textOutline') {
      const color = hexColor(attr(findDescendant(c, 'srgbClr'), 'val'));
      if (color) s.outline = color;
    } else if (name === 'glow') {
      const color = hexColor(attr(findDescendant(c, 'srgbClr'), 'val'));
      s.glow = color ?? '#f0b400';
    }
  }
  const va = attr(child(rPr, 'vertAlign'), 'val');
  if (va) s.va = va === 'superscript' ? 'sup' : va === 'subscript' ? 'sub' : '';
  const sz = num(attr(child(rPr, 'sz'), 'val'));
  if (sz) s.size = sz / 2;
  const colorNode = child(rPr, 'color');
  if (colorNode) s.color = hexColor(attr(colorNode, 'val')) ?? '';
  const hl = highlightColor(attr(child(rPr, 'highlight'), 'val')) ?? hexColor(attr(child(rPr, 'shd'), 'fill'));
  if (hl) s.bg = hl;
  const fonts = child(rPr, 'rFonts');
  if (fonts) {
    // A font is given either by name or by a reference to a theme font (minorHAnsi, majorHAnsi, …).
    const themeRef = attr(fonts, 'asciiTheme') ?? attr(fonts, 'hAnsiTheme') ?? attr(fonts, 'cstheme');
    const font = attr(fonts, 'ascii') ?? attr(fonts, 'hAnsi') ?? (themeRef ? (themeRef.startsWith('major') ? themeFonts.major : themeFonts.minor) : undefined) ?? attr(fonts, 'cs');
    if (font) {
      s.font = font;
      s.mono = /courier|consolas|mono|lucida console/i.test(font) ? 1 : 0;
    }
  }
  return s;
}

interface ParaProps {
  style: ParaStyle;
  styleId?: string;
  numId?: string;
  ilvl?: number;
  pageBreakBefore?: boolean;
  /** The paragraph is a drop cap frame: its text belongs to the start of the next paragraph. */
  dropCapLines?: number;
}

function parseParaProps(pPr: XmlNode | undefined): ParaProps {
  const out: ParaProps = { style: {} };
  if (!pPr) return out;
  const s = out.style;
  const jc = attr(child(pPr, 'jc'), 'val');
  if (jc) s.align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : 'left';
  const ind = child(pPr, 'ind');
  if (ind) {
    const left = num(attr(ind, 'left') ?? attr(ind, 'start'));
    const right = num(attr(ind, 'right') ?? attr(ind, 'end'));
    const first = num(attr(ind, 'firstLine'));
    const hanging = num(attr(ind, 'hanging'));
    if (left !== undefined) s.ml = left * TWIP;
    if (right !== undefined) s.mr = right * TWIP;
    if (hanging !== undefined) s.ti = -hanging * TWIP;
    else if (first !== undefined) s.ti = first * TWIP;
  }
  const spacing = child(pPr, 'spacing');
  if (spacing) {
    const before = num(attr(spacing, 'before'));
    const after = num(attr(spacing, 'after'));
    const line = num(attr(spacing, 'line'));
    if (before !== undefined) s.mt = before * TWIP;
    if (after !== undefined) s.mb = after * TWIP;
    const rule = attr(spacing, 'lineRule');
    if (line && (!rule || rule === 'auto')) s.lh = Math.max(0.8, Math.min(line / 240, 3));
  }
  const fill = hexColor(attr(child(pPr, 'shd'), 'fill'));
  if (fill) s.bg = fill;
  const borders = child(pPr, 'pBdr');
  if (borders) {
    const side = childrenOf(borders).find((b) => attr(b, 'val') && attr(b, 'val') !== 'nil' && attr(b, 'val') !== 'none');
    if (side && childrenOf(borders).filter((b) => attr(b, 'val') && attr(b, 'val') !== 'nil' && attr(b, 'val') !== 'none').length >= 3) s.border = hexColor(attr(side, 'color')) ?? '#404040';
  }
  const tabs = child(pPr, 'tabs');
  if (tabs) {
    const stops: TabStop[] = [];
    for (const t of childrenOf(tabs, 'tab')) {
      const kind = attr(t, 'val');
      const pos = num(attr(t, 'pos'));
      if (pos === undefined || kind === 'clear' || kind === 'bar') continue;
      const leader = attr(t, 'leader');
      stops.push({ pos: pos * TWIP, align: kind === 'right' || kind === 'end' ? 'right' : kind === 'center' ? 'center' : kind === 'decimal' ? 'decimal' : undefined, leader: leader === 'dot' || leader === 'middleDot' ? '.' : leader === 'hyphen' ? '-' : leader === 'underscore' || leader === 'heavy' ? '_' : undefined });
    }
    if (stops.length) s.tabs = stops;
  }
  const frame = child(pPr, 'framePr');
  const dropLines = attr(frame, 'dropCap') && attr(frame, 'dropCap') !== 'none' ? num(attr(frame, 'lines')) ?? 3 : undefined;
  if (dropLines) out.dropCapLines = dropLines;
  const outline = num(attr(child(pPr, 'outlineLvl'), 'val'));
  if (outline !== undefined && outline < 6) s.heading = outline + 1;
  out.styleId = attr(child(pPr, 'pStyle'), 'val');
  const numPr = child(pPr, 'numPr');
  if (numPr) {
    out.numId = attr(child(numPr, 'numId'), 'val');
    out.ilvl = num(attr(child(numPr, 'ilvl'), 'val')) ?? 0;
  }
  const pb = child(pPr, 'pageBreakBefore');
  if (pb && on(pb) === 1) out.pageBreakBefore = true;
  return out;
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

function findDescendant(node: XmlNode, local: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === '#text') continue;
    if (localName(c.name) === local) return c;
    const deep = findDescendant(c, local);
    if (deep) return deep;
  }
  return undefined;
}

export async function parseDocx(blob: Blob, options: DocOptions = {}): Promise<DocModel> {
  const labels: DocPartLabels = options.labels ?? {};
  const zip = await ZipReader.open(blob);
  const docPath = 'word/document.xml';
  const readXml = async (path: string) => {
    const entry = zip.get(path);
    return entry ? parseXml(decodeXmlBytes(await zip.read(entry))) : undefined;
  };
  const document = await readXml(docPath);
  const body = child(document, 'body');
  if (!body) throw new Error('The file has no document body (word/document.xml)');

  // --- relationships: pictures and external links. Every document part (body, footnotes, headers) has its own ---
  type Rels = Map<string, { target: string; external: boolean; type: string }>;
  const readRels = async (partPath: string): Promise<Rels> => {
    const map: Rels = new Map();
    const slash = partPath.lastIndexOf('/');
    const relsPath = `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
    for (const rel of childrenOf(await readXml(relsPath), 'Relationship')) {
      const id = attr(rel, 'Id');
      const target = attr(rel, 'Target');
      if (!id || !target) continue;
      const external = attr(rel, 'TargetMode') === 'External';
      map.set(id, { target: external ? target : resolvePath(partPath, target), external, type: (attr(rel, 'Type') ?? '').replace(/^.*\//, '') });
    }
    return map;
  };
  const docRels = await readRels(docPath);
  let rels = docRels;

  // --- styles ---
  const styles = new Map<string, StyleDef>();
  let defaultRun: RunStyle = {};
  let defaultPara: ParaStyle = {};
  let defaultParaStyleId: string | undefined;
  themeFonts = {};
  const themeRoot = await readXml('word/theme/theme1.xml');
  const fontScheme = child(child(themeRoot, 'themeElements'), 'fontScheme');
  themeFonts.minor = attr(child(child(fontScheme, 'minorFont'), 'latin'), 'typeface') || undefined;
  themeFonts.major = attr(child(child(fontScheme, 'majorFont'), 'latin'), 'typeface') || undefined;
  const stylesRoot = await readXml('word/styles.xml');
  if (stylesRoot) {
    const defaults = child(stylesRoot, 'docDefaults');
    defaultRun = parseRunProps(child(child(defaults, 'rPrDefault'), 'rPr'));
    defaultPara = parseParaProps(child(child(defaults, 'pPrDefault'), 'pPr')).style;
    for (const st of childrenOf(stylesRoot, 'style')) {
      const id = attr(st, 'styleId');
      if (!id) continue;
      const para = parseParaProps(child(st, 'pPr'));
      const name = attr(child(st, 'name'), 'val') ?? id;
      const m = /^(?:heading|заголовок)\s*(\d)$/i.exec(name) ?? /^Heading(\d)$/.exec(id);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 6) para.style.heading = Number(m[1]);
      else if (/^(title|название|заголовок)$/i.test(name)) para.style.heading = 1;
      styles.set(id, { basedOn: attr(child(st, 'basedOn'), 'val'), name, run: parseRunProps(child(st, 'rPr')), para: para.style, numId: para.numId, ilvl: para.ilvl });
      const isDefault = attr(st, 'default');
      if (attr(st, 'type') === 'paragraph' && (isDefault === '1' || isDefault === 'true')) defaultParaStyleId = id;
    }
  }
  const chainCache = new Map<string, StyleDef>();
  const resolveStyle = (id: string | undefined, depth = 0): StyleDef | undefined => {
    if (!id) return undefined;
    const cached = chainCache.get(id);
    if (cached) return cached;
    const st = styles.get(id);
    if (!st) return undefined;
    const base = depth < 20 ? resolveStyle(st.basedOn, depth + 1) : undefined;
    const merged: StyleDef = {
      name: st.name,
      run: mergeStyle(base?.run, st.run),
      para: mergeStyle(base?.para, st.para),
      numId: st.numId ?? base?.numId,
      ilvl: st.ilvl ?? base?.ilvl,
    };
    chainCache.set(id, merged);
    return merged;
  };

  // --- list numbering ---
  const abstractNums = new Map<string, NumLevel[]>();
  const numToAbstract = new Map<string, string>();
  const numberingRoot = await readXml('word/numbering.xml');
  for (const an of childrenOf(numberingRoot, 'abstractNum')) {
    const levels: NumLevel[] = [];
    for (const lvl of childrenOf(an, 'lvl')) {
      const pp = parseParaProps(child(lvl, 'pPr')).style;
      levels[num(attr(lvl, 'ilvl')) ?? 0] = {
        format: attr(child(lvl, 'numFmt'), 'val') ?? 'decimal',
        text: attr(child(lvl, 'lvlText'), 'val') ?? '',
        start: num(attr(child(lvl, 'start'), 'val')) ?? 1,
        font: attr(child(child(lvl, 'rPr'), 'rFonts'), 'ascii') ?? attr(child(child(lvl, 'rPr'), 'rFonts'), 'hAnsi'),
        ml: pp.ml,
        ti: pp.ti,
      };
    }
    abstractNums.set(attr(an, 'abstractNumId') ?? '', levels);
  }
  for (const n of childrenOf(numberingRoot, 'num')) {
    numToAbstract.set(attr(n, 'numId') ?? '', attr(child(n, 'abstractNumId'), 'val') ?? '');
  }
  const counters = new Map<string, number[]>();
  const BULLETS = ['•', '◦', '▪'];
  const listMarker = (numId: string, ilvl: number): { marker: string; level: NumLevel } | undefined => {
    const abstractId = numToAbstract.get(numId);
    const levels = abstractId !== undefined ? abstractNums.get(abstractId) : undefined;
    const level = levels?.[ilvl];
    if (!levels || !level) return undefined;
    // Counters are shared by all lists on one abstract definition, so numbering continues.
    const key = abstractId!;
    const state = counters.get(key) ?? [];
    counters.set(key, state);
    state[ilvl] = state[ilvl] === undefined ? level.start : state[ilvl] + 1;
    state.length = ilvl + 1; // nested levels restart
    if (level.format === 'bullet') {
      // The bullet is the character from the file; symbol font codes are mapped to regular characters.
      const own = symbolChar(level.font, level.text, '').trim();
      return { marker: own && own !== 'o' ? own : level.text.trim() === 'o' ? '◦' : BULLETS[ilvl % BULLETS.length], level };
    }
    if (level.format === 'none') return { marker: '', level };
    const marker = level.text.replace(/%(\d)/g, (_, d: string) => {
      const li = Number(d) - 1;
      const lv = levels[li];
      return formatCounter(state[li] ?? lv?.start ?? 1, lv?.format ?? 'decimal');
    });
    return { marker, level };
  };

  // --- charts, SmartArt layouts and embedded Excel workbooks are read in advance: the document walk itself is synchronous ---
  const themeColors = readThemeColors(themeRoot);
  const drawColor = makeColorResolver(themeColors);
  const charts = new Map<string, ChartModel>();
  const diagrams = new Map<string, { shapes: SlideShape[]; w: number; h: number }>();
  const embedded = new Map<string, Block>();
  /** Metafiles (EMF, WMF) already converted to SVG: they show whether an embedded object has a ready snapshot. */
  const metafiles = new Map<string, DocImage>();
  for (const rel of docRels.values()) {
    if (rel.external) continue;
    try {
      if (rel.type === 'chart' || rel.type === 'chartEx') {
        const chart = parseChart(await readXml(rel.target), themeColors);
        if (chart) charts.set(rel.target, chart);
      } else if (rel.type === 'diagramDrawing') {
        const diagram = parseDiagramDrawing(await readXml(rel.target), themeColors);
        if (diagram) diagrams.set(rel.target, diagram);
      } else if (rel.type === 'image' && /\.(emf|wmf)$/i.test(rel.target) && metafiles.size < 200) {
        const entry = zip.get(rel.target);
        const image = entry ? loadImage(rel.target, await zip.read(entry)) : undefined;
        if (image) metafiles.set(rel.target, image);
      } else if (rel.type === 'package' && /\.xls[xm]$/i.test(rel.target) && embedded.size < 20) {
        const entry = zip.get(rel.target);
        if (!entry) continue;
        // An embedded workbook is shown as a table: the first rows of the first sheet.
        const book = await openXlsx(new Blob([(await zip.read(entry)) as BlobPart]), { maxRows: 200, lang: options.lang });
        const sheet = await book.openSheet(0);
        const rows: TableRow[] = [];
        const data = sheet.getRows(0, Math.min(sheet.meta.rowCount, 60));
        const columns = Math.min(sheet.meta.columnCount, 20);
        data.rows.forEach((cells, r) => {
          const row: TableRow = { cells: [] };
          for (let c = 0; c < columns; c++) {
            const style = sheet.meta.styles?.[data.styles?.[r]?.[c] ?? 0];
            const run: Inline = { k: 'text', text: cells?.[c] ?? '', s: compactRunStyle({ b: style?.bold ? 1 : 0, i: style?.italic ? 1 : 0, color: style?.color, size: 10 }) };
            const cell: TableCell = { blocks: [{ k: 'p', runs: cells?.[c] ? [run] : [], s: style?.align ? { align: style.align } : undefined }] };
            if (style?.fill) cell.bg = style.fill;
            row.cells.push(cell);
          }
          rows.push(row);
        });
        for (const m of sheet.meta.merges ?? []) {
          const main = rows[m.r0]?.cells[m.c0];
          if (!main) continue;
          const lastRow = Math.min(m.r1, rows.length - 1);
          const lastCol = Math.min(m.c1, columns - 1);
          if (lastCol > m.c0) main.colSpan = lastCol - m.c0 + 1;
          if (lastRow > m.r0) main.rowSpan = lastRow - m.r0 + 1;
          for (let r = m.r0; r <= lastRow; r++) for (let c = m.c0; c <= lastCol; c++) if (r !== m.r0 || c !== m.c0) rows[r].cells[c].skip = true;
        }
        if (rows.length) embedded.set(rel.target, { k: 'table', rows, widths: sheet.meta.columnWidths.slice(0, columns) });
      }
    } catch {
      // A failure in an extra part must not prevent showing the text.
    }
  }
  let watermark: string | undefined;
  let watermarkImage: string | undefined;
  /** A header/footer is being parsed: WordArt in it is the page watermark. */
  let inHeader = false;

  // --- document walk ---
  const imagePaths = new Map<string, string>();
  // Footnotes and comments are numbered in the order their references appear in the text.
  const noteRefs = { footnote: [] as string[], endnote: [] as string[], comment: [] as string[] };
  const noteMark = (kind: keyof typeof noteRefs, id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    let index = noteRefs[kind].indexOf(id);
    if (index < 0) index = noteRefs[kind].push(id) - 1;
    return kind === 'endnote' ? formatCounter(index + 1, 'lowerRoman') : kind === 'comment' ? `[${index + 1}]` : String(index + 1);
  };

  const parseParagraph = (p: XmlNode, out: Block[]): void => {
    const props = parseParaProps(child(p, 'pPr'));
    const style = resolveStyle(props.styleId ?? defaultParaStyleId);
    const paraStyle = mergeStyle(mergeStyle(defaultPara, style?.para), props.style);
    const baseRun = mergeStyle(defaultRun, style?.run);
    const runs: Inline[] = [];
    /** Text boxes and shapes with text anchored to a paragraph: output right after it. */
    const boxes: Block[] = [];
    const anchored: { canvas: Block; x: number; y: number }[] = [];
    let pageBreakAfter = false;
    let fieldDepth = 0;
    let fieldInstruction = false;

    const pushText = (text: string, rs: RunStyle, href?: string) => {
      if (!text || rs.hide) return;
      const { hide: _hide, ...visible } = rs;
      const s = compactRunStyle(visible);
      const last = runs[runs.length - 1];
      if (last && last.k === 'text' && last.href === href && JSON.stringify(last.s) === JSON.stringify(s)) last.text += text;
      else runs.push(href ? { k: 'text', text, s, href } : { k: 'text', text, s });
    };

    const addImage = (node: XmlNode) => {
      const blip = findDescendant(node, 'blip');
      const imageData = blip ? undefined : findDescendant(node, 'imagedata');
      const rid = blip ? blip.attrs['r:embed'] ?? attr(blip, 'embed') : imageData ? imageData.attrs['r:id'] ?? attr(imageData, 'id') : undefined;
      const rel = rid ? rels.get(rid) : undefined;
      if (!rel || rel.external) return;
      const extent = findDescendant(node, 'extent');
      const w = num(attr(extent, 'cx'));
      const h = num(attr(extent, 'cy'));
      imagePaths.set(rel.target, rel.target);
      const img: Extract<Inline, { k: 'img' }> = { k: 'img', id: rel.target, w: w ? Math.round(w / EMU_PER_PX) : undefined, h: h ? Math.round(h / EMU_PER_PX) : undefined };
      const anchor = findDescendant(node, 'anchor');
      const offset = (name: string) => (num(child(child(anchor, name), 'posOffset')?.children.find((t) => t.name === '#text')?.text) ?? 0) / EMU_PER_PX;
      if (anchor && inHeader && attr(anchor, 'behindDoc') === '1') {
        // A picture behind the text of a header is the page watermark.
        watermarkImage ??= rel.target;
        return;
      }
      const srcRect = findDescendant(node, 'srcRect');
      if (srcRect) {
        const part = (name: string) => Math.max(0, Math.min(0.9, (num(attr(srcRect, name)) ?? 0) / 100000));
        const crop: [number, number, number, number] = [part('l'), part('t'), part('r'), part('b')];
        if (crop.some((v) => v > 0.001)) img.crop = crop;
      }
      const spPr = findDescendant(node, 'spPr');
      const line = child(spPr, 'ln');
      const lineColor = line && !child(line, 'noFill') ? drawColor(child(line, 'solidFill')) : undefined;
      if (line && lineColor) img.border = `${Math.max(1, Math.round((num(attr(line, 'w')) ?? 9525) / 9525))}px solid ${lineColor}`;
      const rot = num(attr(child(spPr, 'xfrm'), 'rot'));
      if (rot) img.rot = Math.round(rot / 60000);
      if (anchor) {
        const wrapped = ['wrapSquare', 'wrapTight', 'wrapThrough'].some((name) => child(anchor, name));
        const align = child(child(anchor, 'positionH'), 'align')?.children.find((t) => t.name === '#text')?.text;
        const x = offset('positionH');
        if (wrapped) img.float = align === 'right' || (!align && x + (img.w ?? 0) / 2 > 300) ? 'right' : 'left';
        else if (child(anchor, 'wrapNone')) img.behind = { x, y: offset('positionV') };
      }
      // A floated picture must precede the text of its paragraph for the text to flow beside it.
      if (img.float || img.behind) runs.unshift(img);
      else runs.push(img);
    };

    const parseRun = (r: XmlNode, href?: string) => {
      const rPr = child(r, 'rPr');
      const charStyle = resolveStyle(attr(child(rPr, 'rStyle'), 'val'));
      const rs = mergeStyle(mergeStyle(baseRun, charStyle?.run), parseRunProps(rPr));
      runChildren(r, rs, href);
    };

    /** A drawing, shape or text box: a picture goes inline, shape text as blocks after the paragraph. */
    const addDrawing = (node: XmlNode, rs: RunStyle) => {
      if (rs.hide) return;
      const all = (name: string, from: XmlNode = node, out: XmlNode[] = []): XmlNode[] => {
        for (const c of from.children) {
          if (c.name === '#text') continue;
          if (localName(c.name) === name) out.push(c);
          else all(name, c, out);
        }
        return out;
      };
      const extent = findDescendant(node, 'extent');
      const width = Math.round((num(attr(extent, 'cx')) ?? 0) / EMU_PER_PX);
      const height = Math.round((num(attr(extent, 'cy')) ?? 0) / EMU_PER_PX);

      // Old-style WordArt (VML): in a header/footer it is the page watermark, in the body a large caption.
      // The shape type definition (shapetype) has its own empty textpath; the one with the text is needed.
      const textPath = all('textpath').find((t) => attr(t, 'string'));
      const artText = attr(textPath, 'string');
      if (textPath && artText) {
        if (inHeader) {
          watermark ??= artText;
          return;
        }
        const css = attr(textPath, 'style') ?? '';
        const size = Number(/font-size:\s*([\d.]+)pt/.exec(css)?.[1]);
        const font = /font-family:\s*(?:"|&quot;)?([^;"&]+)/.exec(css)?.[1]?.trim();
        const shape = all('shape')[0];
        const fill = hexColor((attr(shape, 'fillcolor') ?? '').replace('#', ''));
        pushText(artText, { ...rs, size: Number.isFinite(size) && size > 0 ? size : 28, font, b: 1, color: fill && fill !== '#ffffff' ? fill : rs.color, outline: fill === '#ffffff' ? '#404040' : undefined });
        return;
      }

      // Chart.
      const chartRef = all('chart').find((c) => c.attrs['r:id']);
      const chart = chartRef ? charts.get(rels.get(chartRef.attrs['r:id'])?.target ?? '') : undefined;
      if (chart) {
        boxes.push({ k: 'chart', chart, w: width || 480, h: height || 288 });
        return;
      }

      // SmartArt: the ready layout lies next to the data (data1.xml → drawing1.xml).
      const dgm = findDescendant(node, 'relIds');
      if (dgm) {
        const dataPath = rels.get(dgm.attrs['r:dm'] ?? '')?.target ?? '';
        const diagram = diagrams.get(dataPath.replace(/data(\d+)\.xml$/, 'drawing$1.xml')) ?? (diagrams.size === 1 ? [...diagrams.values()][0] : undefined);
        if (diagram) {
          boxes.push({ k: 'canvas', w: Math.max(width, Math.ceil(diagram.w)) || 480, h: Math.max(height, Math.ceil(diagram.h)) || 288, shapes: diagram.shapes });
          return;
        }
      }

      // Embedded Excel workbook.
      const ole = findDescendant(node, 'OLEObject');
      const table = ole ? embedded.get(rels.get(ole.attrs['r:id'] ?? '')?.target ?? '') : undefined;
      // The object snapshot saved by Word itself is more faithful than a table retelling: it includes charts.
      const preview = ole ? findDescendant(node, 'imagedata') : undefined;
      if (preview && metafiles.has(rels.get(preview.attrs['r:id'] ?? '')?.target ?? '')) {
        addImage(node);
        return;
      }
      if (table) {
        boxes.push(table);
        return;
      }

      // Word shapes: their outlines are drawn on a canvas with the text inside.
      const wsps = all('wsp');
      if (wsps.length && width > 0 && height > 0) {
        const shapes: SlideShape[] = [];
        let fallback = false;
        const place = (wsp: XmlNode, tf: (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number }, single: boolean) => {
          const spPr = child(wsp, 'spPr');
          const xfrm = child(spPr, 'xfrm');
          const off = child(xfrm, 'off');
          const ext = child(xfrm, 'ext');
          const box = single || !off || !ext ? { x: 0, y: 0, w: width, h: height } : tf((num(attr(off, 'x')) ?? 0) / EMU_PER_PX, (num(attr(off, 'y')) ?? 0) / EMU_PER_PX, (num(attr(ext, 'cx')) ?? 0) / EMU_PER_PX, (num(attr(ext, 'cy')) ?? 0) / EMU_PER_PX);
          const shape: SlideShape = { ...box };
          const style = child(wsp, 'style');
          shapeLook(spPr, style, drawColor, shape);
          const content = findDescendant(wsp, 'txbxContent');
          if (content) {
            const inner: Block[] = [];
            parseBlocks(content, inner);
            if (hasVisibleContent(inner)) {
              const paras = blocksToParas(inner, shape.fill || shape.gradient ? drawColor(child(style, 'fontRef')) : undefined);
              if (!paras) fallback = true;
              else {
                shape.paras = paras;
                const bodyPr = child(wsp, 'bodyPr');
                const anchor = attr(bodyPr, 'anchor');
                shape.anchor = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
                const vert = attr(bodyPr, 'vert');
                if (vert === 'vert270') shape.textRot = 270;
                else if (vert === 'vert' || vert === 'eaVert') shape.textRot = 90;
              }
            }
          }
          if (shape.paras || shape.fill || shape.stroke || shape.gradient) shapes.push(shape);
        };
        const group = findDescendant(node, 'wgp');
        if (group) {
          const walkGroup = (g: XmlNode, tf: (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number }, top: boolean) => {
            const gx = child(child(g, 'grpSpPr'), 'xfrm');
            const off = child(gx, 'off');
            const ext = child(gx, 'ext');
            const chOff = child(gx, 'chOff');
            const chExt = child(gx, 'chExt');
            let inner = tf;
            if (ext && chOff && chExt) {
              // The outer group takes the whole canvas; nested ones their place in the parent.
              const ox = top ? 0 : (num(attr(off, 'x')) ?? 0) / EMU_PER_PX;
              const oy = top ? 0 : (num(attr(off, 'y')) ?? 0) / EMU_PER_PX;
              const cx = (num(attr(chOff, 'x')) ?? 0) / EMU_PER_PX;
              const cy = (num(attr(chOff, 'y')) ?? 0) / EMU_PER_PX;
              const sx = (top ? width * EMU_PER_PX : (num(attr(ext, 'cx')) ?? 1)) / ((num(attr(chExt, 'cx')) ?? 1) || 1);
              const sy = (top ? height * EMU_PER_PX : (num(attr(ext, 'cy')) ?? 1)) / ((num(attr(chExt, 'cy')) ?? 1) || 1);
              inner = (x, y, w, h) => tf(ox + (x - cx) * sx, oy + (y - cy) * sy, w * sx, h * sy);
            }
            for (const c of g.children) {
              if (c.name === '#text') continue;
              if (localName(c.name) === 'wsp') place(c, inner, false);
              else if (localName(c.name) === 'grpSp') walkGroup(c, inner, false);
            }
          };
          walkGroup(group, (x, y, w, h) => ({ x, y, w, h }), true);
        } else {
          for (const wsp of wsps) place(wsp, (x, y, w, h) => ({ x, y, w, h }), wsps.length === 1);
        }
        if (!fallback && shapes.length) {
          const canvas: Block = { k: 'canvas', w: width, h: height, shapes };
          // Position of a floating shape relative to the paragraph: neighbouring shapes then land on a shared canvas.
          const anchor = findDescendant(node, 'anchor');
          const offset = (name: string) => num(findDescendant(child(anchor, name) ?? ({ children: [] } as unknown as XmlNode), 'posOffset')?.children.map((t) => t.text).join(''));
          const ax = offset('positionH');
          const ay = offset('positionV');
          if (anchor && ax !== undefined && ay !== undefined) anchored.push({ canvas, x: ax / EMU_PER_PX, y: ay / EMU_PER_PX });
          boxes.push(canvas);
          return;
        }
      }

      const texts = all('txbxContent');
      if (findDescendant(node, 'blip') || findDescendant(node, 'imagedata')) addImage(node);
      for (const t of texts) {
        const inner: Block[] = [];
        parseBlocks(t, inner);
        if (hasVisibleContent(inner)) boxes.push({ k: 'table', rows: [{ cells: [{ blocks: inner }] }] });
      }
    };

    const runChildren = (r: XmlNode, rs: RunStyle, href?: string) => {
      for (const c of r.children) {
        if (c.name === '#text') continue;
        switch (localName(c.name)) {
          case 'AlternateContent': {
            // The same shape in two forms, modern and for old versions; take one.
            const pick = child(c, 'Choice') ?? child(c, 'Fallback');
            if (pick) runChildren(pick, rs, href);
            break;
          }
          case 't':
            if (!fieldInstruction) pushText(c.children.map((t) => t.text).join(''), rs, href);
            break;
          case 'tab':
            runs.push({ k: 'tab' });
            break;
          case 'br':
          case 'cr':
            if (attr(c, 'type') === 'page') pageBreakAfter = true;
            else runs.push({ k: 'br' });
            break;
          case 'noBreakHyphen':
            pushText('‑', rs, href);
            break;
          case 'sym':
            pushText(symbolChar(attr(c, 'font'), String.fromCodePoint(parseInt(attr(c, 'char') ?? '', 16) || 0x2022)), { ...rs, font: undefined }, href);
            break;
          case 'drawing':
          case 'pict':
          case 'object':
            if (!fieldInstruction) addDrawing(c, rs);
            break;
          case 'commentReference': {
            const mark = noteMark('comment', attr(c, 'id'));
            if (mark) pushText(mark, { ...rs, va: 'sup', hide: 0 }, href);
            break;
          }
          case 'fldChar': {
            const type = attr(c, 'fldCharType');
            if (type === 'begin') {
              fieldDepth++;
              fieldInstruction = true;
              // Legacy form fields: a check box and a drop-down have no result text, their state is in the field data.
              const ff = child(c, 'ffData');
              const box = child(ff, 'checkBox');
              const list = child(ff, 'ddList');
              if (box) {
                const checked = child(box, 'checked') ? on(child(box, 'checked')) : on(child(box, 'default'));
                pushText(checked ? '☒' : '☐', rs, href);
              } else if (list) {
                const entries = childrenOf(list, 'listEntry').map((e) => attr(e, 'val') ?? '');
                const index = num(attr(child(list, 'result'), 'val')) ?? num(attr(child(list, 'default'), 'val')) ?? 0;
                if (entries.length) pushText(entries[Math.min(index, entries.length - 1)], rs, href);
              }
            } else if (type === 'separate') {
              fieldInstruction = false;
            } else if (type === 'end') {
              fieldDepth = Math.max(0, fieldDepth - 1);
              fieldInstruction = false;
            }
            break;
          }
          case 'footnoteReference':
          case 'endnoteReference': {
            const mark = noteMark(localName(c.name) === 'footnoteReference' ? 'footnote' : 'endnote', attr(c, 'id'));
            if (mark) pushText(mark, { ...rs, va: 'sup' }, href);
            break;
          }
        }
      }
    };

    const walk = (node: XmlNode, href?: string) => {
      for (const c of node.children) {
        if (c.name === '#text') continue;
        switch (localName(c.name)) {
          case 'r':
            parseRun(c, href);
            break;
          case 'hyperlink': {
            const rel = rels.get(c.attrs['r:id'] ?? '');
            walk(c, rel?.external ? rel.target : href);
            break;
          }
          case 'oMathPara':
            walk(c, href);
            break;
          case 'oMath': {
            const math = parseOmml(c);
            if (math) runs.push({ k: 'math', node: math });
            break;
          }
          case 'ins':
          case 'smartTag':
          case 'sdt':
          case 'sdtContent':
          case 'fldSimple':
          case 'bdo':
          case 'dir':
          case 'moveTo':
            walk(c, href);
            break;
        }
      }
    };
    walk(p);

    if (props.pageBreakBefore) out.push({ k: 'pagebreak' });
    if (props.dropCapLines && runs.length && runs.every((r) => r.k === 'text')) {
      // A drop cap is stored as a framed paragraph of its own: its letters start the next paragraph.
      pendingDropCap = { lines: props.dropCapLines, runs };
      return;
    }
    if (pendingDropCap) {
      const cap = pendingDropCap;
      pendingDropCap = undefined;
      const text = cap.runs.map((r) => (r.k === 'text' ? r.text : '')).join('');
      const first = runs[0];
      if (first && first.k === 'text') {
        runs[0] = { ...first, text: text + first.text };
        paraStyle.dropCap = { lines: cap.lines, chars: text.length };
      } else {
        runs.unshift(...cap.runs);
      }
    }
    const block: Block = { k: 'p', runs };
    const numId = props.numId ?? style?.numId;
    if (numId && numId !== '0') {
      const ilvl = props.ilvl ?? style?.ilvl ?? 0;
      const list = listMarker(numId, ilvl);
      if (list) {
        block.marker = list.marker;
        block.level = ilvl;
        // List level indents apply if the paragraph has none of its own.
        // A numbered heading stays at the margin; list items take the indents of their level.
        if (!paraStyle.heading && props.style.ml === undefined && list.level.ml !== undefined) paraStyle.ml = list.level.ml;
        if (!paraStyle.heading && props.style.ti === undefined && list.level.ti !== undefined) paraStyle.ti = list.level.ti;
      }
    }
    if (Object.keys(paraStyle).length) block.s = paraStyle;
    out.push(block);
    if (anchored.length > 1) {
      // Several floating shapes of one paragraph: a shared canvas with their relative positions, as on the page.
      const minX = Math.min(...anchored.map((a) => a.x));
      const minY = Math.min(...anchored.map((a) => a.y));
      const merged: Block = { k: 'canvas', w: 0, h: 0, shapes: [] };
      for (const a of anchored) {
        if (a.canvas.k !== 'canvas' || merged.k !== 'canvas') continue;
        for (const shape of a.canvas.shapes) merged.shapes.push({ ...shape, x: shape.x + a.x - minX, y: shape.y + a.y - minY });
        merged.w = Math.max(merged.w, a.x - minX + a.canvas.w);
        merged.h = Math.max(merged.h, a.y - minY + a.canvas.h);
      }
      const first = boxes.indexOf(anchored[0].canvas);
      const rest = boxes.filter((b) => !anchored.some((a) => a.canvas === b));
      rest.splice(Math.min(first, rest.length), 0, merged);
      boxes.length = 0;
      boxes.push(...rest);
    }
    out.push(...boxes);
    if (pageBreakAfter) out.push({ k: 'pagebreak' });
  };

  let pendingDropCap: { lines: number; runs: Inline[] } | undefined;

  const parseTable = (tbl: XmlNode, out: Block[]): void => {
    const widths = childrenOf(child(tbl, 'tblGrid'), 'gridCol').map((g) => num(attr(g, 'w')) ?? 0);
    const rows: TableRow[] = [];
    // Vertical merges: for every grid column remember the cell that is currently "stretching" down.
    const spanOrigin: (TableCell | undefined)[] = [];
    for (const tr of childrenOf(tbl, 'tr')) {
      const cells: TableCell[] = [];
      let gridCol = 0;
      for (const tc of childrenOf(tr, 'tc')) {
        const tcPr = child(tc, 'tcPr');
        const span = num(attr(child(tcPr, 'gridSpan'), 'val')) ?? 1;
        const vMerge = child(tcPr, 'vMerge');
        const cell: TableCell = { blocks: [] };
        if (span > 1) cell.colSpan = span;
        const fill = hexColor(attr(child(tcPr, 'shd'), 'fill'));
        if (fill) cell.bg = fill;
        const direction = attr(child(tcPr, 'textDirection'), 'val');
        if (direction === 'btLr') cell.vert = 'bt';
        else if (direction === 'tbRl' || direction === 'tbRlV') cell.vert = 'tb';
        const vAlign = attr(child(tcPr, 'vAlign'), 'val');
        if (vAlign === 'center') cell.va = 'middle';
        else if (vAlign === 'bottom') cell.va = 'bottom';
        if (vMerge && attr(vMerge, 'val') !== 'restart') {
          const origin = spanOrigin[gridCol];
          if (origin) {
            origin.rowSpan = (origin.rowSpan ?? 1) + 1;
            cell.skip = true;
          }
        } else {
          spanOrigin[gridCol] = vMerge ? cell : undefined;
        }
        if (!cell.skip) parseBlocks(tc, cell.blocks);
        cells.push(cell);
        gridCol += span;
      }
      if (cells.length) {
        const row: TableRow = { cells };
        const trPr = child(tr, 'trPr');
        const height = num(attr(child(trPr, 'trHeight'), 'val'));
        if (height) row.h = height * TWIP;
        if (child(trPr, 'tblHeader')) row.head = true;
        rows.push(row);
      }
    }
    if (!rows.length) return;
    const table: Block = { k: 'table', rows, widths: widths.some((w) => w > 0) ? widths : undefined };
    // A floating table (positioned, with text around it).
    const position = child(child(tbl, 'tblPr'), 'tblpPr');
    if (position && table.k === 'table') {
      const total = widths.reduce((a, b) => a + b, 0) * TWIP;
      const xSpec = attr(position, 'tblpXSpec');
      const x = (num(attr(position, 'tblpX')) ?? 0) * TWIP;
      if (total > 0 && total < 400) {
        table.float = xSpec === 'right' || xSpec === 'outside' || (!xSpec && x + total / 2 > 234) ? 'right' : 'left';
        table.w = total;
      }
    }
    out.push(table);
  };

  const parseBlocks = (parent: XmlNode, out: Block[]): void => {
    for (const c of parent.children) {
      if (c.name === '#text') continue;
      switch (localName(c.name)) {
        case 'p':
          parseParagraph(c, out);
          break;
        case 'tbl':
          parseTable(c, out);
          break;
        case 'sdt':
          parseBlocks(child(c, 'sdtContent') ?? c, out);
          break;
        case 'sdtContent':
        case 'ins':
        case 'customXml':
          parseBlocks(c, out);
          break;
      }
    }
  };

  const blocks: Block[] = [];
  parseBlocks(body, blocks);

  /** Parses a separate document part (footnotes, header/footer) with its own relationships. */
  const parsePart = async (path: string, pick: (root: XmlNode) => XmlNode[]): Promise<Block[][]> => {
    const root = await readXml(path);
    if (!root) return [];
    const saved = rels;
    rels = await readRels(path);
    const result = pick(root).map((node) => {
      const part: Block[] = [];
      parseBlocks(node, part);
      return part;
    });
    rels = saved;
    return result;
  };
  const partPath = (type: string) => [...docRels.values()].find((r) => r.type === type && !r.external)?.target;

  // --- footnotes: texts at the end of the document, in reference order ---
  for (const kind of ['footnote', 'endnote'] as const) {
    const path = partPath(`${kind}s`);
    if (!path || !noteRefs[kind].length) continue;
    const ids: string[] = [];
    const parts = await parsePart(path, (root) =>
      childrenOf(root, kind).filter((n) => {
        const id = attr(n, 'id');
        // Service entries (separator lines) are not text.
        if (id === undefined || attr(n, 'type') || !noteRefs[kind].includes(id)) return false;
        ids.push(id);
        return true;
      }),
    );
    const ordered: Block[] = [];
    for (const id of noteRefs[kind]) {
      const at = ids.indexOf(id);
      if (at >= 0) ordered.push(...prefixNote(parts[at], noteMark(kind, id)!));
    }
    appendPart(blocks, kind === 'footnote' ? labels.footnotes : labels.endnotes, ordered);
  }

  // --- reviewer comments ---
  const commentsPath = partPath('comments');
  if (commentsPath && noteRefs.comment.length) {
    const meta: { id: string; author: string }[] = [];
    const parts = await parsePart(commentsPath, (root) =>
      childrenOf(root, 'comment').filter((n) => {
        const id = attr(n, 'id');
        if (id === undefined || !noteRefs.comment.includes(id)) return false;
        meta.push({ id, author: attr(n, 'author') ?? '' });
        return true;
      }),
    );
    const ordered: Block[] = [];
    for (const id of noteRefs.comment) {
      const at = meta.findIndex((m) => m.id === id);
      if (at < 0) continue;
      const author = meta[at].author;
      ordered.push(...prefixNote(parts[at], `${noteMark('comment', id)!}${author ? ` ${author}:` : ''}`));
    }
    appendPart(blocks, labels.comments, ordered);
  }

  // --- headers/footers: the document is a scroll without pages, so the header is output once at the start
  // and the footer once at the end. The first section that defines them is used.
  const sections: XmlNode[] = [];
  const findSections = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === '#text') continue;
      if (localName(c.name) === 'sectPr') sections.push(c);
      else if (localName(c.name) === 'p' || localName(c.name) === 'pPr') findSections(c);
    }
  };
  findSections(body);
  const withRefs = sections.find((s) => childrenOf(s, 'headerReference').length || childrenOf(s, 'footerReference').length);
  if (withRefs) {
    const titlePage = on(child(withRefs, 'titlePg')) === 1;
    const refTarget = (tag: string, type: string) => {
      const ref = childrenOf(withRefs, tag).find((r) => attr(r, 'type') === type);
      const rel = ref ? docRels.get(ref.attrs['r:id'] ?? '') : undefined;
      return rel && !rel.external ? rel.target : undefined;
    };
    const load = async (tag: string, type: string, rootName: string) => {
      const path = refTarget(tag, type);
      return path ? ((await parsePart(path, (root) => [localName(root.name) === rootName ? root : (child(root, rootName) ?? root)]))[0] ?? []) : [];
    };
    inHeader = true;
    const top = [...(titlePage ? await load('headerReference', 'first', 'hdr') : []), ...(await load('headerReference', 'default', 'hdr'))];
    inHeader = false;
    const bottom = [...(await load('footerReference', 'default', 'ftr'))];
    if (titlePage && !hasVisibleContent(bottom)) bottom.push(...(await load('footerReference', 'first', 'ftr')));
    appendPart(blocks, labels.footer, bottom);
    appendPart(blocks, labels.header, top, true);
  }

  const model: DocModel = { blocks, images: {} };
  if (watermark) model.watermark = watermark;
  if (watermarkImage) model.watermarkImage = watermarkImage;
  const sect = child(body, 'sectPr');
  const pageW = num(attr(child(sect, 'pgSz'), 'w'));
  if (pageW) {
    model.pageWidth = pageW * TWIP;
    const mar = child(sect, 'pgMar');
    model.marginLeft = (num(attr(mar, 'left')) ?? 1440) * TWIP;
    model.marginRight = (num(attr(mar, 'right')) ?? 1440) * TWIP;
  }
  for (const path of imagePaths.keys()) {
    const entry = zip.get(path);
    if (!entry) continue;
    try {
      const image = metafiles.get(path) ?? loadImage(path, await zip.read(entry));
      if (image) model.images[path] = image;
    } catch {
      // A damaged picture must not prevent showing the text.
    }
  }
  return model;
}
