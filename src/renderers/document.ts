/**
 * Renders text documents (docx, odt, rtf, doc) from the common model.
 * A document is one continuous scroll on a "sheet"; nodes are created through the DOM API,
 * so file content cannot inject markup or scripts.
 */
import { DocParseError, loadDocModel } from '../core/doc-client';
import { fontFamilyCss, type Block, type DocModel, type Inline, type ParaStyle, type RunStyle } from '../core/docmodel';
import type { DocFormat } from '../formats/documents';
import { ViewerError } from '../types';
import { renderChart } from './chart';
import { renderMath } from './math';
import { createShapeRenderer } from './shapes';
import { clamp, el, type RenderContext, type RendererHandle } from './types';

const BLOCKS_PER_SECTION = 60;
const SAFE_LINK = /^(https?:|mailto:)/i;

function applyRunStyle(node: HTMLElement, s: RunStyle | undefined): void {
  if (!s) return;
  const st = node.style;
  if (s.b) st.fontWeight = '700';
  if (s.i) st.fontStyle = 'italic';
  const lines = [s.u ? 'underline' : '', s.s || s.ds ? 'line-through' : '', s.over ? 'overline' : ''].filter(Boolean).join(' ');
  if (lines) {
    st.textDecorationLine = lines;
    if (s.ds || s.ul === 'double') st.textDecorationStyle = 'double';
    else if (s.ul === 'wavy') st.textDecorationStyle = 'wavy';
    else if (s.ul === 'dotted' || s.ul === 'dashed') st.textDecorationStyle = s.ul;
  }
  if (s.caps === 'small') st.fontVariant = 'small-caps';
  else if (s.caps === 'all') st.textTransform = 'uppercase';
  if (s.ls) st.letterSpacing = `${clamp(s.ls, -3, 30)}pt`;
  if (s.va) {
    st.verticalAlign = s.va === 'sup' ? 'super' : 'sub';
    st.fontSize = '0.75em';
  } else if (s.size) {
    st.fontSize = `${clamp(s.size, 5, 96)}pt`;
  }
  if (s.color) st.color = s.color;
  if (s.outline) st.setProperty('-webkit-text-stroke', `${Math.max(0.6, (s.size ?? 12) / 40)}px ${s.outline}`);
  const shadows = [s.shadow ? '0.04em 0.04em 0.06em rgba(0, 0, 0, 0.45)' : '', s.glow ? `0 0 0.18em ${s.glow}, 0 0 0.35em ${s.glow}` : ''].filter(Boolean).join(', ');
  if (shadows) st.textShadow = shadows;
  if (s.bg) st.backgroundColor = s.bg;
  if (s.font) st.fontFamily = fontFamilyCss(s.font);
  else if (s.mono) node.classList.add('fv-doc-mono');
}

function applyParaStyle(node: HTMLElement, s: ParaStyle | undefined, hasMarker: boolean): void {
  if (!s) return;
  const st = node.style;
  if (s.align) st.textAlign = s.align;
  // Indents are capped: otherwise a document with wide margins turns into a narrow column on a small screen.
  if (s.ml) st.marginLeft = `min(${clamp(s.ml, 0, 400)}pt, 40%)`;
  if (s.mr) st.marginRight = `min(${clamp(s.mr, 0, 400)}pt, 30%)`;
  if (s.ti && !hasMarker) st.textIndent = `${clamp(s.ti, -200, 200)}pt`;
  if (s.mt !== undefined) st.marginTop = `${clamp(s.mt, 0, 96)}pt`;
  if (s.mb !== undefined) st.marginBottom = `${clamp(s.mb, 0, 96)}pt`;
  if (s.lh) st.lineHeight = String(clamp(s.lh * 1.2, 1, 3.6));
  if (s.bg) st.backgroundColor = s.bg;
  if (s.border) {
    st.border = `1px solid ${s.border}`;
    st.padding = '2pt 4pt';
  }
}

/** Filler between a text and a right-aligned tab stop: dots, dashes or a line, as in a table of contents. */
function leaderNode(leader: string | undefined): HTMLElement {
  const node = el('span', 'fv-doc-leader');
  if (leader) node.style.borderBottom = `1px ${leader === '.' ? 'dotted' : leader === '-' ? 'dashed' : 'solid'} currentColor`;
  return node;
}

export async function createDocumentRenderer(ctx: RenderContext): Promise<RendererHandle> {
  const blob = ctx.blob!;
  let model: DocModel;
  try {
    const { from, to, cc, subject, date, attachments, location, header, footer, footnotes, endnotes, comments } = ctx.labels;
    model = await loadDocModel(
      ctx.format as DocFormat,
      blob,
      { fallbackEncoding: ctx.options.fallbackEncoding, password: ctx.password, lang: ctx.options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined), labels: { from, to, cc, subject, date, attachments, location, header, footer, footnotes, endnotes, comments } },
      ctx.options.useWorkers !== false,
      ctx.signal,
    );
  } catch (err) {
    const name = err instanceof DocParseError ? err.errorName : undefined;
    if (name === 'AbortError') throw new ViewerError('aborted', 'aborted');
    if (name === 'PasswordError' || name === 'PasswordRequiredError' || name === 'WrongPasswordError' || name === 'EncryptionUnsupportedError') throw new ViewerError('password', ctx.labels.passwordProtected, ctx.format, err);
    throw new ViewerError('corrupt', ctx.labels.loadFailed, ctx.format, err);
  }
  if (ctx.signal.aborted) return { destroy() {} };

  const urls = new Map<string, string>();
  const imageUrl = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    let url = urls.get(id);
    if (!url) {
      const img = model.images[id];
      if (!img) return undefined;
      url = URL.createObjectURL(new Blob([img.data], { type: img.mime }));
      urls.set(id, url);
    }
    return url;
  };

  const lang = ctx.options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
  const shapes = createShapeRenderer({ imageUrl, labels: ctx.labels, lang });
  const canvases: { box: HTMLElement; stage: HTMLElement; w: number }[] = [];

  const renderInline = (run: Inline, parent: HTMLElement): void => {
    if (run.k === 'text') {
      let node: HTMLElement;
      if (run.href && SAFE_LINK.test(run.href)) {
        const a = el('a', 'fv-doc-link');
        a.href = run.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        node = a;
      } else {
        node = el('span');
      }
      node.textContent = run.text;
      applyRunStyle(node, run.s);
      const scale = run.s?.scale;
      if (scale && Math.abs(scale - 1) > 0.02) {
        // Horizontal scale: the box keeps its natural width, so the room it frees or needs is estimated.
        node.style.display = 'inline-block';
        node.style.transform = `scaleX(${clamp(scale, 0.3, 4)})`;
        node.style.transformOrigin = '0 50%';
        node.style.marginRight = `${((clamp(scale, 0.3, 4) - 1) * run.text.length * 0.52).toFixed(2)}em`;
        node.style.whiteSpace = 'pre';
      }
      parent.appendChild(node);
    } else if (run.k === 'br') {
      parent.appendChild(el('br'));
    } else if (run.k === 'tab') {
      parent.appendChild(el('span', 'fv-doc-tab', '\t'));
    } else if (run.k === 'math') {
      parent.appendChild(renderMath(run.node));
    } else {
      const url = imageUrl(run.id);
      if (!url) {
        parent.appendChild(el('span', 'fv-doc-noimg', '🖼'));
        return;
      }
      const img = el('img', 'fv-doc-img');
      img.src = url;
      img.alt = '';
      img.draggable = false;
      img.loading = 'lazy';
      img.decoding = 'async';
      let node: HTMLElement = img;
      const crop = run.crop;
      if (crop && run.w && run.h) {
        // Cropping: the frame shows a part of a larger picture.
        const frame = el('span', 'fv-doc-crop');
        frame.style.width = `${run.w}px`;
        frame.style.aspectRatio = `${run.w} / ${run.h}`;
        const kx = 1 / Math.max(0.05, 1 - crop[0] - crop[2]);
        const ky = 1 / Math.max(0.05, 1 - crop[1] - crop[3]);
        img.style.width = `${kx * 100}%`;
        img.style.height = `${ky * 100}%`;
        img.style.marginLeft = `${-crop[0] * kx * 100}%`;
        img.style.marginTop = `${-crop[1] * kx * 100}%`;
        img.style.maxWidth = 'none';
        frame.appendChild(img);
        node = frame;
      } else {
        if (run.w) img.style.width = `${run.w}px`;
        if (run.w && run.h) img.style.aspectRatio = `${run.w} / ${run.h}`;
      }
      if (run.border) node.style.border = run.border;
      if (run.rot) node.style.transform = `rotate(${run.rot}deg)`;
      if (run.float) {
        node.classList.add('fv-doc-float');
        node.style.float = run.float;
        node.style.margin = run.float === 'right' ? '2pt 0 4pt 10pt' : '2pt 10pt 4pt 0';
        node.style.maxWidth = '50%';
      } else if (run.behind) {
        node.classList.add('fv-doc-behind');
        node.style.left = `${Math.max(0, run.behind.x)}px`;
        node.style.top = `${run.behind.y}px`;
        parent.classList.add('fv-doc-has-behind');
      }
      parent.appendChild(node);
    }
  };

  /** Width of the text area in points: tab stops are positioned as fractions of it. */
  const textWidth = Math.max(120, (model.pageWidth ?? 612) - (model.marginLeft ?? 72) - (model.marginRight ?? 72));

  /**
   * A one-line paragraph with tab stops is laid out as a grid whose column edges are the stops, so columns
   * line up and a right-aligned stop with a leader behaves as in a table of contents.
   */
  const renderTabbed = (block: Extract<Block, { k: 'p' }>, node: HTMLElement): boolean => {
    const stops = (block.s?.tabs ?? []).filter((t) => t.pos > 0 && t.pos <= textWidth * 1.05).sort((a, b) => a.pos - b.pos);
    const tabCount = block.runs.filter((r) => r.k === 'tab').length;
    if (!stops.length || !tabCount || tabCount > stops.length) return false;
    if (block.runs.reduce((n, r) => n + (r.k === 'text' ? r.text.length : 0), 0) > 260) return false;
    const base = block.s?.ml ?? 0;
    const edges = stops.map((t) => Math.max(0, t.pos - base));
    const columns: string[] = [];
    let prev = 0;
    for (const e of edges) {
      columns.push(`${Math.max(1, e - prev).toFixed(1)}fr`);
      prev = Math.max(prev, e);
    }
    columns.push(`${Math.max(1, textWidth - base - prev).toFixed(1)}fr`);
    node.classList.add('fv-doc-tabbed');
    node.style.gridTemplateColumns = columns.join(' ');
    let item = el('span', 'fv-doc-tabcell');
    let start = 1;
    let index = 0;
    item.style.gridColumn = `${start} / ${start + 1}`;
    node.appendChild(item);
    for (const run of block.runs) {
      if (run.k !== 'tab') {
        renderInline(run, item);
        continue;
      }
      const stop = stops[index++];
      if (stop.align === 'right' || stop.align === 'decimal') {
        // The text after the tab ends at the stop: it shares one flex item with what precedes it.
        item.classList.add('fv-doc-tabflex');
        item.style.gridColumn = `${start} / ${index + 1}`;
        item.appendChild(leaderNode(stop.leader));
      } else {
        item = el('span', 'fv-doc-tabcell');
        start = index + 1;
        item.style.gridColumn = `${start} / ${start + 1}`;
        if (stop.align === 'center') item.classList.add('fv-doc-tabcenter');
        node.appendChild(item);
      }
    }
    return true;
  };

  const renderBlock = (block: Block, parent: HTMLElement): void => {
    if (block.k === 'pagebreak') {
      parent.appendChild(el('hr', 'fv-doc-break'));
      return;
    }
    if (block.k === 'chart') {
      const box = el('div', 'fv-doc-chart');
      box.style.width = `${block.w}px`;
      box.style.aspectRatio = `${block.w} / ${block.h}`;
      box.appendChild(renderChart(block.chart, block.w, block.h, lang));
      parent.appendChild(box);
      return;
    }
    if (block.k === 'canvas') {
      // The canvas is drawn in source pixels and scaled as a whole to the sheet width.
      const box = el('div', 'fv-doc-canvas');
      box.style.width = `${block.w}px`;
      box.style.aspectRatio = `${block.w} / ${block.h}`;
      const stage = el('div', 'fv-doc-canvas-stage');
      stage.style.width = `${block.w}px`;
      stage.style.height = `${block.h}px`;
      for (const shape of block.shapes) stage.appendChild(shapes.shape(shape));
      box.appendChild(stage);
      canvases.push({ box, stage, w: block.w });
      parent.appendChild(box);
      return;
    }
    if (block.k === 'rule') {
      const rule = el('div', 'fv-doc-rule');
      if (block.label) rule.appendChild(el('span', 'fv-doc-rule-label', block.label));
      parent.appendChild(rule);
      return;
    }
    if (block.k === 'table') {
      const wrap = el('div', 'fv-doc-table-wrap');
      if (block.float) {
        // A floating table: text flows beside it when the screen is wide enough.
        wrap.classList.add('fv-doc-float');
        wrap.style.float = block.float;
        wrap.style.width = `min(${clamp(block.w ?? 240, 80, 600)}pt, 60%)`;
        wrap.style.margin = block.float === 'right' ? '2pt 0 6pt 12pt' : '2pt 12pt 6pt 0';
      }
      const table = el('table', 'fv-doc-table');
      if (block.widths) {
        const total = block.widths.reduce((a, b) => a + b, 0) || 1;
        const group = el('colgroup');
        for (const w of block.widths) {
          const col = el('col');
          col.style.width = `${(w / total) * 100}%`;
          group.appendChild(col);
        }
        table.appendChild(group);
      }
      const tbody = el('tbody');
      for (const row of block.rows) {
        const tr = el('tr');
        if (row.h) tr.style.height = `${clamp(row.h, 0, 600)}pt`;
        for (const cell of row.cells) {
          if (cell.skip) continue;
          const td = el('td');
          if (cell.colSpan) td.colSpan = cell.colSpan;
          if (cell.rowSpan) td.rowSpan = cell.rowSpan;
          if (cell.bg) td.style.backgroundColor = cell.bg;
          if (cell.va) td.style.verticalAlign = cell.va;
          let target: HTMLElement = td;
          if (cell.vert) {
            // Vertical text: the content is set in a box whose lines run top to bottom.
            target = el('div', 'fv-doc-vert');
            if (cell.vert === 'bt') target.classList.add('fv-doc-vert-bt');
            td.appendChild(target);
          }
          for (const b of cell.blocks) renderBlock(b, target);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      parent.appendChild(wrap);
      return;
    }
    if (block.k === 'frame') {
      const frame = el('div', 'fv-doc-frame');
      if (block.float) {
        frame.classList.add('fv-doc-float');
        frame.style.float = block.float;
        frame.style.width = `min(${clamp(block.w ?? 200, 60, 600)}pt, 50%)`;
        frame.style.margin = block.float === 'right' ? '2pt 0 6pt 12pt' : '2pt 12pt 6pt 0';
      } else if (block.w) {
        frame.style.maxWidth = `${clamp(block.w, 60, 1200)}pt`;
      }
      if (block.bg) frame.style.backgroundColor = block.bg;
      if (block.border) frame.style.border = block.border;
      if (block.bg || block.border) frame.style.padding = '3pt 6pt';
      for (const b of block.blocks) renderBlock(b, frame);
      parent.appendChild(frame);
      return;
    }
    const level = block.s?.heading;
    const node = level ? el(`h${clamp(level, 1, 6)}` as 'h1', 'fv-doc-h') : el('p', 'fv-doc-p');
    const hasMarker = block.marker !== undefined;
    applyParaStyle(node, block.s, hasMarker);
    if (hasMarker) {
      // A numbered heading keeps its place; a list item hangs its marker in the indent.
      if (!level) node.classList.add('fv-doc-li');
      // Without own indents in the file, the nesting level sets the indent.
      if (!level && !block.s?.ml) node.style.marginLeft = `${18 * ((block.level ?? 0) + 1)}pt`;
      node.appendChild(el('span', 'fv-doc-marker', block.marker ? `${block.marker} ` : ''));
    }
    const drop = block.s?.dropCap;
    let runs = block.runs;
    if (drop && runs[0]?.k === 'text' && runs[0].text.length >= drop.chars && drop.chars > 0) {
      // Drop cap: the first letters are enlarged and the paragraph flows around them.
      const first = runs[0];
      const cap = el('span', 'fv-doc-dropcap', first.text.slice(0, drop.chars));
      applyRunStyle(cap, { ...first.s, size: undefined });
      cap.style.fontSize = `${clamp(drop.lines, 2, 6) * 1.3}em`;
      node.appendChild(cap);
      runs = [{ ...first, text: first.text.slice(drop.chars) }, ...runs.slice(1)];
    }
    if (!hasMarker && !drop && renderTabbed(block, node)) {
      parent.appendChild(node);
      return;
    }
    for (const run of runs) renderInline(run, node);
    // An empty paragraph is an empty line; without content it would collapse.
    if (block.runs.length === 0 && !hasMarker) node.appendChild(el('br'));
    parent.appendChild(node);
  };

  const scroller = el('div', 'fv-doc fv-paper');
  scroller.tabIndex = 0;
  const page = el('div', 'fv-doc-page');
  if (model.pageWidth) {
    page.style.maxWidth = `${clamp(model.pageWidth, 300, 1400)}pt`;
    // Margins from the file, but no wider than 9% of the screen: on a phone 2.5 cm margins would eat a third of the line.
    page.style.paddingLeft = `min(${clamp(model.marginLeft ?? 72, 18, 120)}pt, 9%)`;
    page.style.paddingRight = `min(${clamp(model.marginRight ?? 72, 18, 120)}pt, 9%)`;
  }
  if (model.blocks.length === 0) {
    page.appendChild(el('div', 'fv-doc-empty', ctx.labels.empty));
  } else {
    // The browser does not render off-screen sections, so a long document scrolls smoothly.
    for (let i = 0; i < model.blocks.length; i += BLOCKS_PER_SECTION) {
      const section = el('div', 'fv-doc-section');
      for (const block of model.blocks.slice(i, i + BLOCKS_PER_SECTION)) renderBlock(block, section);
      page.appendChild(section);
    }
  }
  scroller.appendChild(page);
  if (model.pageBg) page.style.backgroundColor = model.pageBg;
  const markUrl = imageUrl(model.watermarkImage);
  if (markUrl) {
    // Picture watermark: a pale image that stays in place while scrolling.
    const mark = el('div', 'fv-doc-watermark fv-doc-watermark-img');
    const img = el('img');
    img.src = markUrl;
    img.alt = '';
    img.draggable = false;
    mark.appendChild(img);
    scroller.appendChild(mark);
  }
  if (model.watermark) {
    // Watermark: a pale diagonal caption that stays in place while scrolling.
    const mark = el('div', 'fv-doc-watermark');
    mark.appendChild(el('span', undefined, model.watermark));
    scroller.appendChild(mark);
  }
  ctx.host.appendChild(scroller);
  const fitCanvases = () => {
    for (const c of canvases) {
      const k = c.box.clientWidth / c.w;
      c.stage.style.transform = k > 0 && Math.abs(k - 1) > 0.005 ? `scale(${k})` : '';
    }
  };
  const canvasObserver = canvases.length ? new ResizeObserver(fitCanvases) : null;
  canvasObserver?.observe(page);
  fitCanvases();

  let zoom = 1;
  const setZoom = (next: number) => {
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    zoom = clamp(next, 0.5, 3);
    page.style.setProperty('zoom', String(zoom));
    ctx.setZoomLabel(`${Math.round(zoom * 100)}%`);
    scroller.scrollTop = ratio * scroller.scrollHeight;
  };
  ctx.setZoomLabel('100%');

  return {
    zoomIn: () => setZoom(zoom * 1.15),
    zoomBy: (factor) => setZoom(zoom * factor),
    zoomOut: () => setZoom(zoom / 1.15),
    zoomReset: () => setZoom(1),
    destroy() {
      canvasObserver?.disconnect();
      scroller.remove();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
