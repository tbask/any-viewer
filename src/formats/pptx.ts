/**
 * Reader of pptx (Office Open XML PresentationML).
 *
 * Supported: slide size, background, shapes with fill and outline, text with emphasis and sizes,
 * bullets, pictures, groups, tables, inheritance of position and text formatting from the layout
 * and the slide master, theme colours.
 * Also: preset shape outlines, gradients, transparency, dashed outlines, shadows, line arrowheads, picture
 * cropping, vertical text, links, connectors, charts (from cached values) and SmartArt (from the ready layout).
 * Not supported: 3D effects, animation; preset shapes without a known outline
 * are drawn as rectangles.
 */
import { compactRunStyle, formatCounter, hexColor, type Inline, type RunStyle } from '../core/docmodel';
import { symbolChar } from '../core/symbols';
import { parseChart } from '../core/chart';
import type { Slide, SlideCell, SlidePara, SlideShape, SlidesModel } from '../core/slidemodel';
import { applyTint } from './xlsx';
import { attr, child, childrenOf, decodeXmlBytes, localName, parseXml, textContent, type XmlNode } from '../core/xml';
import { connectorOf, custGeomPath } from './drawingml';
import { loadImage } from '../core/images';
import { ZipReader } from '../core/zip';

const EMU = 9525;
const PRESET_COLORS: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080' };

type Transform = (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number };
const identity: Transform = (x, y, w, h) => ({ x, y, w, h });

interface Part {
  path: string;
  root: XmlNode;
  rels: Map<string, { target: string; type: string }>;
  /** External links (hyperlinks in text). */
  links: Map<string, string>;
}

interface Context {
  theme: Record<string, string>;
  clrMap: Record<string, string>;
  /** Inheritance chain: slide → layout → master. */
  layout?: Part;
  master?: Part;
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

function descendants(node: XmlNode | undefined, local: string, out: XmlNode[] = []): XmlNode[] {
  if (!node) return out;
  for (const c of node.children) {
    if (c.name === '#text') continue;
    if (localName(c.name) === local) out.push(c);
    descendants(c, local, out);
  }
  return out;
}

const n = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

export async function parsePptx(blob: Blob): Promise<SlidesModel> {
  const zip = await ZipReader.open(blob);
  const parts = new Map<string, Part | undefined>();
  const loadPart = async (path: string): Promise<Part | undefined> => {
    if (parts.has(path)) return parts.get(path);
    const entry = zip.get(path);
    let part: Part | undefined;
    if (entry) {
      const root = parseXml(decodeXmlBytes(await zip.read(entry)));
      const rels = new Map<string, { target: string; type: string }>();
      const links = new Map<string, string>();
      const slash = path.lastIndexOf('/');
      const relEntry = zip.get(`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`);
      if (relEntry) {
        for (const rel of childrenOf(parseXml(decodeXmlBytes(await zip.read(relEntry))), 'Relationship')) {
          const id = attr(rel, 'Id');
          const target = attr(rel, 'Target');
          if (id && target && attr(rel, 'TargetMode') !== 'External') rels.set(id, { target: resolvePath(path, target), type: attr(rel, 'Type') ?? '' });
          else if (id && target) links.set(id, target);
        }
      }
      part = { path, root, rels, links };
    }
    parts.set(path, part);
    return part;
  };
  const relByType = (part: Part, suffix: string) => [...part.rels.values()].find((r) => r.type.endsWith(suffix))?.target;

  const presentation = await loadPart('ppt/presentation.xml');
  if (!presentation) throw new Error('The file has no presentation (ppt/presentation.xml)');
  const size = child(presentation.root, 'sldSz');
  const model: SlidesModel = {
    width: Math.round((n(attr(size, 'cx')) ?? 9144000) / EMU),
    height: Math.round((n(attr(size, 'cy')) ?? 6858000) / EMU),
    slides: [],
    images: {},
  };
  const imagePaths = new Set<string>();

  // --- colours ---
  const colorOf = (holder: XmlNode | undefined, ctx: Context): string | undefined => {
    if (!holder) return undefined;
    for (const c of holder.children) {
      if (c.name === '#text') continue;
      const kind = localName(c.name);
      let base: string | undefined;
      if (kind === 'srgbClr') base = hexColor(attr(c, 'val'));
      else if (kind === 'sysClr') base = hexColor(attr(c, 'lastClr'));
      else if (kind === 'prstClr') base = PRESET_COLORS[attr(c, 'val') ?? ''];
      else if (kind === 'schemeClr') {
        const name = attr(c, 'val') ?? '';
        base = ctx.theme[ctx.clrMap[name] ?? name] ?? ctx.theme[name];
      } else continue;
      if (!base) return undefined;
      // Brightness modifiers: darkening and lightening are given in thousandths of a percent.
      const mod = n(attr(child(c, 'lumMod'), 'val'));
      const off = n(attr(child(c, 'lumOff'), 'val'));
      const tint = n(attr(child(c, 'tint'), 'val'));
      const shade = n(attr(child(c, 'shade'), 'val'));
      if (mod !== undefined && off !== undefined) base = applyTint(base, off / 100000);
      else if (mod !== undefined && mod < 100000) base = applyTint(base, -(1 - mod / 100000));
      if (tint !== undefined) base = applyTint(base, 1 - tint / 100000);
      if (shade !== undefined) base = applyTint(base, -(1 - shade / 100000));
      return base;
    }
    return undefined;
  };

  /** Colour opacity (0–1), if given. */
  const alphaOf = (holder: XmlNode | undefined): number | undefined => {
    const a = n(attr(descendants(holder, 'alpha')[0], 'val'));
    return a !== undefined && a < 100000 ? Math.max(0, a / 100000) : undefined;
  };
  /** Gradient: colour stops and angle. */
  const gradientOf = (pr: XmlNode | undefined, ctx: Context): SlideShape['gradient'] | undefined => {
    const grad = child(pr, 'gradFill');
    if (!grad) return undefined;
    const stops: { at: number; color: string }[] = [];
    for (const gs of childrenOf(child(grad, 'gsLst'), 'gs')) {
      const color = colorOf(gs, ctx);
      if (color) stops.push({ at: Math.min(1, Math.max(0, (n(attr(gs, 'pos')) ?? 0) / 100000)), color });
    }
    if (stops.length < 2) return undefined;
    stops.sort((a, b) => a.at - b.at);
    return { angle: (n(attr(child(grad, 'lin'), 'ang')) ?? 5400000) / 60000, stops };
  };

  /** Fill: a colour, 'none' (explicitly no fill) or undefined (not set). */
  const fillOf = (pr: XmlNode | undefined, ctx: Context): string | undefined => {
    if (!pr) return undefined;
    if (child(pr, 'noFill')) return 'none';
    const solid = child(pr, 'solidFill');
    if (solid) return colorOf(solid, ctx);
    const grad = child(pr, 'gradFill');
    if (grad) return colorOf(descendants(grad, 'gs')[0], ctx);
    return undefined;
  };

  const contextFor = async (slide: Part): Promise<Context> => {
    const layoutPath = relByType(slide, '/slideLayout');
    const layout = layoutPath ? await loadPart(layoutPath) : undefined;
    const masterPath = layout ? relByType(layout, '/slideMaster') : undefined;
    const master = masterPath ? await loadPart(masterPath) : undefined;
    const themePath = master ? relByType(master, '/theme') : undefined;
    const themePart = themePath ? await loadPart(themePath) : undefined;
    const theme: Record<string, string> = {};
    for (const c of childrenOf(child(child(themePart?.root, 'themeElements'), 'clrScheme'))) {
      const value = attr(child(c, 'srgbClr'), 'val') ?? attr(child(c, 'sysClr'), 'lastClr');
      if (value) theme[localName(c.name)] = `#${value.toLowerCase()}`;
    }
    const clrMap: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
    const mapNode = child(master?.root, 'clrMap');
    if (mapNode) for (const key in mapNode.attrs) clrMap[key] = mapNode.attrs[key];
    return { theme, clrMap, layout, master };
  };

  // --- placeholders: finding the match in the layout and the master ---
  const phInfo = (sp: XmlNode): { type: string; idx: string | undefined } | undefined => {
    const ph = descendants(child(sp, 'nvSpPr') ?? child(sp, 'nvPicPr'), 'ph')[0];
    return ph ? { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') } : undefined;
  };
  const phFamily = (type: string) => (type === 'ctrTitle' ? 'title' : type === 'subTitle' ? 'body' : type);
  const findPlaceholder = (part: Part | undefined, ph: { type: string; idx: string | undefined }, byIndex = true): XmlNode | undefined => {
    const shapes = descendants(child(child(part?.root, 'cSld'), 'spTree'), 'sp');
    let byType: XmlNode | undefined;
    for (const sp of shapes) {
      const other = phInfo(sp);
      if (!other) continue;
      // The index links a slide placeholder to its layout; in the master the same number may belong to another kind.
      if (ph.idx !== undefined && other.idx === ph.idx && (byIndex || phFamily(other.type) === phFamily(ph.type))) return sp;
      if (!byType && phFamily(other.type) === phFamily(ph.type)) byType = sp;
    }
    return byType;
  };

  const xfrmOf = (pr: XmlNode | undefined) => {
    const xfrm = child(pr, 'xfrm');
    const off = child(xfrm, 'off');
    const ext = child(xfrm, 'ext');
    if (!off || !ext) return undefined;
    return { x: (n(attr(off, 'x')) ?? 0) / EMU, y: (n(attr(off, 'y')) ?? 0) / EMU, w: (n(attr(ext, 'cx')) ?? 0) / EMU, h: (n(attr(ext, 'cy')) ?? 0) / EMU, rot: (n(attr(xfrm, 'rot')) ?? 0) / 60000, flipH: attr(xfrm, 'flipH') === '1', flipV: attr(xfrm, 'flipV') === '1' };
  };

  // --- text ---
  const parseText = (txBody: XmlNode | undefined, ctx: Context, levelChains: (level: number) => (XmlNode | undefined)[], defaults: { size: number; color?: string; bullets: boolean; bold?: boolean }, links?: Map<string, string>): SlidePara[] => {
    const paras: SlidePara[] = [];
    let autoNumber = 0;
    let autoLevel = -1;
    for (const p of childrenOf(txBody, 'p')) {
      const pPr = child(p, 'pPr');
      const level = Math.min(n(attr(pPr, 'lvl')) ?? 0, 8);
      const chain = [pPr, ...levelChains(level)];
      const pick = <T>(get: (node: XmlNode) => T | undefined): T | undefined => {
        for (const node of chain) {
          if (!node) continue;
          const v = get(node);
          if (v !== undefined) return v;
        }
        return undefined;
      };
      const defRun = (name: string) => pick((node) => attr(child(node, 'defRPr'), name));
      const baseSize = (n(defRun('sz')) ?? defaults.size * 100) / 100;
      const baseColor = pick((node) => colorOf(child(child(node, 'defRPr'), 'solidFill'), ctx)) ?? defaults.color;
      const baseBold = defRun('b') === '1' || (defRun('b') === undefined && defaults.bold);
      const algn = pick((node) => attr(node, 'algn'));
      const bullet = pick((node) => (child(node, 'buNone') ? 'none' : child(node, 'buChar') ? 'char' : child(node, 'buAutoNum') ? 'num' : undefined)) ?? (defaults.bullets ? 'char' : 'none');

      const runs: Inline[] = [];
      for (const c of p.children) {
        if (c.name === '#text') continue;
        const kind = localName(c.name);
        if (kind === 'br') {
          runs.push({ k: 'br' });
        } else if (kind === 'r' || kind === 'fld') {
          const rPr = child(c, 'rPr');
          const text = descendants(c, 't').map((t) => t.children.map((x) => x.text).join('')).join('');
          if (!text) continue;
          const b = attr(rPr, 'b');
          const style: RunStyle = {
            size: (n(attr(rPr, 'sz')) ?? baseSize * 100) / 100,
            b: b === '1' || (b === undefined && baseBold) ? 1 : 0,
            i: attr(rPr, 'i') === '1' ? 1 : 0,
            u: attr(rPr, 'u') && attr(rPr, 'u') !== 'none' ? 1 : 0,
            s: attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike' ? 1 : 0,
            color: colorOf(child(rPr, 'solidFill'), ctx) ?? baseColor,
          };
          const baseline = n(attr(rPr, 'baseline'));
          if (baseline) style.va = baseline > 0 ? 'sup' : 'sub';
          const outline = fillOf(child(rPr, 'ln'), ctx);
          if (outline && outline !== 'none') style.outline = outline;
          if (descendants(child(rPr, 'effectLst'), 'outerShdw').length) style.shadow = 1;
          const highlight = colorOf(child(rPr, 'highlight'), ctx);
          if (highlight) style.bg = highlight;
          const font = attr(child(rPr, 'latin'), 'typeface');
          if (font && !font.startsWith('+')) style.font = font;
          const link = links?.get(child(rPr, 'hlinkClick')?.attrs['r:id'] ?? '');
          if (link && /^(https?:|mailto:)/i.test(link)) {
            // A hyperlink looks like one: the theme's link colour and an underline, unless the run sets its own.
            if (!colorOf(child(rPr, 'solidFill'), ctx)) style.color = ctx.theme.hlink ?? '#0563c1';
            style.u = 1;
            runs.push({ k: 'text', text, s: compactRunStyle(style), href: link });
          }
          else runs.push({ k: 'text', text, s: compactRunStyle(style) });
        }
      }
      const para: SlidePara = { runs };
      if (algn === 'ctr') para.align = 'center';
      else if (algn === 'r') para.align = 'right';
      else if (algn === 'just') para.align = 'justify';
      if (level) para.level = level;
      const bulletColor = pick((node) => colorOf(child(node, 'buClr'), ctx));
      if (runs.length && bullet === 'char') {
        // The bullet character from the file; characters of symbol fonts (Wingdings) are mapped to regular ones.
        const char = pick((node) => attr(child(node, 'buChar'), 'char'));
        const font = pick((node) => attr(child(node, 'buFont'), 'typeface'));
        para.marker = (char ? symbolChar(font, char, '•').trim() : '') || '•';
        if (bulletColor) para.markerColor = bulletColor;
        autoNumber = 0;
        autoLevel = -1;
      } else if (runs.length && bullet === 'num') {
        const auto = pick((node) => child(node, 'buAutoNum'));
        const type = attr(auto, 'type') ?? 'arabicPeriod';
        if (autoLevel !== level) autoNumber = (n(attr(auto, 'startAt')) ?? 1) - 1;
        autoLevel = level;
        const value = formatCounter(++autoNumber, /^alphaLc/.test(type) ? 'a' : /^alphaUc/.test(type) ? 'A' : /^romanLc/.test(type) ? 'i' : /^romanUc/.test(type) ? 'I' : '1');
        para.marker = /ParenBoth$/.test(type) ? `(${value})` : /ParenR$/.test(type) ? `${value})` : /Plain$/.test(type) ? value : `${value}.`;
        if (bulletColor) para.markerColor = bulletColor;
      } else if (runs.length) {
        autoNumber = 0;
        autoLevel = -1;
      }
      // An empty paragraph keeps a line height of the right size.
      if (!runs.length) para.runs.push({ k: 'text', text: '​', s: { size: (n(attr(child(p, 'endParaRPr'), 'sz')) ?? baseSize * 100) / 100 } });
      paras.push(para);
    }
    return paras;
  };

  let tableStyleCache: Map<string, XmlNode> | undefined;
  const tableStyles = async (): Promise<Map<string, XmlNode>> => {
    if (tableStyleCache) return tableStyleCache;
    tableStyleCache = new Map();
    try {
      const part = await loadPart('ppt/tableStyles.xml');
      for (const st of childrenOf(part?.root, 'tblStyle')) tableStyleCache.set(attr(st, 'styleId') ?? '', st);
    } catch {
      // No style list: tables keep their own cell fills.
    }
    return tableStyleCache;
  };

  const lvlNode = (holder: XmlNode | undefined, level: number) => child(holder, `lvl${level + 1}pPr`);

  // --- shapes ---
  const parseTree = async (tree: XmlNode | undefined, part: Part, ctx: Context, out: SlideShape[], tf: Transform, onlyDecor: boolean): Promise<void> => {
    for (const node of childrenOf(tree)) {
      const kind = localName(node.name);
      if (kind === 'AlternateContent') {
        // An object for new Office versions (a newer chart type, say) and its fallback for old ones: take the first.
        await parseTree(child(node, 'Choice') ?? child(node, 'Fallback'), part, ctx, out, tf, onlyDecor);
        continue;
      }
      if (kind === 'grpSp') {
        const g = child(child(node, 'grpSpPr'), 'xfrm');
        const off = child(g, 'off');
        const ext = child(g, 'ext');
        const chOff = child(g, 'chOff');
        const chExt = child(g, 'chExt');
        let inner = tf;
        if (off && ext && chOff && chExt) {
          const ox = (n(attr(off, 'x')) ?? 0) / EMU;
          const oy = (n(attr(off, 'y')) ?? 0) / EMU;
          const cx = (n(attr(chOff, 'x')) ?? 0) / EMU;
          const cy = (n(attr(chOff, 'y')) ?? 0) / EMU;
          const sx = (n(attr(ext, 'cx')) ?? 1) / ((n(attr(chExt, 'cx')) ?? 1) || 1);
          const sy = (n(attr(ext, 'cy')) ?? 1) / ((n(attr(chExt, 'cy')) ?? 1) || 1);
          inner = (x, y, w, h) => tf(ox + (x - cx) * sx, oy + (y - cy) * sy, w * sx, h * sy);
        }
        await parseTree(node, part, ctx, out, inner, onlyDecor);
        continue;
      }
      if (kind !== 'sp' && kind !== 'pic' && kind !== 'graphicFrame' && kind !== 'cxnSp') continue;
      const ph = kind === 'sp' || kind === 'pic' ? phInfo(node) : undefined;
      // Only decoration (logos, bars) is taken from the layout and master, not empty placeholders.
      if (onlyDecor && ph) continue;

      const spPr = child(node, 'spPr');
      const layoutPh = ph ? findPlaceholder(ctx.layout, ph) : undefined;
      const masterPh = ph ? findPlaceholder(ctx.master, layoutPh ? phInfo(layoutPh) ?? ph : ph, false) : undefined;
      const box = xfrmOf(kind === 'graphicFrame' ? node : spPr) ?? xfrmOf(child(layoutPh, 'spPr')) ?? xfrmOf(child(masterPh, 'spPr'));
      if (!box) continue;
      const placed = tf(box.x, box.y, box.w, box.h);
      const shape: SlideShape = { x: placed.x, y: placed.y, w: placed.w, h: placed.h };
      if (box.rot) shape.rot = box.rot;
      if (box.flipH) shape.flipH = true;
      if (box.flipV) shape.flipV = true;

      if (kind === 'graphicFrame') {
        const tbl = descendants(node, 'tbl')[0];
        if (tbl) {
          const widths = childrenOf(child(tbl, 'tblGrid'), 'gridCol').map((c) => (n(attr(c, 'w')) ?? 0) / EMU);
          const rows: SlideCell[][] = [];
          // Table style: the header row, banded rows and edge columns take fills and text colours from it.
          const tblPr = child(tbl, 'tblPr');
          const styleId = textContent(child(tblPr, 'tableStyleId')).trim();
          const tableStyle = styleId ? (await tableStyles()).get(styleId) : undefined;
          const flag = (name: string) => attr(tblPr, name) === '1' || attr(tblPr, name) === 'true';
          const trs = childrenOf(tbl, 'tr');
          const columnCount = widths.length;
          const partFor = (r: number, c: number): XmlNode[] => {
            if (!tableStyle) return [];
            const parts: (XmlNode | undefined)[] = [];
            if (flag('firstRow') && r === 0) parts.push(child(tableStyle, 'firstRow'));
            if (flag('lastRow') && r === trs.length - 1) parts.push(child(tableStyle, 'lastRow'));
            if (flag('firstCol') && c === 0) parts.push(child(tableStyle, 'firstCol'));
            if (flag('lastCol') && c === columnCount - 1) parts.push(child(tableStyle, 'lastCol'));
            if (flag('bandRow')) parts.push(child(tableStyle, (r - (flag('firstRow') ? 1 : 0)) % 2 === 0 ? 'band1H' : 'band2H'));
            if (flag('bandCol')) parts.push(child(tableStyle, (c - (flag('firstCol') ? 1 : 0)) % 2 === 0 ? 'band1V' : 'band2V'));
            parts.push(child(tableStyle, 'wholeTbl'));
            return parts.filter((p): p is XmlNode => !!p);
          };
          for (const [rowIndex, tr] of trs.entries()) {
            const cells: SlideCell[] = [];
            let colIndex = 0;
            for (const tc of childrenOf(tr, 'tc')) {
              const styleParts = partFor(rowIndex, colIndex);
              colIndex += n(attr(tc, 'gridSpan')) ?? 1;
              const cell: SlideCell = { paras: [] };
              if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') cell.skip = true;
              const cs = n(attr(tc, 'gridSpan'));
              const rsp = n(attr(tc, 'rowSpan'));
              if (cs && cs > 1) cell.colSpan = cs;
              if (rsp && rsp > 1) cell.rowSpan = rsp;
              let bg = fillOf(child(tc, 'tcPr'), ctx);
              for (const part of styleParts) bg ??= fillOf(child(child(part, 'tcStyle'), 'fill'), ctx);
              if (bg && bg !== 'none') cell.bg = bg;
              let textColor: string | undefined;
              let bold: boolean | undefined;
              for (const part of styleParts) {
                const tx = child(part, 'tcTxStyle');
                textColor ??= colorOf(tx, ctx);
                if (bold === undefined && attr(tx, 'b')) bold = attr(tx, 'b') === 'on';
              }
              if (!cell.skip) cell.paras = parseText(child(tc, 'txBody'), ctx, () => [], { size: 18, color: textColor ?? ctx.theme[ctx.clrMap.tx1 ?? 'dk1'], bullets: false, bold });
              cells.push(cell);
            }
            rows.push(cells);
          }
          shape.table = { rows, widths };
        } else {
          const chartRef = descendants(node, 'chart')[0];
          const chartPath = chartRef ? part.rels.get(chartRef.attrs['r:id'] ?? '')?.target : undefined;
          const chartPart = chartPath ? await loadPart(chartPath) : undefined;
          const chart = chartPart ? parseChart(chartPart.root, Object.fromEntries(Object.entries(ctx.theme))) : undefined;
          // SmartArt: the file holds a ready layout of shapes; draw it.
          const diagram = descendants(node, 'relIds')[0] ? [...part.rels.values()].find((r) => r.type.endsWith('/diagramDrawing')) : undefined;
          const diagramPart = diagram ? await loadPart(diagram.target) : undefined;
          const diagramTree = diagramPart ? descendants(diagramPart.root, 'spTree')[0] : undefined;
          if (chart) shape.chart = chart;
          else if (diagramPart && diagramTree) {
            const before = out.length;
            await parseTree(diagramTree, diagramPart, ctx, out, (x, y, w, h) => tf(box.x + x, box.y + y, w, h), false);
            if (out.length > before) continue;
            shape.placeholder = 'object';
          } else shape.placeholder = chartRef ? 'chart' : 'object';
        }
        out.push(shape);
        continue;
      }

      if (kind === 'pic') {
        const blip = descendants(child(node, 'blipFill'), 'blip')[0];
        const target = part.rels.get(blip?.attrs['r:embed'] ?? '')?.target;
        if (!target) continue;
        imagePaths.add(target);
        shape.img = target;
        // An SVG icon is stored in two forms; the browser gets the vector one if present.
        const svgBlip = descendants(blip, 'svgBlip')[0];
        const svgTarget = svgBlip ? part.rels.get(svgBlip.attrs['r:embed'] ?? '')?.target : undefined;
        if (svgTarget) {
          imagePaths.add(svgTarget);
          shape.img = svgTarget;
        }
        const src = child(child(node, 'blipFill'), 'srcRect');
        if (src) {
          const side = (name: string) => Math.min(0.95, Math.max(0, (n(attr(src, name)) ?? 0) / 100000));
          const crop = { l: side('l'), t: side('t'), r: side('r'), b: side('b') };
          if (crop.l || crop.t || crop.r || crop.b) shape.crop = crop;
        }
        const picLn = child(spPr, 'ln');
        const picStroke = picLn ? fillOf(picLn, ctx) : undefined;
        if (picStroke && picStroke !== 'none') {
          shape.stroke = picStroke;
          shape.strokeWidth = Math.max(1, ((n(attr(picLn, 'w')) ?? 9525) / 12700) * (96 / 72));
        }
        out.push(shape);
        continue;
      }

      // A regular shape or a connector.
      const geom = attr(child(spPr, 'prstGeom'), 'prst');
      if (kind === 'cxnSp' || geom === 'line' || geom === 'straightConnector1') {
        shape.shape = 'line';
        const connector = connectorOf(geom, child(spPr, 'prstGeom'));
        if (connector) shape.connector = connector;
      }
      else if (geom === 'ellipse' || geom === 'flowChartConnector') shape.shape = 'ellipse';
      else if (geom === 'roundRect' || geom === 'flowChartAlternateProcess') shape.shape = 'round';
      else if (geom && geom !== 'rect' && geom !== 'flowChartProcess') shape.geom = geom;
      const freeform = custGeomPath(spPr);
      if (freeform) shape.path = freeform;

      const styleNode = child(node, 'style');
      let fill = fillOf(spPr, ctx) ?? fillOf(child(layoutPh, 'spPr'), ctx) ?? fillOf(child(masterPh, 'spPr'), ctx);
      if (fill === undefined && !ph && attr(child(styleNode, 'fillRef'), 'idx') !== '0') fill = colorOf(child(styleNode, 'fillRef'), ctx);
      if (fill && fill !== 'none') shape.fill = fill;
      const ln = child(spPr, 'ln');
      let stroke = ln ? fillOf(ln, ctx) : undefined;
      if (stroke === undefined && !ph && attr(child(styleNode, 'lnRef'), 'idx') !== '0') stroke = colorOf(child(styleNode, 'lnRef'), ctx);
      if (stroke && stroke !== 'none') shape.stroke = stroke;
      const gradient = gradientOf(spPr, ctx);
      if (gradient) shape.gradient = gradient;
      const alpha = alphaOf(child(spPr, 'solidFill'));
      if (alpha !== undefined) shape.alpha = alpha;
      if (ln) {
        const lineW = n(attr(ln, 'w'));
        if (lineW) shape.strokeWidth = Math.max(1, (lineW / 12700) * (96 / 72));
        const dash = attr(child(ln, 'prstDash'), 'val');
        if (dash && dash !== 'solid') shape.dash = true;
        const ends = (name: string) => {
          const type = attr(child(ln, name), 'type');
          return !!type && type !== 'none';
        };
        if (ends('headEnd')) shape.arrowStart = true;
        if (ends('tailEnd')) shape.arrowEnd = true;
      }
      // A shadow set on the shape, a theme effect that has one (styles 3 and up), or volume, which is shown as a shadow.
      const effects = child(spPr, 'effectLst');
      if (descendants(effects, 'outerShdw').length || child(spPr, 'sp3d') || (!effects && (n(attr(child(child(node, 'style'), 'effectRef'), 'idx')) ?? 0) >= 3 && shape.shape !== 'line')) shape.shadow = true;
      const blipFill = descendants(child(spPr, 'blipFill'), 'blip')[0];
      const blipTarget = blipFill ? part.rels.get(blipFill.attrs['r:embed'] ?? '')?.target : undefined;
      if (blipTarget) {
        imagePaths.add(blipTarget);
        shape.img = blipTarget;
      }

      const txBody = child(node, 'txBody');
      if (txBody) {
        const family = ph ? phFamily(ph.type) : 'other';
        const styles = child(ctx.master?.root, 'txStyles');
        const masterStyle = family === 'title' ? child(styles, 'titleStyle') : family === 'body' ? child(styles, 'bodyStyle') : child(styles, 'otherStyle');
        const chains = (level: number) => [
          lvlNode(child(txBody, 'lstStyle'), level),
          lvlNode(child(child(layoutPh, 'txBody'), 'lstStyle'), level),
          lvlNode(child(child(masterPh, 'txBody'), 'lstStyle'), level),
          ph ? lvlNode(masterStyle, level) : undefined,
        ];
        const fontRef = colorOf(child(styleNode, 'fontRef'), ctx);
        shape.paras = parseText(txBody, ctx, chains, {
          size: family === 'title' ? 44 : family === 'body' ? 28 : 18,
          color: fontRef ?? ctx.theme[ctx.clrMap.tx1 ?? 'dk1'],
          bullets: false,
        }, part.links);
        const bodyPr = [child(txBody, 'bodyPr'), child(child(layoutPh, 'txBody'), 'bodyPr'), child(child(masterPh, 'txBody'), 'bodyPr')];
        const anchor = bodyPr.map((b) => attr(b, 'anchor')).find((a) => a !== undefined);
        shape.anchor = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
        const vert = bodyPr.map((b) => attr(b, 'vert')).find((v) => v !== undefined);
        if (vert === 'vert270') shape.textRot = 270;
        else if (vert === 'vert' || vert === 'eaVert' || vert === 'wordArtVert') shape.textRot = 90;
        const scale = n(attr(child(bodyPr[0], 'normAutofit'), 'fontScale'));
        if (scale) shape.fontScale = scale / 100000;
        const hasText = shape.paras.some((p) => p.runs.some((r) => r.k === 'text' && r.text !== '​'));
        if (!hasText) {
          delete shape.paras;
          // An empty placeholder ("Slide title") without a fill is not shown.
          if (ph && !shape.fill && !shape.img && !shape.gradient) continue;
        }
      }
      if (!shape.paras && !shape.fill && !shape.stroke && !shape.img && !shape.gradient) continue;
      out.push(shape);
    }
  };

  const backgroundOf = (part: Part | undefined, ctx: Context): { color?: string; img?: string; gradient?: SlideShape['gradient'] } | undefined => {
    const bg = child(child(part?.root, 'cSld'), 'bg');
    if (!bg || !part) return undefined;
    const bgPr = child(bg, 'bgPr');
    const blip = descendants(child(bgPr, 'blipFill'), 'blip')[0];
    const img = blip ? part.rels.get(blip.attrs['r:embed'] ?? '')?.target : undefined;
    if (img) return { img };
    const gradient = gradientOf(bgPr, ctx);
    if (gradient) return { gradient, color: gradient.stops[0].color };
    const color = fillOf(bgPr, ctx) ?? colorOf(child(bg, 'bgRef'), ctx);
    return color && color !== 'none' ? { color } : undefined;
  };

  // --- slides in order ---
  for (const id of childrenOf(child(presentation.root, 'sldIdLst'), 'sldId')) {
    const target = presentation.rels.get(id.attrs['r:id'] ?? '')?.target;
    const part = target ? await loadPart(target) : undefined;
    if (!part) continue;
    if (attr(part.root, 'show') === '0') continue; // hidden slide
    const ctx = await contextFor(part);
    const slide: Slide = { shapes: [] };
    const bg = backgroundOf(part, ctx) ?? backgroundOf(ctx.layout, ctx) ?? backgroundOf(ctx.master, ctx);
    if (bg?.color) slide.bg = bg.color;
    if (bg?.gradient) slide.bgGradient = bg.gradient;
    if (bg?.img) {
      slide.bgImg = bg.img;
      imagePaths.add(bg.img);
    }
    const showMaster = attr(part.root, 'showMasterSp') !== '0' && attr(ctx.layout?.root, 'showMasterSp') !== '0';
    if (showMaster && ctx.master) await parseTree(child(child(ctx.master.root, 'cSld'), 'spTree'), ctx.master, ctx, slide.shapes, identity, true);
    if (ctx.layout) await parseTree(child(child(ctx.layout.root, 'cSld'), 'spTree'), ctx.layout, ctx, slide.shapes, identity, true);
    await parseTree(child(child(part.root, 'cSld'), 'spTree'), part, ctx, slide.shapes, identity, false);
    model.slides.push(slide);
  }

  for (const path of imagePaths) {
    const entry = zip.get(path);
    if (!entry) continue;
    try {
      const image = loadImage(path, await zip.read(entry));
      if (image) model.images[path] = image;
    } catch {
      // A damaged picture must not prevent showing the slides.
    }
  }
  return model;
}
