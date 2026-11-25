/**
 * Reader of odp (OpenDocument Presentation).
 * Supported: slide size and background, text frames, filled shapes with computed outlines, pictures, groups,
 * inheritance of text formatting from master styles, tables, charts, rotation, gradients and transparency.
 */
import { isPlainRectPath, loadOdfCharts, odfShapePath, odfTransform } from './odf-draw';
import { loadImage } from '../core/images';
import { compactRunStyle, formatCounter, hexColor, mergeStyle, type Inline, type RunStyle } from '../core/docmodel';
import { symbolChar } from '../core/symbols';
import { loadOdfMath } from './mathml';
import type { Slide, SlideCell, SlidePara, SlideShape, SlidesModel } from '../core/slidemodel';
import { child, childrenOf, decodeXmlBytes, parseXml, textContent, type XmlNode } from '../core/xml';
import { ZipReader } from '../core/zip';
import { lengthToPt } from './odt';

interface OdpStyle {
  parent?: string;
  run: RunStyle;
  align?: SlidePara['align'];
  fill?: string;
  stroke?: string;
  anchor?: SlideShape['anchor'];
  pageFill?: string;
  gradient?: SlideShape['gradient'];
  alpha?: number;
  pageGradient?: SlideShape['gradient'];
  pageImage?: string;
  fillKind?: string;
  fillColor?: string;
  family?: string;
  dash?: boolean;
  strokeWidth?: number;
  vertical?: 90 | 270;
  /** Whether the footer, the date and the slide number of the master are shown on a page with this style. */
  show?: { footer?: boolean; date?: boolean; number?: boolean };
}

const px = (value: string | undefined): number => (lengthToPt(value) ?? 0) / 0.75;

function textProps(node: XmlNode | undefined): RunStyle {
  if (!node) return {};
  const a = node.attrs;
  const s: RunStyle = {};
  if (a['fo:font-weight']) s.b = a['fo:font-weight'] === 'bold' ? 1 : 0;
  if (a['fo:font-style']) s.i = a['fo:font-style'] === 'italic' ? 1 : 0;
  if (a['style:text-underline-style']) s.u = a['style:text-underline-style'] === 'none' ? 0 : 1;
  if (a['style:text-line-through-style']) s.s = a['style:text-line-through-style'] === 'none' ? 0 : 1;
  const highlight = hexColor(a['fo:background-color']);
  if (highlight) s.bg = highlight;
  if (a['fo:text-shadow']) s.shadow = a['fo:text-shadow'] === 'none' ? 0 : 1;
  if (a['style:text-outline']) s.outline = a['style:text-outline'] === 'true' ? '#404040' : undefined;
  if (a['fo:font-variant']) s.caps = a['fo:font-variant'] === 'small-caps' ? 'small' : '';
  if (a['fo:text-transform'] === 'uppercase') s.caps = 'all';
  const position = a['style:text-position'];
  if (position) s.va = position.startsWith('super') || /^[1-9]/.test(position) ? 'sup' : position.startsWith('sub') || position.startsWith('-') ? 'sub' : '';
  const font = a['fo:font-family'] ?? a['style:font-name'];
  if (font) {
    s.font = font.replace(/^'|'$/g, '');
    s.mono = /courier|consolas|mono/i.test(font) ? 1 : 0;
  }
  const size = a['fo:font-size'];
  if (size && !size.endsWith('%')) s.size = lengthToPt(size);
  if (a['fo:color']) s.color = hexColor(a['fo:color']) ?? '';
  return s;
}

export async function parseOdp(blob: Blob): Promise<SlidesModel> {
  const zip = await ZipReader.open(blob);
  const readXml = async (path: string) => {
    const entry = zip.get(path);
    return entry ? parseXml(decodeXmlBytes(await zip.read(entry))) : undefined;
  };
  const content = await readXml('content.xml');
  const presentation = child(child(content, 'body'), 'presentation');
  if (!presentation) throw new Error('The file has no presentation (content.xml)');
  const stylesDoc = await readXml('styles.xml');

  // Gradients are described separately and attached to styles by name.
  const gradients = new Map<string, NonNullable<SlideShape['gradient']>>();
  for (const doc of [stylesDoc, content]) {
    for (const g of childrenOf(child(doc, 'styles'), 'gradient')) {
      const from = hexColor(g.attrs['draw:start-color']);
      const to = hexColor(g.attrs['draw:end-color']);
      const raw = g.attrs['draw:angle'] ?? '0';
      const degrees = /deg$/.test(raw) ? parseFloat(raw) : (parseFloat(raw) || 0) / (Math.abs(parseFloat(raw)) > 360 ? 10 : 1);
      // The zero angle in these files is top to bottom.
      if (from && to && g.attrs['draw:name']) gradients.set(g.attrs['draw:name'], { angle: 90 - degrees, stops: [{ at: 0, color: from }, { at: 1, color: to }] });
    }
  }
  const firstGradient = gradients.values().next().value;
  // Bitmap fills refer to pictures by name.
  const fillImages = new Map<string, string>();
  for (const doc of [stylesDoc, content]) {
    for (const f of childrenOf(child(doc, 'styles'), 'fill-image')) {
      const href = f.attrs['xlink:href']?.replace(/^\.\//, '');
      if (href && f.attrs['draw:name'] && !/^[a-z]+:/i.test(href)) fillImages.set(f.attrs['draw:name'], href);
    }
  }
  // List styles: bullet characters and numbering of every level.
  interface ListLevel { bullet?: string; format?: string; prefix: string; suffix: string; start: number; color?: string }
  const listStyles = new Map<string, ListLevel[]>();
  const readListStyle = (node: XmlNode): ListLevel[] => {
    const levels: ListLevel[] = [];
    for (const lv of childrenOf(node)) {
      const index = Number(lv.attrs['text:level'] ?? 1) - 1;
      const tp = child(lv, 'text-properties')?.attrs ?? {};
      const color = hexColor(tp['fo:color']);
      if (lv.name === 'text:list-level-style-bullet') levels[index] = { bullet: symbolChar(tp['fo:font-family']?.replace(/^'|'$/g, '') ?? tp['style:font-name'], lv.attrs['text:bullet-char'] ?? '•', '•').trim() || '•', prefix: '', suffix: '', start: 1, color };
      else if (lv.name === 'text:list-level-style-number') levels[index] = { format: lv.attrs['style:num-format'] ?? '1', prefix: lv.attrs['style:num-prefix'] ?? '', suffix: lv.attrs['style:num-suffix'] ?? '', start: Number(lv.attrs['text:start-value'] ?? 1) || 1, color };
    }
    return levels;
  };
  for (const container of [child(stylesDoc, 'styles'), child(stylesDoc, 'automatic-styles'), child(content, 'automatic-styles')]) {
    for (const ls of childrenOf(container, 'list-style')) if (ls.attrs['style:name']) listStyles.set(ls.attrs['style:name'], readListStyle(ls));
  }
  const styles = new Map<string, OdpStyle>();
  const collect = (container: XmlNode | undefined) => {
    for (const st of childrenOf(container, 'style')) {
      const name = st.attrs['style:name'];
      if (!name) continue;
      const g = child(st, 'graphic-properties')?.attrs ?? {};
      const para = child(st, 'paragraph-properties')?.attrs ?? {};
      const page = child(st, 'drawing-page-properties')?.attrs ?? {};
      const align = para['fo:text-align'];
      const valign = g['draw:textarea-vertical-align'];
      const mode = para['style:writing-mode'] ?? '';
      const flagOf = (name: string) => (page[name] === undefined ? undefined : page[name] === 'true');
      // A list style embedded in a presentation style (the outline levels of a master).
      const embedded = child(child(st, 'graphic-properties'), 'list-style');
      if (embedded) listStyles.set(`\u0000style:${name}`, readListStyle(embedded));
      styles.set(name, {
        parent: st.attrs['style:parent-style-name'],
        run: textProps(child(st, 'text-properties')),
        align: align === 'center' ? 'center' : align === 'end' || align === 'right' ? 'right' : align === 'justify' ? 'justify' : align ? 'left' : undefined,
        // The kind of fill and its colour are inherited separately: a style may change only one of them.
        family: st.attrs['style:family'],
        fillKind: g['draw:fill'],
        fillColor: hexColor(g['draw:fill-color']),
        stroke: g['draw:stroke'] === 'none' ? 'none' : g['draw:stroke'] === 'solid' || g['draw:stroke'] === 'dash' ? hexColor(g['svg:stroke-color']) ?? '#000000' : undefined,
        dash: g['draw:stroke'] === 'dash' ? true : g['draw:stroke'] ? false : undefined,
        strokeWidth: g['svg:stroke-width'] ? Math.max(1, px(g['svg:stroke-width'])) : undefined,
        vertical: mode === 'sideways-lr' || mode === 'bt-lr' ? 270 : mode === 'tb-rl' || mode === 'sideways-rl' || mode === 'tb' ? 90 : undefined,
        pageImage: page['draw:fill'] === 'bitmap' ? fillImages.get(page['draw:fill-image-name'] ?? '') : undefined,
        show: { footer: flagOf('presentation:display-footer'), date: flagOf('presentation:display-date-time'), number: flagOf('presentation:display-page-number') },
        anchor: valign === 'middle' ? 'middle' : valign === 'bottom' ? 'bottom' : valign === 'top' ? 'top' : undefined,
        pageFill: page['draw:fill'] === 'solid' ? hexColor(page['draw:fill-color']) : undefined,
        gradient: g['draw:fill'] === 'gradient' ? gradients.get(g['draw:fill-gradient-name'] ?? '') : undefined,
        alpha: g['draw:opacity'] && g['draw:opacity'] !== '100%' ? Math.max(0, Math.min(1, parseFloat(g['draw:opacity']) / 100)) : undefined,
        // A gradient without a name is the application default: the first one defined is the closest guess.
        pageGradient: page['draw:fill'] === 'gradient' ? gradients.get(page['draw:fill-gradient-name'] ?? '') ?? firstGradient : undefined,
      });
    }
  };
  collect(child(stylesDoc, 'styles'));
  collect(child(stylesDoc, 'automatic-styles'));
  collect(child(content, 'automatic-styles'));

  const cache = new Map<string, OdpStyle>();
  const resolve = (name: string | undefined, depth = 0): OdpStyle | undefined => {
    if (!name) return undefined;
    const hit = cache.get(name);
    if (hit) return hit;
    const st = styles.get(name);
    if (!st) return undefined;
    const base = depth < 20 ? resolve(st.parent, depth + 1) : undefined;
    const merged: OdpStyle = {
      run: mergeStyle(base?.run, st.run),
      align: st.align ?? base?.align,
      family: st.family ?? base?.family,
      fillKind: st.fillKind ?? base?.fillKind,
      fillColor: st.fillColor ?? base?.fillColor,
      stroke: st.stroke ?? base?.stroke,
      anchor: st.anchor ?? base?.anchor,
      pageFill: st.pageFill ?? base?.pageFill,
      gradient: st.gradient ?? (st.fillKind ? undefined : base?.gradient),
      alpha: st.alpha ?? base?.alpha,
      pageGradient: st.pageGradient ?? base?.pageGradient,
      pageImage: st.pageImage ?? base?.pageImage,
      dash: st.dash ?? base?.dash,
      strokeWidth: st.strokeWidth ?? base?.strokeWidth,
      vertical: st.vertical ?? base?.vertical,
      show: { footer: st.show?.footer ?? base?.show?.footer, date: st.show?.date ?? base?.show?.date, number: st.show?.number ?? base?.show?.number },
    };
    merged.fill = merged.fillKind === 'none' ? 'none' : merged.fillKind === 'solid' ? merged.fillColor : undefined;
    cache.set(name, merged);
    return merged;
  };

  // Slide size and slide masters lie in styles.xml.
  let width = 1280;
  let height = 720;
  const masters = new Map<string, XmlNode>();
  for (const m of childrenOf(child(stylesDoc, 'master-styles'), 'master-page')) masters.set(m.attrs['style:name'] ?? '', m);
  // The file has several page layouts (slides, notes, handouts); the one needed is the one
  // the master of the first slide refers to.
  const firstMaster = masters.get(childrenOf(presentation, 'page')[0]?.attrs['draw:master-page-name'] ?? '') ?? masters.values().next().value;
  const wantedLayout = firstMaster?.attrs['style:page-layout-name'];
  for (const layout of childrenOf(child(stylesDoc, 'automatic-styles'), 'page-layout')) {
    if (wantedLayout && layout.attrs['style:name'] !== wantedLayout) continue;
    const props = child(layout, 'page-layout-properties')?.attrs;
    const w = px(props?.['fo:page-width']);
    const h = px(props?.['fo:page-height']);
    if (w > 0 && h > 0) {
      width = Math.round(w);
      height = Math.round(h);
      break;
    }
  }

  const model: SlidesModel = { width, height, slides: [], images: {} };
  const imagePaths = new Set<string>();
  const charts = await loadOdfCharts(zip, content);
  const formulas = await loadOdfMath(zip, content);
  // Texts of the footer and the date are declared once and referred to by name from every page.
  const declared = new Map<string, string>();
  for (const d of childrenOf(presentation)) {
    if (d.name === 'presentation:footer-decl' || d.name === 'presentation:date-time-decl' || d.name === 'presentation:header-decl') {
      const fixed = d.name !== 'presentation:date-time-decl' || d.attrs['presentation:source'] !== 'current-date';
      declared.set(`${d.name}:${d.attrs['presentation:name'] ?? ''}`, fixed ? textContent(d) : new Date().toLocaleDateString());
    }
  }
  let pageNumber = 0;
  let pageFields: { footer?: string; date?: string } = {};

  interface ListState { levels: ListLevel[]; counters: number[] }
  let boxLists: { owner: XmlNode | undefined; states: Map<string, ListState> } = { owner: undefined, states: new Map() };
  const parseParagraphs = (box: XmlNode, base: RunStyle, baseAlign: SlidePara['align'], master: string, isOutline: boolean, out: SlidePara[], depth = -1, list?: ListState, numbered = true): void => {
    for (const c of childrenOf(box)) {
      if (c.name === 'text:p' || c.name === 'text:h') {
        const pst = resolve(c.attrs['text:style-name']);
        // Outline levels of a slide inherit formatting from the master styles "<master>-outlineN".
        const outline = isOutline && depth >= 0 ? resolve(`${master.replace(/ /g, '_20_')}-outline${depth + 1}`)?.run : undefined;
        const rs = mergeStyle(mergeStyle(base, outline), pst?.run);
        const runs: Inline[] = [];
        const push = (text: string, style: RunStyle, href?: string) => {
          if (!text) return;
          if (href && /^(https?:|mailto:)/i.test(href)) runs.push({ k: 'text', text, s: compactRunStyle({ ...style, u: 1, color: style.color && style.color !== base.color ? style.color : '#0563c1' }), href });
          else runs.push({ k: 'text', text, s: compactRunStyle(style) });
        };
        const walk = (node: XmlNode, style: RunStyle, href?: string) => {
          for (const x of node.children) {
            if (x.name === '#text') push(x.text.replace(/[ \t\r\n]+/g, ' '), style, href);
            else if (x.name === 'text:span') walk(x, mergeStyle(style, resolve(x.attrs['text:style-name'])?.run), href);
            else if (x.name === 'text:a') walk(x, style, x.attrs['xlink:href']);
            else if (x.name === 'text:s') push(' '.repeat(Math.min(Number(x.attrs['text:c'] ?? 1) || 1, 200)), style, href);
            else if (x.name === 'text:line-break') runs.push({ k: 'br' });
            else if (x.name === 'text:tab') runs.push({ k: 'tab' });
            else if (x.name === 'text:page-number') push(String(pageNumber), style, href);
            else if (x.name === 'presentation:footer') push(pageFields.footer ?? '', style, href);
            else if (x.name === 'presentation:date-time') push(pageFields.date ?? '', style, href);
            else if (x.name === 'text:date' || x.name === 'text:time') push(textContent(x) || new Date().toLocaleDateString(), style, href);
            else walk(x, style, href);
          }
        };
        walk(c, rs);
        const para: SlidePara = { runs };
        const align = pst?.align ?? baseAlign;
        if (align && align !== 'left') para.align = align;
        if (depth >= 0 && runs.length) {
          const level = list?.levels[depth];
          if (level && numbered) {
            if (level.format !== undefined) {
              list!.counters[depth] = (list!.counters[depth] ?? level.start - 1) + 1;
              list!.counters.length = depth + 1;
              para.marker = level.format ? `${level.prefix}${formatCounter(list!.counters[depth], level.format)}${level.suffix}` : '';
            } else para.marker = level.bullet ?? '•';
            if (level.color) para.markerColor = level.color;
          } else if (numbered) para.marker = '•';
          if (depth > 0) para.level = depth;
        }
        if (!runs.length) runs.push({ k: 'text', text: '​', s: compactRunStyle(rs) });
        out.push(para);
      } else if (c.name === 'text:list') {
        // A nested list continues the style of its parent unless it names its own.
        const own = c.attrs['text:style-name'] ? listStyles.get(c.attrs['text:style-name']) : undefined;
        const outlineLevels = isOutline ? listStyles.get(`\u0000style:${master.replace(/ /g, '_20_')}-outline1`) : undefined;
        // Every paragraph of a slide is usually a list of its own: lists of one style within a box share the counters.
        const key = c.attrs['text:style-name'] ?? '';
        if (depth < 0 && boxLists.owner !== box) boxLists = { owner: box, states: new Map() };
        let state: ListState | undefined = list;
        if (own) {
          state = depth < 0 ? boxLists.states.get(key) : undefined;
          if (!state) {
            state = { levels: own, counters: [] };
            if (depth < 0) boxLists.states.set(key, state);
          }
        } else if (!state && outlineLevels) state = { levels: outlineLevels, counters: [] };
        for (const item of childrenOf(c)) parseParagraphs(item, base, baseAlign, master, isOutline, out, depth + 1, state, item.name !== 'text:list-header');
      }
    }
  };

  const parseShapes = (parent: XmlNode, master: string, out: SlideShape[], decorOnly: boolean): void => {
    for (const node of childrenOf(parent)) {
      if (node.name === 'draw:g') {
        parseShapes(node, master, out, decorOnly);
        continue;
      }
      if (!node.name.startsWith('draw:') || node.name === 'draw:page-thumbnail') continue;
      const a = node.attrs;
      // Only formatting is taken from the master, not the text placeholders.
      const isField = a['presentation:class'] === 'footer' || a['presentation:class'] === 'date-time' || a['presentation:class'] === 'page-number';
      if (decorOnly && !isField && (a['presentation:class'] || a['presentation:placeholder'] === 'true')) continue;
      if (a['presentation:placeholder'] === 'true') continue;
      const st = resolve(a['presentation:style-name'] ?? a['draw:style-name']);
      let shape: SlideShape;
      if (node.name === 'draw:line' || node.name === 'draw:connector') {
        const x1 = px(a['svg:x1']);
        const y1 = px(a['svg:y1']);
        const x2 = px(a['svg:x2']);
        const y2 = px(a['svg:y2']);
        // The transform of a line applies to its end points.
        const [ax, ay] = transformPoint(a['draw:transform'], x1, y1);
        const [bx, by] = transformPoint(a['draw:transform'], x2, y2);
        shape = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay), shape: 'line', stroke: st?.stroke && st.stroke !== 'none' ? st.stroke : '#000000' };
        if ((bx - ax) * (by - ay) < 0) shape.flipV = true;
        if (st?.dash) shape.dash = true;
        if (st?.strokeWidth) shape.strokeWidth = st.strokeWidth;
        // A "standard" connector is routed with right angles; the file keeps only its ends.
        if (node.name === 'draw:connector' && (a['draw:type'] ?? 'standard') === 'standard' && shape.w > 4 && shape.h > 4) shape.connector = { kind: 'bent', elbows: 3, adj: [0.5] };
        out.push(shape);
        continue;
      }
      shape = { x: px(a['svg:x']), y: px(a['svg:y']), w: px(a['svg:width']), h: px(a['svg:height']) };
      if (shape.w <= 0 && shape.h <= 0) continue;
      // Footer, date and slide number of the master appear on a page only when its style says so.
      const field = a['presentation:class'];
      if (decorOnly && (field === 'footer' || field === 'date-time' || field === 'page-number')) {
        const visible = field === 'footer' ? pageShow.footer && pageFields.footer : field === 'date-time' ? pageShow.date && pageFields.date : pageShow.number;
        if (!visible) continue;
        const paras: SlidePara[] = [];
        const box = child(node, 'text-box');
        if (box) parseParagraphs(box, mergeStyle({ size: 14 }, st?.run), st?.align, master, false, paras);
        if (!paras.some((p) => p.runs.some((r) => r.k === 'text' && r.text.trim() && r.text !== '​'))) {
          const text = field === 'footer' ? pageFields.footer : field === 'date-time' ? pageFields.date : String(pageNumber);
          paras.length = 0;
          paras.push({ runs: [{ k: 'text', text: text ?? '', s: compactRunStyle(mergeStyle({ size: 14 }, st?.run)) }], align: st?.align ?? (field === 'page-number' ? 'right' : field === 'footer' ? 'center' : undefined) });
        }
        shape.paras = paras;
        shape.anchor = st?.anchor ?? 'middle';
        out.push(shape);
        continue;
      }
      const placed = odfTransform(a['draw:transform'], shape.w, shape.h, px, shape.x, shape.y);
      if (placed) {
        shape.x = placed.x;
        shape.y = placed.y;
        if (Math.abs(placed.rot) > 0.01) shape.rot = placed.rot;
      }
      const cls = a['presentation:class'];
      const isFrame = node.name === 'draw:frame';
      const tableNode = isFrame ? child(node, 'table') : undefined;
      if (tableNode) {
        // Table: rows and cells with text; columns share the frame width equally.
        const rows: SlideCell[][] = [];
        let columns = 0;
        // Header rows may be wrapped in their own element.
        const tableRows = childrenOf(tableNode).flatMap((r) => (r.name === 'table:table-row' ? [r] : r.name === 'table:table-header-rows' ? childrenOf(r, 'table-row') : []));
        for (const tr of tableRows) {
          const cells: SlideCell[] = [];
          for (const tc of childrenOf(tr)) {
            if (tc.name === 'table:covered-table-cell') {
              cells.push({ paras: [], skip: true });
              continue;
            }
            if (tc.name !== 'table:table-cell') continue;
            const cell: SlideCell = { paras: [] };
            const cs = Number(tc.attrs['table:number-columns-spanned'] ?? 1) || 1;
            const rsp = Number(tc.attrs['table:number-rows-spanned'] ?? 1) || 1;
            if (cs > 1) cell.colSpan = cs;
            if (rsp > 1) cell.rowSpan = rsp;
            // A cell without its own style takes the default cell style of its row.
            const cellStyle = resolve(tc.attrs['table:style-name'] ?? tr.attrs['table:default-cell-style-name']);
            // The default cell style of a row may be the drawing default, whose fill is meant for shapes.
            const cellFill = cellStyle?.family === 'table-cell' ? cellStyle.fill : undefined;
            if (cellFill && cellFill !== 'none') cell.bg = cellFill;
            parseParagraphs(tc, mergeStyle({ size: 18 }, cellStyle?.run), undefined, master, false, cell.paras);
            cells.push(cell);
          }
          columns = Math.max(columns, cells.length);
          rows.push(cells);
        }
        if (rows.length && columns) {
          shape.table = { rows, widths: new Array<number>(columns).fill(shape.w / columns) };
          out.push(shape);
          continue;
        }
      }
      const object = isFrame ? child(node, 'object') : undefined;
      const formula = object ? formulas.get(object.attrs['xlink:href'] ?? '') : undefined;
      if (formula) {
        // A LibreOffice Math object: the formula is typeset from its MathML.
        // The formula frame is about two and a half lines tall for a fraction.
        shape.paras = [{ runs: [{ k: 'math', node: formula, size: Math.max(8, Math.min(40, (shape.h * 0.75) / 2.6)) }], align: 'center' }];
        shape.anchor = 'middle';
        out.push(shape);
        continue;
      }
      const chart = object ? charts.get(object.attrs['xlink:href'] ?? '') : undefined;
      if (chart) {
        shape.chart = chart;
        out.push(shape);
        continue;
      }
      // An object that was not parsed: it usually has a replacement picture.
      const image = isFrame ? child(node, 'image') : undefined;
      if (isFrame && !image && (object || child(node, 'plugin'))) {
        shape.placeholder = object ? 'chart' : 'object';
        out.push(shape);
        continue;
      }
      const path = image?.attrs['xlink:href']?.replace(/^\.\//, '');
      if (path && !/^[a-z]+:/i.test(path)) {
        imagePaths.add(path);
        shape.img = path;
        out.push(shape);
        continue;
      }
      if (!isFrame) {
        const geometryNode = child(node, 'enhanced-geometry');
        const geometry = geometryNode?.attrs['draw:type'];
        if (geometryNode?.attrs['draw:text-path'] === 'true') {
          // Fontwork: text drawn as a shape. It is shown as large text in the colour of the shape's fill.
          const text = childrenOf(node, 'p').map((p) => textContent(p)).join(' ').trim();
          if (text) {
            const color = st?.gradient ? st.gradient.stops[st.gradient.stops.length - 1].color : st?.fill && st.fill !== 'none' ? st.fill : '#1f4e79';
            const size = Math.max(12, Math.min((shape.h * 0.75) / 1.25, ((shape.w / Math.max(4, text.length)) * 0.75) / 0.52));
            shape.paras = [{ runs: [{ k: 'text', text, s: { size: Math.round(size), b: 1, color, outline: st?.stroke && st.stroke !== 'none' ? st.stroke : undefined } }], align: 'center' }];
            shape.anchor = 'middle';
            out.push(shape);
          }
          continue;
        }
        if (node.name === 'draw:ellipse' || node.name === 'draw:circle' || (geometry && /ellipse|circle/i.test(geometry))) shape.shape = 'ellipse';
        else if (geometry && /^(ooxml-)?round-?rect/i.test(geometry)) shape.shape = 'round';
        else if (geometryNode && !/^(ooxml-)?rect(angle)?$/i.test(geometry ?? '')) {
          // The outline is given by drawing commands with formulas: evaluate it.
          const path = odfShapePath(geometryNode);
          if (path && !isPlainRectPath(path)) shape.path = path;
          if (geometryNode.attrs['draw:mirror-horizontal'] === 'true') shape.flipH = true;
          if (geometryNode.attrs['draw:mirror-vertical'] === 'true') shape.flipV = true;
        }
        if (st?.gradient) {
          shape.gradient = st.gradient;
          shape.fill = st.gradient.stops[0].color;
        } else if (st?.fill && st.fill !== 'none') shape.fill = st.fill;
        else if (st?.fill === undefined) shape.fill = '#729fcf'; // default LibreOffice shape colour
        if (st?.alpha !== undefined && shape.fill) shape.alpha = st.alpha;
        if (st?.stroke && st.stroke !== 'none') shape.stroke = st.stroke;
        if (st?.dash && shape.stroke) shape.dash = true;
        if (st?.strokeWidth && shape.stroke) shape.strokeWidth = st.strokeWidth;
      } else if (st?.fill && st.fill !== 'none') {
        shape.fill = st.fill;
      }
      const box = isFrame ? child(node, 'text-box') : node;
      if (box) {
        const paras: SlidePara[] = [];
        const defaults: RunStyle = { size: cls === 'title' ? 44 : cls === 'outline' || cls === 'subtitle' ? 28 : 18 };
        parseParagraphs(box, mergeStyle(defaults, st?.run), st?.align ?? (isFrame ? undefined : 'center'), master, cls === 'outline', paras);
        if (paras.some((p) => p.runs.some((r) => r.k === 'text' && r.text.trim() && r.text !== '​'))) {
          shape.paras = paras;
          shape.anchor = st?.anchor ?? (cls === 'title' || !isFrame ? 'middle' : 'top');
          const vertical = st?.vertical ?? resolve(childrenOf(box, 'p')[0]?.attrs['text:style-name'])?.vertical;
          if (vertical) shape.textRot = vertical;
        }
      }
      if (!shape.paras && !shape.fill && !shape.stroke) continue;
      out.push(shape);
    }
  };

  let pageShow: { footer: boolean; date: boolean; number: boolean } = { footer: false, date: false, number: false };
  /** Applies a draw:transform (translations and rotations, in the order written) to a point. */
  const transformPoint = (transform: string | undefined, x: number, y: number): [number, number] => {
    if (!transform) return [x, y];
    for (const m of transform.matchAll(/(translate|rotate)\s*\(([^)]*)\)/g)) {
      const args = m[2].trim().split(/[\s,]+/);
      if (m[1] === 'translate') {
        x += px(args[0]);
        y += px(args[1] ?? '0');
      } else {
        // The angle is in radians, counter-clockwise on the page.
        const angle = -(parseFloat(args[0]) || 0);
        [x, y] = [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
      }
    }
    return [x, y];
  };
  const hiddenPages = new Set<string>();
  for (const container of [child(content, 'automatic-styles'), child(stylesDoc, 'automatic-styles'), child(stylesDoc, 'styles')]) {
    for (const st of childrenOf(container, 'style')) {
      if (child(st, 'drawing-page-properties')?.attrs['presentation:visibility'] === 'hidden' && st.attrs['style:name']) hiddenPages.add(st.attrs['style:name']);
    }
  }

  for (const page of childrenOf(presentation, 'page')) {
    // A hidden slide is not seen in the show; it is not shown here either.
    if (hiddenPages.has(page.attrs['draw:style-name'] ?? '')) continue;
    const masterName = page.attrs['draw:master-page-name'] ?? '';
    const master = masters.get(masterName);
    const slide: Slide = { shapes: [] };
    pageNumber++;
    const pageStyle = resolve(page.attrs['draw:style-name']);
    const masterStyle = resolve(master?.attrs['draw:style-name']);
    pageShow = { footer: pageStyle?.show?.footer ?? false, date: pageStyle?.show?.date ?? false, number: pageStyle?.show?.number ?? false };
    pageFields = {
      footer: declared.get(`presentation:footer-decl:${page.attrs['presentation:use-footer-name'] ?? ''}`),
      date: declared.get(`presentation:date-time-decl:${page.attrs['presentation:use-date-time-name'] ?? ''}`),
    };
    const pageImage = pageStyle?.pageImage ?? masterStyle?.pageImage;
    if (pageImage) {
      imagePaths.add(pageImage);
      slide.bgImg = pageImage;
    }
    const bg = resolve(page.attrs['draw:style-name'])?.pageFill ?? resolve(master?.attrs['draw:style-name'])?.pageFill;
    const pageGradient = resolve(page.attrs['draw:style-name'])?.pageGradient ?? (bg ? undefined : resolve(master?.attrs['draw:style-name'])?.pageGradient);
    if (pageGradient) slide.bgGradient = pageGradient;
    if (bg) slide.bg = bg;
    if (master) parseShapes(master, masterName, slide.shapes, true);
    parseShapes(page, masterName, slide.shapes, false);
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
