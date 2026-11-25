/**
 * Reader of odt (OpenDocument Text).
 * Supported, as for docx: paragraphs, headings, style inheritance, lists, tables,
 * pictures, links, footnotes, headers/footers, shapes and charts. Frames with text wrapping are not supported.
 */
import { isLoadableImage } from '../core/images';
import type { SlidePara, SlideShape } from '../core/slidemodel';
import { isPlainRectPath, loadOdfCharts, odfShapePath, odfTransform } from './odf-draw';
import { loadImage } from '../core/images';
import { loadOdfMath } from './mathml';
import {
  appendPart, compactRunStyle, formatCounter, hasVisibleContent, hexColor, mergeStyle, prefixNote,
  type Block, type DocPartLabels, type DocModel, type Inline, type ParaStyle, type RunStyle, type TableCell, type TableRow,
} from '../core/docmodel';
import { child, childrenOf, decodeXmlBytes, parseXml, textContent, type XmlNode } from '../core/xml';
import type { DocOptions } from './documents';
import { ZipReader } from '../core/zip';

/** A length like "2.5cm" → points. */
export function lengthToPt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(-?[\d.]+)(cm|mm|in|pt|px|pc)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const factor = m[2] === 'cm' ? 28.3465 : m[2] === 'mm' ? 2.83465 : m[2] === 'in' ? 72 : m[2] === 'px' ? 0.75 : m[2] === 'pc' ? 12 : 1;
  return Math.round(n * factor * 100) / 100;
}

interface OdfStyle {
  parent?: string;
  run: RunStyle;
  para: ParaStyle;
  breakBefore?: boolean;
  cellBg?: string;
  cellVert?: 'tb' | 'bt';
  cellVa?: 'middle' | 'bottom';
  colWidth?: number;
  listStyle?: string;
}

interface ListLevel {
  bullet?: string;
  format?: string;
  prefix: string;
  suffix: string;
  start: number;
}

function parseTextProps(n: XmlNode | undefined): RunStyle {
  if (!n) return {};
  const a = n.attrs;
  const s: RunStyle = {};
  if (a['fo:font-weight']) s.b = a['fo:font-weight'] === 'bold' || Number(a['fo:font-weight']) >= 600 ? 1 : 0;
  if (a['fo:font-style']) s.i = a['fo:font-style'] === 'italic' || a['fo:font-style'] === 'oblique' ? 1 : 0;
  const underline = a['style:text-underline-style'];
  if (underline) {
    s.u = underline === 'none' ? 0 : 1;
    if (a['style:text-underline-type'] === 'double') s.ul = 'double';
    else if (underline === 'wave') s.ul = 'wavy';
    else if (underline === 'dotted') s.ul = 'dotted';
    else if (/dash/.test(underline)) s.ul = 'dashed';
  }
  if (a['style:text-line-through-style']) {
    s.s = a['style:text-line-through-style'] === 'none' ? 0 : 1;
    if (s.s && a['style:text-line-through-type'] === 'double') s.ds = 1;
  }
  if (a['style:text-overline-style']) s.over = a['style:text-overline-style'] === 'none' ? 0 : 1;
  if (a['fo:font-variant']) s.caps = a['fo:font-variant'] === 'small-caps' ? 'small' : '';
  if (a['fo:text-transform']) s.caps = a['fo:text-transform'] === 'uppercase' ? 'all' : s.caps ?? '';
  if (a['fo:text-shadow']) s.shadow = a['fo:text-shadow'] === 'none' ? 0 : 1;
  if (a['style:font-relief'] && a['style:font-relief'] !== 'none') s.shadow = 1;
  if (a['style:text-outline']) s.outline = a['style:text-outline'] === 'true' ? '#404040' : undefined;
  const spacing = a['fo:letter-spacing'];
  if (spacing && spacing !== 'normal') s.ls = lengthToPt(spacing);
  const scale = a['style:text-scale'];
  if (scale && scale.endsWith('%')) s.scale = Number(scale.slice(0, -1)) / 100 || undefined;
  if (a['text:display']) s.hide = a['text:display'] === 'none' ? 1 : 0;
  const size = a['fo:font-size'];
  if (size && !size.endsWith('%')) s.size = lengthToPt(size);
  if (a['fo:color']) s.color = hexColor(a['fo:color']) ?? '';
  const bg = hexColor(a['fo:background-color']);
  if (bg) s.bg = bg;
  const pos = a['style:text-position'];
  if (pos) s.va = pos.startsWith('super') || /^[1-9]/.test(pos) ? 'sup' : pos.startsWith('sub') || pos.startsWith('-') ? 'sub' : '';
  const font = a['style:font-name'] ?? a['fo:font-family'];
  if (font) {
    s.mono = /courier|consolas|mono/i.test(font) ? 1 : 0;
    s.font = font.replace(/^'|'$/g, '').replace(/\d+$/, '');
  }
  return s;
}

function parseParaProps(n: XmlNode | undefined): { para: ParaStyle; breakBefore?: boolean } {
  if (!n) return { para: {} };
  const a = n.attrs;
  const p: ParaStyle = {};
  const align = a['fo:text-align'];
  if (align) p.align = align === 'center' ? 'center' : align === 'end' || align === 'right' ? 'right' : align === 'justify' ? 'justify' : 'left';
  const set = (key: 'ml' | 'mr' | 'mt' | 'mb' | 'ti', attrName: string) => {
    const v = lengthToPt(a[attrName]);
    if (v !== undefined) p[key] = v;
  };
  set('ml', 'fo:margin-left');
  set('mr', 'fo:margin-right');
  set('mt', 'fo:margin-top');
  set('mb', 'fo:margin-bottom');
  set('ti', 'fo:text-indent');
  const lh = a['fo:line-height'];
  if (lh && lh.endsWith('%')) p.lh = Math.max(0.8, Math.min(Number(lh.slice(0, -1)) / 100, 3));
  const bg = hexColor(a['fo:background-color']);
  if (bg) p.bg = bg;
  const border = a['fo:border'] ?? a['fo:border-top'];
  if (border && border !== 'none') p.border = hexColor(/#[0-9a-f]{6}/i.exec(border)?.[0]) ?? '#404040';
  const drop = child(n, 'drop-cap');
  if (drop) p.dropCap = { lines: Math.max(2, Number(drop.attrs['style:lines'] ?? 2) || 2), chars: drop.attrs['style:length'] === 'word' ? 0 : Math.max(1, Number(drop.attrs['style:length'] ?? 1) || 1) };
  const stops = childrenOf(child(n, 'tab-stops'), 'tab-stop');
  if (stops.length) {
    p.tabs = stops.map((t) => {
      const type = t.attrs['style:type'];
      const leader = t.attrs['style:leader-text'] ?? (t.attrs['style:leader-style'] && t.attrs['style:leader-style'] !== 'none' ? '.' : undefined);
      return { pos: (lengthToPt(t.attrs['style:position']) ?? 0) + (p.ml ?? 0), align: type === 'right' ? 'right' : type === 'center' ? 'center' : type === 'char' ? 'decimal' : undefined, leader: leader ? leader.slice(0, 1) : undefined };
    });
  }
  return { para: p, breakBefore: a['fo:break-before'] === 'page' };
}

export async function parseOdt(blob: Blob, options: DocOptions = {}): Promise<DocModel> {
  const labels: DocPartLabels = options.labels ?? {};
  const zip = await ZipReader.open(blob);
  const readXml = async (path: string) => {
    const entry = zip.get(path);
    return entry ? parseXml(decodeXmlBytes(await zip.read(entry))) : undefined;
  };
  const content = await readXml('content.xml');
  const text = child(child(content, 'body'), 'text');
  if (!text) throw new Error('The file has no document body (content.xml)');
  const stylesDoc = await readXml('styles.xml');

  // --- styles ---
  const styles = new Map<string, OdfStyle>();
  const listStyles = new Map<string, ListLevel[]>();
  const collect = (container: XmlNode | undefined) => {
    for (const st of childrenOf(container)) {
      const name = st.attrs['style:name'];
      if (st.name === 'style:style' || st.name === 'style:default-style') {
        const pp = parseParaProps(child(st, 'paragraph-properties'));
        const key = st.name === 'style:default-style' ? `\u0000default:${st.attrs['style:family']}` : name;
        if (!key) continue;
        styles.set(key, {
          parent: st.attrs['style:parent-style-name'],
          run: parseTextProps(child(st, 'text-properties')),
          para: pp.para,
          breakBefore: pp.breakBefore,
          cellBg: hexColor(child(st, 'table-cell-properties')?.attrs['fo:background-color']),
          cellVert: (() => {
            const cp = child(st, 'table-cell-properties')?.attrs ?? {};
            const mode = cp['style:writing-mode'] ?? '';
            const angle = Number(cp['style:rotation-angle'] ?? 0);
            return mode.startsWith('tb') || angle === 270 ? ('tb' as const) : angle === 90 || mode === 'bt-lr' ? ('bt' as const) : undefined;
          })(),
          cellVa: (() => {
            const v = child(st, 'table-cell-properties')?.attrs['style:vertical-align'];
            return v === 'middle' ? ('middle' as const) : v === 'bottom' ? ('bottom' as const) : undefined;
          })(),
          colWidth: lengthToPt(child(st, 'table-column-properties')?.attrs['style:column-width']),
          listStyle: st.attrs['style:list-style-name'],
        });
      } else if (st.name === 'text:list-style' && name) {
        const levels: ListLevel[] = [];
        for (const lv of childrenOf(st)) {
          const index = Number(lv.attrs['text:level'] ?? 1) - 1;
          if (lv.name === 'text:list-level-style-bullet') {
            levels[index] = { bullet: lv.attrs['text:bullet-char'] ?? '•', prefix: '', suffix: '', start: 1 };
          } else if (lv.name === 'text:list-level-style-number') {
            levels[index] = {
              format: lv.attrs['style:num-format'] ?? '1',
              prefix: lv.attrs['style:num-prefix'] ?? '',
              suffix: lv.attrs['style:num-suffix'] ?? '',
              start: Number(lv.attrs['text:start-value'] ?? 1) || 1,
            };
          }
        }
        listStyles.set(name, levels);
      }
    }
  };
  collect(child(stylesDoc, 'styles'));
  collect(child(stylesDoc, 'automatic-styles'));
  collect(child(content, 'automatic-styles'));

  const cache = new Map<string, OdfStyle>();
  const resolve = (name: string | undefined, depth = 0): OdfStyle | undefined => {
    if (!name) return undefined;
    const hit = cache.get(name);
    if (hit) return hit;
    const st = styles.get(name);
    if (!st) return undefined;
    const base = depth < 20 ? resolve(st.parent, depth + 1) : undefined;
    const merged: OdfStyle = {
      run: mergeStyle(base?.run, st.run),
      para: mergeStyle(base?.para, st.para),
      breakBefore: st.breakBefore,
      cellBg: st.cellBg ?? base?.cellBg,
      colWidth: st.colWidth,
      listStyle: st.listStyle ?? base?.listStyle,
    };
    cache.set(name, merged);
    return merged;
  };
  const defaultRun = styles.get('\u0000default:paragraph')?.run ?? {};

  const imagePaths = new Set<string>();
  // --- graphics: shape looks, charts, shapes of the current paragraph ---
  const graphic = new Map<string, { fill?: string; stroke?: string; parent?: string }>();
  for (const container of [child(stylesDoc, 'styles'), child(stylesDoc, 'automatic-styles'), child(content, 'automatic-styles')]) {
    for (const st of childrenOf(container)) {
      if ((st.name !== 'style:style' && st.name !== 'style:default-style') || st.attrs['style:family'] !== 'graphic') continue;
      const g = child(st, 'graphic-properties')?.attrs ?? {};
      const look: { fill?: string; stroke?: string; parent?: string } = { parent: st.attrs['style:parent-style-name'] ?? '\u0000default' };
      if (g['draw:fill'] === 'none') look.fill = 'none';
      else if (g['draw:fill-color']) look.fill = hexColor(g['draw:fill-color']) ?? undefined;
      if (g['draw:stroke'] === 'none') look.stroke = 'none';
      else if (g['svg:stroke-color']) look.stroke = hexColor(g['svg:stroke-color']) ?? undefined;
      graphic.set(st.name === 'style:default-style' ? '\u0000default' : st.attrs['style:name'] ?? '', look);
    }
  }
  const lookOf = (name: string | undefined): { fill?: string; stroke?: string } => {
    const out: { fill?: string; stroke?: string } = {};
    for (let cur = graphic.get(name ?? ''), guard = 0; cur && guard < 20; cur = cur.parent && cur.parent !== name ? graphic.get(cur.parent) : undefined, guard++) {
      out.fill ??= cur.fill;
      out.stroke ??= cur.stroke;
      if (cur === graphic.get('\u0000default')) break;
    }
    return out;
  };
  const charts = await loadOdfCharts(zip, content);
  const formulas = await loadOdfMath(zip, content);
  /** Frame looks (text boxes): background, border and the side the text flows around. */
  const frameLooks = new Map<string, { bg?: string; border?: string; wrap?: string; pos?: string; parent?: string }>();
  for (const container of [child(stylesDoc, 'styles'), child(stylesDoc, 'automatic-styles'), child(content, 'automatic-styles')]) {
    for (const st of childrenOf(container)) {
      if (st.name !== 'style:style' || st.attrs['style:family'] !== 'graphic') continue;
      const g = child(st, 'graphic-properties')?.attrs ?? {};
      const border = g['fo:border'] && g['fo:border'] !== 'none' ? g['fo:border'] : undefined;
      frameLooks.set(st.attrs['style:name'] ?? '', {
        bg: hexColor(g['fo:background-color']) ?? (g['draw:fill'] === 'solid' ? hexColor(g['draw:fill-color']) : undefined),
        border: border ? `1px solid ${/#[0-9a-f]{6}/i.exec(border)?.[0] ?? '#404040'}` : undefined,
        wrap: g['style:wrap'],
        pos: g['style:horizontal-pos'],
        parent: st.attrs['style:parent-style-name'],
      });
    }
  }
  const frameLook = (name: string | undefined) => {
    const out: { bg?: string; border?: string; wrap?: string; pos?: string; float?: 'left' | 'right' } = {};
    for (let cur = frameLooks.get(name ?? ''), guard = 0; cur && guard < 20; cur = frameLooks.get(cur.parent ?? ''), guard++) {
      out.bg ??= cur.bg;
      out.border ??= cur.border;
      out.wrap ??= cur.wrap;
      out.pos ??= cur.pos;
    }
    // Text flows around a frame placed at a side, unless wrapping is switched off.
    if (out.wrap !== 'none' && out.wrap !== 'run-through') out.float = out.pos === 'right' || out.pos === 'outside' ? 'right' : out.pos === 'left' || out.pos === 'inside' ? 'left' : undefined;
    return out;
  };
  // Chapter numbering: heading levels are numbered by the outline style, not by a list.
  const outline: ListLevel[] = [];
  const displayLevels: number[] = [];
  for (const lv of childrenOf(child(child(stylesDoc, 'styles'), 'outline-style'))) {
    const index = Number(lv.attrs['text:level'] ?? 1) - 1;
    const format = lv.attrs['style:num-format'];
    if (!format) continue;
    outline[index] = { format, prefix: lv.attrs['style:num-prefix'] ?? '', suffix: lv.attrs['style:num-suffix'] ?? '', start: Number(lv.attrs['text:start-value'] ?? 1) || 1 };
    displayLevels[index] = Number(lv.attrs['text:display-levels'] ?? 1) || 1;
  }
  const outlineCounters: number[] = [];
  const outlineNumber = (level: number): string | undefined => {
    const def = outline[level];
    for (let i = 0; i <= level; i++) outlineCounters[i] ??= (outline[i]?.start ?? 1) - 1;
    outlineCounters[level]++;
    outlineCounters.length = level + 1;
    if (!def) return undefined;
    const parts: string[] = [];
    for (let i = Math.max(0, level - displayLevels[level] + 1); i <= level; i++) if (outline[i]) parts.push(formatCounter(outlineCounters[i], outline[i].format ?? '1'));
    return `${def.prefix}${parts.join('.')}${def.suffix}`.trim();
  };
  let pendingShapes: SlideShape[] = [];
  let watermark: string | undefined;
  let pendingBlocks: Block[] = [];
  const toPx = (value: string | undefined): number => (lengthToPt(value) ?? 0) / 0.75;
  const BULLETS = ['•', '◦', '▪'];
  // Footnotes and comments are collected along the text and output at the end of the document.
  const notes = { footnote: [] as Block[], endnote: [] as Block[], comment: [] as Block[] };
  let commentCounter = 0;

  const parseInlines = (node: XmlNode, rs: RunStyle, out: Inline[], href?: string): void => {
    const push = (t: string) => {
      if (!t || rs.hide) return;
      const { hide: _hide, ...visible } = rs;
      const s = compactRunStyle(visible);
      const last = out[out.length - 1];
      if (last && last.k === 'text' && last.href === href && JSON.stringify(last.s) === JSON.stringify(s)) last.text += t;
      else out.push(href ? { k: 'text', text: t, s, href } : { k: 'text', text: t, s });
    };
    for (const c of node.children) {
      if (c.name === '#text') {
        // By ODF rules whitespace in text equals one space; repeats are given by <text:s>.
        push(c.text.replace(/[ \t\r\n]+/g, ' '));
        continue;
      }
      switch (c.name) {
        case 'text:span':
          parseInlines(c, mergeStyle(rs, resolve(c.attrs['text:style-name'])?.run), out, href);
          break;
        case 'text:a':
          parseInlines(c, rs, out, c.attrs['xlink:href'] ?? href);
          break;
        case 'text:s':
          push(' '.repeat(Math.min(Number(c.attrs['text:c'] ?? 1) || 1, 500)));
          break;
        case 'text:tab':
          out.push({ k: 'tab' });
          break;
        case 'text:line-break':
          out.push({ k: 'br' });
          break;
        case 'text:note': {
          const citation = child(c, 'note-citation');
          const kind = c.attrs['text:note-class'] === 'endnote' ? 'endnote' : 'footnote';
          // Endnote marks are told apart from regular ones by Roman numerals, as in Word.
          const raw = textContent(citation).trim();
          const mark = kind === 'endnote' && /^\d+$/.test(raw) ? formatCounter(Number(raw), 'lowerRoman') : raw;
          if (mark) out.push({ k: 'text', text: mark, s: { va: 'sup' } });
          const body: Block[] = [];
          const bodyNode = child(c, 'note-body');
          if (bodyNode) parseBlocks(bodyNode, body);
          if (hasVisibleContent(body)) notes[kind].push(...prefixNote(body, mark));
          break;
        }
        case 'office:annotation': {
          const body: Block[] = [];
          parseBlocks(c, body);
          if (hasVisibleContent(body)) {
            const mark = `[${++commentCounter}]`;
            const author = textContent(child(c, 'creator')).trim();
            out.push({ k: 'text', text: mark, s: { va: 'sup' } });
            notes.comment.push(...prefixNote(body, `${mark}${author ? ` ${author}:` : ''}`));
          }
          break;
        }
        // Hidden text and hidden paragraphs (fields) are not visible in Office.
        case 'text:hidden-text':
          // A conditional text whose condition does not hold is shown.
          if (c.attrs['text:is-hidden'] === 'false' && c.attrs['text:string-value']) out.push({ k: 'text', text: c.attrs['text:string-value'], s: compactRunStyle(rs) });
          break;
        case 'text:hidden-paragraph':
          break;
        case 'draw:custom-shape':
        case 'draw:rect':
        case 'draw:ellipse': {
          // Shape: the outline is drawn on a canvas after the paragraph, with the text inside the shape.
          const w = toPx(c.attrs['svg:width']);
          const h = toPx(c.attrs['svg:height']);
          if (w < 2 || h < 2 || pendingShapes.length >= 200) {
            parseInlines(c, rs, out, href);
            break;
          }
          const shape: SlideShape = { x: toPx(c.attrs['svg:x']), y: toPx(c.attrs['svg:y']), w, h };
          const placed = odfTransform(c.attrs['draw:transform'], w, h, toPx, shape.x, shape.y);
          if (placed) {
            shape.x = placed.x;
            shape.y = placed.y;
            if (Math.abs(placed.rot) > 0.01) shape.rot = placed.rot;
          }
          const look = lookOf(c.attrs['draw:style-name']);
          if (look.fill && look.fill !== 'none') shape.fill = look.fill;
          if (look.stroke && look.stroke !== 'none') shape.stroke = look.stroke;
          const geometry = child(c, 'enhanced-geometry');
          const type = geometry?.attrs['draw:type'] ?? '';
          if (c.name === 'draw:ellipse' || /ellipse|circle/i.test(type)) shape.shape = 'ellipse';
          else if (geometry && !/^(ooxml-)?rect(angle)?$/i.test(type)) {
            const path = odfShapePath(geometry);
            if (path && !isPlainRectPath(path)) shape.path = path;
          }
          const paras: SlidePara[] = [];
          for (const p of childrenOf(c)) {
            if (p.name !== 'text:p' && p.name !== 'text:h') continue;
            const runs: Inline[] = [];
            parseInlines(p, mergeStyle(rs, resolve(p.attrs['text:style-name'])?.run), runs, href);
            const align = resolve(p.attrs['text:style-name'])?.para?.align;
            paras.push({ runs, align: align === 'left' || align === 'right' || align === 'justify' ? align : 'center' });
          }
          if (paras.some((p) => p.runs.some((r) => r.k === 'text' && r.text.trim()))) {
            shape.paras = paras;
            shape.anchor = 'middle';
          }
          if (geometry?.attrs['draw:text-path'] === 'true' && shape.paras) {
            // Fontwork (WordArt): rotated it is the page watermark, straight it is a large caption in the text.
            const words = shape.paras.map((p) => p.runs.map((r) => (r.k === 'text' ? r.text : '')).join('')).join(' ').trim();
            if (Math.abs(shape.rot ?? 0) > 5) {
              watermark ??= words;
            } else if (words) {
              const color = shape.fill ?? shape.stroke;
              out.push({ k: 'text', text: words, s: { size: Math.max(12, Math.min(36, h * 0.75 * 0.6)), b: 1, ...(color ? { color } : {}) } });
            }
            break;
          }
          if (shape.paras || shape.fill || shape.stroke) pendingShapes.push(shape);
          break;
        }
        case 'draw:frame': {
          const image = child(c, 'image');
          const path = image?.attrs['xlink:href'];
          const object = child(c, 'object');
          const formula = object ? formulas.get(object.attrs['xlink:href'] ?? '') : undefined;
          if (formula) {
            out.push({ k: 'math', node: formula });
            break;
          }
          const chart = object ? charts.get(object.attrs['xlink:href'] ?? '') : undefined;
          // A chart without a usable replacement picture is built from the data of the embedded object.
          if (chart && !(path && isLoadableImage(path))) {
            pendingBlocks.push({ k: 'chart', chart, w: Math.round(toPx(c.attrs['svg:width'])) || 480, h: Math.round(toPx(c.attrs['svg:height'])) || 288 });
            break;
          }
          if (path && !/^[a-z]+:/i.test(path)) {
            const clean = path.replace(/^\.\//, '');
            imagePaths.add(clean);
            const w = lengthToPt(c.attrs['svg:width']);
            const h = lengthToPt(c.attrs['svg:height']);
            out.push({ k: 'img', id: clean, w: w ? Math.round(w / 0.75) : undefined, h: h ? Math.round(h / 0.75) : undefined });
          } else {
            // Text box (frame): a block of its own with the frame's background and border, floated beside the text.
            const box = child(c, 'text-box');
            if (box) {
              const inner: Block[] = [];
              parseBlocks(box, inner);
              if (hasVisibleContent(inner)) {
                const look = frameLook(c.attrs['draw:style-name']);
                const w = lengthToPt(c.attrs['svg:width']);
                const frame: Block = { k: 'frame', blocks: inner, w, bg: look.bg, border: look.border, float: look.float };
                if (look.float) floats.push(frame);
                else pendingBlocks.push(frame);
              }
            }
          }
          break;
        }
        case 'office:annotation-end':
        case 'text:tracked-changes':
        case 'text:soft-page-break':
          break;
        default:
          parseInlines(c, rs, out, href);
      }
    }
  };

  interface ListContext {
    levels: ListLevel[];
    counters: number[];
    depth: number;
  }

  let floats: Block[] = [];
  const isHiddenParagraph = (p: XmlNode): boolean => {
    const stack: XmlNode[] = [p];
    for (let guard = 0; stack.length && guard < 2000; guard++) {
      const node = stack.pop()!;
      for (const c of node.children) {
        if (c.name === 'text:hidden-paragraph') {
          if (c.attrs['text:is-hidden'] === 'true') return true;
        } else if (c.name !== '#text' && c.name !== 'draw:frame' && c.name !== 'text:note') stack.push(c);
      }
    }
    return false;
  };

  const parseParagraph = (p: XmlNode, out: Block[], list?: ListContext, firstInItem = false): void => {
    // A paragraph hidden by a "hidden paragraph" field is not shown, as in LibreOffice.
    if (isHiddenParagraph(p)) return;
    const st = resolve(p.attrs['text:style-name']);
    const para: ParaStyle = { ...st?.para };
    let chapter: string | undefined;
    if (p.name === 'text:h') {
      const level = Math.max(1, Number(p.attrs['text:outline-level'] ?? 1) || 1);
      para.heading = Math.min(level, 6);
      if (p.attrs['text:is-list-header'] !== 'true' && !list) chapter = outlineNumber(level - 1);
    }
    const runs: Inline[] = [];
    floats = [];
    parseInlines(p, mergeStyle(defaultRun, st?.run), runs);
    if (st?.breakBefore) out.push({ k: 'pagebreak' });
    // Floated frames go before the paragraph they are anchored to, so its text flows around them.
    out.push(...floats);
    floats = [];
    if (para.dropCap && para.dropCap.chars === 0) para.dropCap = { ...para.dropCap, chars: /^\S+/.exec(runs[0]?.k === 'text' ? runs[0].text : '')?.[0].length ?? 1 };
    const block: Block = { k: 'p', runs };
    if (chapter) {
      block.marker = chapter;
      block.level = 0;
    }
    if (list) {
      block.level = list.depth;
      if (firstInItem) {
        const level = list.levels[list.depth];
        if (!level || level.bullet !== undefined) {
          const ch = level?.bullet ?? '•';
          // Characters from "symbol" fonts lie in the private use area and are invisible without the font.
          block.marker = ch.length === 1 && ch.charCodeAt(0) >= 0xe000 && ch.charCodeAt(0) <= 0xf8ff ? BULLETS[list.depth % 3] : ch;
        } else {
          block.marker = `${level.prefix}${formatCounter(list.counters[list.depth], level.format ?? '1')}${level.suffix}`;
        }
      } else {
        block.marker = ''; // item continuation: the same indent, no bullet
      }
      delete para.ml;
      delete para.ti;
    }
    if (Object.keys(para).length) block.s = para;
    out.push(block);
    if (pendingShapes.length) {
      // Shapes of a paragraph share a canvas, keeping their relative positions.
      const shapes = pendingShapes;
      pendingShapes = [];
      const positioned = shapes.some((sh) => sh.x || sh.y);
      if (!positioned) {
        let x = 0;
        for (const sh of shapes) {
          sh.x = x;
          x += sh.w + 12;
        }
      }
      const left = Math.min(...shapes.map((sh) => sh.x));
      const top = Math.min(...shapes.map((sh) => sh.y));
      for (const sh of shapes) {
        sh.x -= left;
        sh.y -= top;
      }
      out.push({ k: 'canvas', w: Math.ceil(Math.max(...shapes.map((sh) => sh.x + sh.w))), h: Math.ceil(Math.max(...shapes.map((sh) => sh.y + sh.h))), shapes });
    }
    if (pendingBlocks.length) {
      out.push(...pendingBlocks);
      pendingBlocks = [];
    }
  };

  const parseList = (listNode: XmlNode, out: Block[], parent?: ListContext): void => {
    const styleName = listNode.attrs['text:style-name'];
    const ctx: ListContext = parent
      ? { levels: styleName ? listStyles.get(styleName) ?? parent.levels : parent.levels, counters: parent.counters, depth: parent.depth + 1 }
      : { levels: listStyles.get(styleName ?? '') ?? [], counters: [], depth: 0 };
    const level = ctx.levels[ctx.depth];
    ctx.counters[ctx.depth] = (level?.start ?? 1) - 1;
    for (const item of childrenOf(listNode)) {
      if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue;
      const numbered = item.name === 'text:list-item';
      if (numbered) ctx.counters[ctx.depth]++;
      let first = numbered;
      for (const c of childrenOf(item)) {
        if (c.name === 'text:p' || c.name === 'text:h') {
          parseParagraph(c, out, ctx, first);
          first = false;
        } else if (c.name === 'text:list') {
          parseList(c, out, ctx);
        }
      }
    }
  };

  const parseTable = (tbl: XmlNode, out: Block[]): void => {
    const widths: number[] = [];
    const rows: TableRow[] = [];
    const visit = (node: XmlNode) => {
      for (const c of childrenOf(node)) {
        if (c.name === 'table:table-column') {
          const repeat = Math.min(Number(c.attrs['table:number-columns-repeated'] ?? 1) || 1, 200);
          const w = resolve(c.attrs['table:style-name'])?.colWidth ?? 0;
          for (let i = 0; i < repeat; i++) widths.push(w);
        } else if (c.name === 'table:table-row') {
          const cells: TableCell[] = [];
          for (const tc of childrenOf(c)) {
            if (tc.name === 'table:covered-table-cell') {
              cells.push({ blocks: [], skip: true });
            } else if (tc.name === 'table:table-cell') {
              const cell: TableCell = { blocks: [] };
              const cs = Number(tc.attrs['table:number-columns-spanned'] ?? 1) || 1;
              const rsp = Number(tc.attrs['table:number-rows-spanned'] ?? 1) || 1;
              if (cs > 1) cell.colSpan = cs;
              if (rsp > 1) cell.rowSpan = rsp;
              const cellStyle = resolve(tc.attrs['table:style-name']);
              const bg = cellStyle?.cellBg;
              if (bg) cell.bg = bg;
              if (cellStyle?.cellVert) cell.vert = cellStyle.cellVert;
              if (cellStyle?.cellVa) cell.va = cellStyle.cellVa;
              parseBlocks(tc, cell.blocks);
              cells.push(cell);
            }
          }
          if (cells.length) rows.push({ cells });
        } else if (c.name === 'table:table-header-rows' || c.name === 'table:table-rows' || c.name === 'table:table-row-group' || c.name === 'table:table-columns' || c.name === 'table:table-header-columns') {
          visit(c);
        }
      }
    };
    visit(tbl);
    if (rows.length) out.push({ k: 'table', rows, widths: widths.some((w) => w > 0) ? widths : undefined });
  };

  const parseBlocks = (parent: XmlNode, out: Block[]): void => {
    for (const c of childrenOf(parent)) {
      switch (c.name) {
        case 'text:p':
        case 'text:h':
          parseParagraph(c, out);
          break;
        case 'text:list':
          parseList(c, out);
          break;
        case 'table:table':
          parseTable(c, out);
          break;
        case 'text:section':
          // A hidden section, or a conditional one whose condition holds, is not shown.
          if (c.attrs['text:display'] !== 'none' && !(c.attrs['text:display'] === 'condition' && c.attrs['text:is-hidden'] === 'true')) parseBlocks(c, out);
          break;
        case 'text:table-of-content':
        case 'text:index-body':
        case 'text:alphabetical-index':
        case 'text:illustration-index':
          parseBlocks(c, out);
          break;
      }
    }
  };

  const blocks: Block[] = [];
  parseBlocks(text, blocks);
  appendPart(blocks, labels.footnotes, notes.footnote);
  appendPart(blocks, labels.endnotes, notes.endnote);

  // Headers/footers: the document is a scroll, so the header is output once at the start, the footer at the end.
  // The first master page that has them is used.
  const part = (node: XmlNode | undefined): Block[] => {
    const out: Block[] = [];
    if (node && node.attrs['style:display'] !== 'false') parseBlocks(node, out);
    return out;
  };
  for (const master of childrenOf(child(stylesDoc, 'master-styles'), 'master-page')) {
    const top = [...part(child(master, 'header-first')), ...part(child(master, 'header'))];
    let bottom = part(child(master, 'footer'));
    if (!hasVisibleContent(bottom)) bottom = part(child(master, 'footer-first'));
    if (!hasVisibleContent(top) && !hasVisibleContent(bottom)) continue;
    appendPart(blocks, labels.comments, notes.comment);
    notes.comment = [];
    appendPart(blocks, labels.footer, bottom);
    appendPart(blocks, labels.header, top, true);
    break;
  }
  appendPart(blocks, labels.comments, notes.comment);
  const model: DocModel = { blocks, images: {} };
  if (watermark) model.watermark = watermark;

  const layout = child(child(child(stylesDoc, 'automatic-styles'), 'page-layout'), 'page-layout-properties');
  const pageWidth = lengthToPt(layout?.attrs['fo:page-width']);
  if (pageWidth) {
    model.pageWidth = pageWidth;
    model.marginLeft = lengthToPt(layout?.attrs['fo:margin-left']) ?? 56.7;
    model.marginRight = lengthToPt(layout?.attrs['fo:margin-right']) ?? 56.7;
  }
  for (const path of imagePaths) {
    const entry = zip.get(path);
    if (!entry) continue;
    try {
      const image = loadImage(path, await zip.read(entry));
      if (image) model.images[path] = image;
    } catch {
      // A damaged picture must not prevent showing the text.
    }
  }
  return model;
}
