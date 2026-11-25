/**
 * Shared DrawingML shape parsing, for SmartArt and shapes in Word documents. (pptx has its own, fuller parser:
 * it has inheritance from layouts.)
 */
import { makeColorResolver, type ColorResolver } from '../core/chart';
import { compactRunStyle, type Block, type Inline, type RunStyle } from '../core/docmodel';
import type { SlidePara, SlideShape } from '../core/slidemodel';
import { attr, child, childrenOf, localName, type XmlNode } from '../core/xml';

const EMU = 9525;
const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};

export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Connector with elbows: bentConnector3, curvedConnector2 and the like. */
export function connectorOf(geom: string | undefined, prstGeom: XmlNode | undefined): SlideShape['connector'] {
  const m = geom ? /^(bent|curved)Connector(\d)$/.exec(geom) : null;
  if (!m) return undefined;
  const adj: number[] = [];
  for (const gd of childrenOf(child(prstGeom, 'avLst'), 'gd')) {
    const index = Number(/^adj(\d)$/.exec(attr(gd, 'name') ?? '')?.[1]) - 1;
    const value = Number(/val\s+(-?\d+)/.exec(attr(gd, 'fmla') ?? '')?.[1]);
    if (index >= 0 && Number.isFinite(value)) adj[index] = value / 100000;
  }
  return { kind: m[1] as 'bent' | 'curved', elbows: Number(m[2]) - 1, ...(adj.length ? { adj } : {}) };
}

/**
 * Freeform outline (a:custGeom): M, L, C, Q, Z commands with coordinates as fractions of the shape frame.
 * Arcs become Bézier curves. undefined: there is no outline or it uses formulas (guides) instead of numbers.
 */
export function custGeomPath(spPr: XmlNode | undefined): (string | number)[] | undefined {
  const paths = childrenOf(child(child(spPr, 'custGeom'), 'pathLst'), 'path');
  if (!paths.length) return undefined;
  const out: (string | number)[] = [];
  for (const path of paths) {
    // Without its own size the path is in the units of the shape frame (SmartArt connectors are written so).
    const ext = child(child(spPr, 'xfrm'), 'ext');
    const w = Number(attr(path, 'w')) || Number(attr(ext, 'cx')) || 0;
    const h = Number(attr(path, 'h')) || Number(attr(ext, 'cy')) || 0;
    if (w <= 0 && h <= 0) return undefined;
    let cx = 0;
    let cy = 0;
    let bad = false;
    const points = (node: XmlNode): number[] => {
      const list: number[] = [];
      for (const pt of childrenOf(node, 'pt')) {
        const x = Number(attr(pt, 'x'));
        const y = Number(attr(pt, 'y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) bad = true;
        list.push(w > 0 ? x / w : 0, h > 0 ? y / h : 0);
      }
      return list;
    };
    for (const c of childrenOf(path)) {
      const name = localName(c.name);
      const pts = name === 'arcTo' || name === 'close' ? [] : points(c);
      if (bad) return undefined;
      if (name === 'moveTo' && pts.length >= 2) out.push('M', pts[0], pts[1]);
      else if (name === 'lnTo' && pts.length >= 2) out.push('L', pts[0], pts[1]);
      else if (name === 'cubicBezTo' && pts.length >= 6) out.push('C', ...pts.slice(0, 6));
      else if (name === 'quadBezTo' && pts.length >= 4) out.push('Q', ...pts.slice(0, 4));
      else if (name === 'close') out.push('Z');
      else if (name === 'arcTo') {
        const rx = Number(attr(c, 'wR')) / w;
        const ry = Number(attr(c, 'hR')) / h;
        const start = (Number(attr(c, 'stAng')) / 60000) * (Math.PI / 180);
        const sweep = (Number(attr(c, 'swAng')) / 60000) * (Math.PI / 180);
        if (![rx, ry, start, sweep].every(Number.isFinite)) return undefined;
        // The arc starts at the current point; its centre follows from the start angle.
        const ox = cx - rx * Math.cos(start);
        const oy = cy - ry * Math.sin(start);
        const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
        const step = sweep / parts;
        const k = (4 / 3) * Math.tan(step / 4);
        for (let i = 0; i < parts; i++) {
          const a0 = start + i * step;
          const a1 = a0 + step;
          out.push('C', ox + rx * (Math.cos(a0) - k * Math.sin(a0)), oy + ry * (Math.sin(a0) + k * Math.cos(a0)), ox + rx * (Math.cos(a1) + k * Math.sin(a1)), oy + ry * (Math.sin(a1) - k * Math.cos(a1)), ox + rx * Math.cos(a1), oy + ry * Math.sin(a1));
        }
        pts.push(ox + rx * Math.cos(start + sweep), oy + ry * Math.sin(start + sweep));
      }
      if (pts.length >= 2) {
        cx = pts[pts.length - 2];
        cy = pts[pts.length - 1];
      }
    }
  }
  return out.length > 2 ? out : undefined;
}

/** Shape look from spPr and style: outline, fill, gradient, shadow. */
export function shapeLook(spPr: XmlNode | undefined, style: XmlNode | undefined, color: ColorResolver, shape: SlideShape): void {
  const geom = attr(child(spPr, 'prstGeom'), 'prst');
  if (geom === 'line' || geom === 'straightConnector1' || (geom && /Connector/.test(geom))) shape.shape = 'line';
  const connector = connectorOf(geom, child(spPr, 'prstGeom'));
  if (connector) shape.connector = connector;
  else if (geom === 'ellipse' || geom === 'flowChartConnector') shape.shape = 'ellipse';
  else if (geom === 'roundRect' || geom === 'flowChartAlternateProcess') shape.shape = 'round';
  else if (geom && geom !== 'rect' && geom !== 'flowChartProcess') shape.geom = geom;
  const freeform = custGeomPath(spPr);
  if (freeform) shape.path = freeform;

  const xfrm = child(spPr, 'xfrm');
  const rot = num(attr(xfrm, 'rot'));
  if (rot) shape.rot = rot / 60000;
  if (attr(xfrm, 'flipH') === '1') shape.flipH = true;
  if (attr(xfrm, 'flipV') === '1') shape.flipV = true;

  if (!child(spPr, 'noFill')) {
    const solid = child(spPr, 'solidFill');
    const grad = child(spPr, 'gradFill');
    if (solid) {
      shape.fill = color(solid);
      const holder = solid.children.find((c) => c.name !== '#text');
      const alpha = num(attr(child(holder, 'alpha'), 'val'));
      if (alpha !== undefined && alpha < 100000) shape.alpha = alpha / 100000;
    } else if (grad) {
      const stops = childrenOf(child(grad, 'gsLst'), 'gs')
        .map((gs) => ({ at: Math.min(1, Math.max(0, (num(attr(gs, 'pos')) ?? 0) / 100000)), color: color(gs) }))
        .filter((s): s is { at: number; color: string } => !!s.color)
        .sort((a, b) => a.at - b.at);
      if (stops.length > 1) shape.gradient = { angle: (num(attr(child(grad, 'lin'), 'ang')) ?? 5400000) / 60000, stops };
      else if (stops.length) shape.fill = stops[0].color;
    } else if (shape.shape !== 'line' && attr(child(style, 'fillRef'), 'idx') !== '0') {
      shape.fill = color(child(style, 'fillRef'));
    }
  }
  const ln = child(spPr, 'ln');
  if (!child(ln, 'noFill')) {
    const stroke = color(child(ln, 'solidFill')) ?? (attr(child(style, 'lnRef'), 'idx') !== '0' ? color(child(style, 'lnRef')) : undefined);
    if (stroke) shape.stroke = stroke;
    const w = num(attr(ln, 'w'));
    if (w) shape.strokeWidth = Math.max(1, (w / 12700) * (96 / 72));
    const dash = attr(child(ln, 'prstDash'), 'val');
    if (dash && dash !== 'solid') shape.dash = true;
    const end = (name: string) => {
      const type = attr(child(ln, name), 'type');
      return !!type && type !== 'none';
    };
    if (end('headEnd')) shape.arrowStart = true;
    if (end('tailEnd')) shape.arrowEnd = true;
  }
  const effects = child(spPr, 'effectLst');
  if (effects && child(effects, 'outerShdw')) shape.shadow = true;
}

/** Shape text in DrawingML form (a:p, a:r). */
export function drawingText(txBody: XmlNode | undefined, color: ColorResolver, defaults: { size: number; color?: string }): SlidePara[] {
  const paras: SlidePara[] = [];
  for (const p of childrenOf(txBody, 'p')) {
    const pPr = child(p, 'pPr');
    const runs: Inline[] = [];
    for (const c of p.children) {
      if (c.name === '#text') continue;
      const kind = localName(c.name);
      if (kind === 'br') runs.push({ k: 'br' });
      else if (kind === 'r' || kind === 'fld') {
        const rPr = child(c, 'rPr');
        const text = childrenOf(c, 't').map((t) => t.children.map((x) => x.text).join('')).join('');
        if (!text) continue;
        const style: RunStyle = {
          size: (num(attr(rPr, 'sz')) ?? defaults.size * 100) / 100,
          b: attr(rPr, 'b') === '1' ? 1 : 0,
          i: attr(rPr, 'i') === '1' ? 1 : 0,
          color: color(child(rPr, 'solidFill')) ?? defaults.color,
        };
        runs.push({ k: 'text', text, s: compactRunStyle(style) });
      }
    }
    const para: SlidePara = { runs };
    const algn = attr(pPr, 'algn');
    if (algn === 'ctr') para.align = 'center';
    else if (algn === 'r') para.align = 'right';
    const level = num(attr(pPr, 'lvl'));
    if (level) para.level = level;
    if (child(pPr, 'buChar') && runs.length) para.marker = '•';
    paras.push(para);
  }
  return paras;
}

/** Word document paragraphs → shape paragraphs. Tables inside a shape are not carried over. */
export function blocksToParas(blocks: Block[], fallbackColor?: string): SlidePara[] | undefined {
  const paras: SlidePara[] = [];
  for (const b of blocks) {
    if (b.k !== 'p') return undefined;
    const runs = b.runs.filter((r) => r.k !== 'img' && r.k !== 'math') as Inline[];
    if (runs.length !== b.runs.length) return undefined;
    const para: SlidePara = {
      runs: runs.map((r) => (r.k === 'text' ? { ...r, s: { size: 11, ...(fallbackColor && !r.s?.color ? { color: fallbackColor } : {}), ...r.s } } : r)),
    };
    if (b.s?.align) para.align = b.s.align;
    if (b.marker !== undefined) para.marker = b.marker;
    if (b.level) para.level = b.level;
    paras.push(para);
  }
  return paras;
}

/** Shapes of a ready SmartArt layout (drawingN.xml). */
export function parseDiagramDrawing(root: XmlNode | undefined, theme: Record<string, string>): { shapes: SlideShape[]; w: number; h: number } | undefined {
  const color = makeColorResolver(theme);
  const find = (n: XmlNode | undefined, name: string): XmlNode | undefined => {
    if (!n) return undefined;
    for (const c of n.children) {
      if (c.name === '#text') continue;
      if (localName(c.name) === name) return c;
      const deep = find(c, name);
      if (deep) return deep;
    }
    return undefined;
  };
  const tree = find(root, 'spTree');
  if (!tree) return undefined;
  const shapes: SlideShape[] = [];
  let w = 0;
  let h = 0;
  for (const sp of childrenOf(tree, 'sp')) {
    const spPr = child(sp, 'spPr');
    const xfrm = child(spPr, 'xfrm');
    const off = child(xfrm, 'off');
    const ext = child(xfrm, 'ext');
    if (!off || !ext) continue;
    const shape: SlideShape = { x: (num(attr(off, 'x')) ?? 0) / EMU, y: (num(attr(off, 'y')) ?? 0) / EMU, w: (num(attr(ext, 'cx')) ?? 0) / EMU, h: (num(attr(ext, 'cy')) ?? 0) / EMU };
    const style = child(sp, 'style');
    shapeLook(spPr, style, color, shape);
    const txBody = child(sp, 'txBody');
    const paras = drawingText(txBody, color, { size: 18, color: color(child(style, 'fontRef')) ?? theme.lt1 });
    if (paras.some((p) => p.runs.some((r) => r.k === 'text' && r.text.trim()))) {
      shape.paras = paras;
      const anchor = attr(child(txBody, 'bodyPr'), 'anchor');
      shape.anchor = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
    }
    if (!shape.paras && !shape.fill && !shape.stroke && !shape.gradient) continue;
    shapes.push(shape);
    w = Math.max(w, shape.x + shape.w);
    h = Math.max(h, shape.y + shape.h);
  }
  return shapes.length ? { shapes, w, h } : undefined;
}

/**
 * Canvas with the shapes of one paragraph: shapes are added with their page coordinates,
 * the canvas fits its size and shifts them to its top-left corner.
 */
export class CanvasGroup {
  readonly block: Extract<Block, { k: 'canvas' }> = { k: 'canvas', w: 0, h: 0, shapes: [] };
  private readonly items: { shape: SlideShape; x: number; y: number }[] = [];
  /** false: the shape would land exactly on an existing one (no coordinates given); it needs a separate canvas. */
  add(shape: SlideShape, x: number, y: number): boolean {
    if (this.items.some((it) => Math.abs(it.x - x) < 2 && Math.abs(it.y - y) < 2)) return false;
    if (this.items.length >= 100) return false;
    this.items.push({ shape, x, y });
    const left = Math.min(...this.items.map((it) => it.x));
    const top = Math.min(...this.items.map((it) => it.y));
    // Shapes placed too far apart would leave a huge empty field on a shared canvas.
    const right = Math.max(...this.items.map((it) => it.x + it.shape.w));
    const bottom = Math.max(...this.items.map((it) => it.y + it.shape.h));
    if (this.items.length > 1 && (right - left > 1400 || bottom - top > 1400)) {
      this.items.pop();
      return false;
    }
    for (const it of this.items) {
      it.shape.x = it.x - left;
      it.shape.y = it.y - top;
    }
    this.block.shapes = this.items.map((it) => it.shape);
    this.block.w = Math.ceil(right - left);
    this.block.h = Math.ceil(bottom - top);
    return true;
  }
}
