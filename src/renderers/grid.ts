/**
 * Virtualized grid for tabular data (csv, xlsx, ods, xls).
 * Only visible cells are in the DOM; rows are requested from the source in blocks while scrolling.
 * Cell styles, merged cells and sheet switching are supported.
 */
import type { CellStyle, Merge, TableMeta, TableSource } from '../core/table-source';
import type { SheetObject } from '../core/workbook';
import { fontFamilyCss } from '../core/docmodel';
import { renderChart } from './chart';
import { clamp, el, type RenderContext, type RendererHandle } from './types';

const BLOCK = 200; // rows per request to the source
const MAX_BLOCKS = 12; // blocks in the cache
const OVERSCAN_ROWS = 8;
const OVERSCAN_COLS = 2;
const BASE_FONT = 13;
const BASE_ROW = 28;
const MAX_SCROLL_HEIGHT = 15_000_000; // safe element height limit across browsers

const NUMERIC_RE = /^[-+(]?[\d\s  .,]+[)%]?$/;

interface Block {
  rows: (string[] | undefined)[];
  styles?: (number[] | undefined)[];
}

/** Column name as in spreadsheets: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Whether dark or light text reads better on the given fill. */
function contrastColor(fill: string): string {
  const n = parseInt(fill.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#1f2328' : '#ffffff';
}


/** Sparkline as an SVG picture: line, columns or win/loss. */
export function sparkSvg(spark: NonNullable<CellStyle['spark']>): string {
  const W = 100;
  const H = 30;
  const numbers = spark.values.filter((v): v is number => v !== null);
  const n = spark.values.length;
  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  if (spark.kind !== 'line') {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const span = max - min || 1;
  const y = (v: number) => Math.round((H - 2 - ((v - min) / span) * (H - 4)) * 10) / 10;
  let body = '';
  if (spark.kind === 'line') {
    const step = n > 1 ? (W - 4) / (n - 1) : 0;
    let d = '';
    let pen = false;
    spark.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${Math.round((2 + i * step) * 10) / 10} ${numbers.length > 1 && max !== min ? y(v) : H / 2} `;
      pen = true;
    });
    body = `<path d="${d.trim()}" fill="none" stroke="${spark.color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  } else {
    const slot = W / Math.max(1, n);
    const zero = y(0);
    spark.values.forEach((v, i) => {
      if (v === null || v === 0) return;
      const top = spark.kind === 'stacked' ? (v > 0 ? 2 : H / 2) : Math.min(y(v), zero);
      const height = spark.kind === 'stacked' ? H / 2 - 2 : Math.max(1, Math.abs(y(v) - zero));
      body += `<rect x="${Math.round((i * slot + slot * 0.15) * 10) / 10}" y="${top}" width="${Math.round(slot * 0.7 * 10) / 10}" height="${Math.round(height * 10) / 10}" fill="${v < 0 && spark.negative ? spark.negative : spark.color}"/>`;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}</svg>`;
}

function applyStyle(cell: HTMLElement, style: CellStyle | undefined): void {
  if (!style) return;
  if (style.bold) cell.style.fontWeight = '600';
  if (style.italic) cell.style.fontStyle = 'italic';
  if (style.align) cell.style.textAlign = style.align;
  if (style.underline || style.strike) cell.style.textDecoration = `${style.underline ? 'underline' : ''} ${style.strike ? 'line-through' : ''}`.trim();
  if (style.size) cell.style.fontSize = `${Math.round((style.size / 11) * 100) / 100}em`;
  if (style.spark) {
    // A sparkline is drawn as the cell background: the SVG picture stretches over the whole cell.
    cell.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(sparkSvg(style.spark))}")`;
    cell.style.backgroundSize = 'calc(100% - 8px) calc(100% - 6px)';
    cell.style.backgroundPosition = '4px 3px';
    cell.style.backgroundRepeat = 'no-repeat';
  }
  if (style.bar) {
    const end = Math.round(style.bar.part * 100);
    cell.style.backgroundImage = `linear-gradient(to right, ${style.bar.color} ${end}%, transparent ${end}%)`;
    cell.style.backgroundSize = 'calc(100% - 6px) calc(100% - 6px)';
    cell.style.backgroundPosition = '3px 3px';
    cell.style.backgroundRepeat = 'no-repeat';
  }
  if (style.font) cell.style.fontFamily = fontFamilyCss(style.font);
  if (style.border) {
    const color = style.lineColor ?? '#3d444d';
    // Solid lines are drawn as shadows over the grid lines, so neighbouring cells share one line instead of
    // showing two; dashed, dotted and double lines need real borders.
    const shadows: string[] = [];
    const side = (letter: string, x: number, y: number, edge: 'Top' | 'Right' | 'Bottom' | 'Left') => {
      const at = style.border!.indexOf(letter);
      if (at < 0) return;
      const kind = style.lines?.[at] ?? 's';
      if (kind === 'd' || kind === 'h' || kind === 'o') {
        cell.style[`border${edge}`] = kind === 'd' ? `3px double ${color}` : `1px ${kind === 'h' ? 'dashed' : 'dotted'} ${color}`;
        return;
      }
      const extra = kind === 'k' ? 2 : kind === 'm' ? 1 : 0;
      if (edge === 'Right') cell.style.borderRight = `1px solid ${color}`;
      else shadows.push(`${x}px ${y}px 0 0 ${color}`);
      if (extra) shadows.push(`inset ${-x * extra}px ${-y * extra}px 0 0 ${color}`);
    };
    side('t', 0, -1, 'Top');
    side('r', 1, 0, 'Right');
    side('b', 0, 1, 'Bottom');
    side('l', -1, 0, 'Left');
    if (shadows.length) cell.style.boxShadow = shadows.join(', ');
    cell.classList.add('fv-bordered');
  }
  if (style.fillImage && !style.bar && !style.spark) {
    cell.style.background = style.fill ? `${style.fillImage}, ${style.fill}` : `${style.fillImage}, #ffffff`;
    if (style.color) cell.style.color = style.color;
  } else if (style.fill) {
    cell.style.background = style.fill;
    // Colours in the file are chosen for a light background; without an explicit text colour a contrasting one is picked.
    cell.style.color = style.color ?? contrastColor(style.fill);
  } else if (style.color) {
    cell.style.color = style.color;
    cell.classList.add('fv-colored');
  }
}

export function createGrid(ctx: RenderContext, source: TableSource, options: { paper?: boolean } = {}): RendererHandle {
  const root = el('div', 'fv-grid-wrap');
  if (options.paper) root.classList.add('fv-paper');
  const scroller = el('div', 'fv-grid');
  scroller.tabIndex = 0;
  const head = el('div', 'fv-grid-head');
  const body = el('div', 'fv-grid-body');
  const rowsLayer = el('div', 'fv-grid-rows');
  const mergeLayer = el('div', 'fv-grid-merges');
  body.append(rowsLayer, mergeLayer);
  const emptyNote = el('div', 'fv-grid-empty', ctx.labels.empty);
  emptyNote.hidden = true;
  const detail = el('div', 'fv-grid-detail');
  detail.hidden = true;
  const tabs = el('div', 'fv-tabs');
  tabs.setAttribute('role', 'tablist');
  scroller.append(head, body);
  root.append(scroller, emptyNote, detail, tabs);
  ctx.host.appendChild(root);

  let meta: TableMeta = source.meta;
  let activeSheet = 0;
  let switching = 0;
  let zoom = 1;
  let rowH = BASE_ROW;
  let headH = BASE_ROW;
  let numW = 0;
  let colX: number[] = []; // left edge of every column; the last element is the total width
  // Top edges of rows if the sheet has rows of non-default height; otherwise all rows are equal.
  let rowY: Float64Array | null = null;
  const rowTop = (r: number) => (rowY ? rowY[r] : r * rowH);
  const rowHeightAt = (r: number) => (rowY ? rowY[r + 1] - rowY[r] : rowH);
  /** The row that contains the vertical coordinate y. */
  const rowAt = (y: number): number => {
    if (!rowY) return Math.floor(y / rowH);
    let lo = 0;
    let hi = meta.rowCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowY[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const objectLayer = el('div', 'fv-grid-objects');
  body.appendChild(objectLayer);
  const objectUrls: string[] = [];
  let charWidth = 8; // average character width at the current zoom
  let destroyed = false;
  let frame = 0;
  let lastKey = '';
  let selected: { row: number; col: number } | null = null;

  const cache = new Map<number, Block>();
  const loading = new Set<number>();
  let generation = 0; // grows when the sheet changes: replies to stale requests are dropped

  const maxZoom = () => clamp(MAX_SCROLL_HEIGHT / Math.max(1, meta.rowCount * BASE_ROW * (meta.rowHeights ? 1.5 : 1)), 1, 2.5);

  const layout = () => {
    const { rowCount, columnCount, columnWidths } = meta;
    const font = Math.round(BASE_FONT * zoom * 10) / 10;
    const charW = font * 0.62;
    charWidth = font * 0.56;
    const pad = Math.round(16 * zoom);
    rowH = Math.round(BASE_ROW * zoom);
    headH = rowH;
    numW = Math.round(Math.max(2, String(rowCount).length) * charW + pad);
    colX = [numW];
    for (let c = 0; c < columnCount; c++) colX.push(colX[c] + Math.max(12, Math.round(columnWidths[c] * charW + pad)));
    root.style.fontSize = `${font}px`;
    root.style.setProperty('--fv-row-h', `${rowH}px`);
    const totalW = colX[columnCount];
    head.style.width = `${totalW}px`;
    head.style.height = `${headH}px`;
    body.style.width = `${totalW}px`;
    rowY = null;
    if (meta.rowHeights) {
      rowY = new Float64Array(rowCount + 1);
      for (let r = 0; r < rowCount; r++) rowY[r + 1] = rowY[r] + Math.max(6, Math.round(rowH * (meta.rowHeights[r] ?? 1)));
    }
    body.style.height = `${rowTop(rowCount)}px`;
    renderObjects();
    const isEmpty = rowCount === 0;
    emptyNote.hidden = !isEmpty;
    scroller.hidden = isEmpty;
    ctx.setZoomLabel(`${Math.round(zoom * 100)}%`);
    ctx.setNotice(meta.truncated ? ctx.labels.truncatedRows : null);
    lastKey = '';
  };

  const requestBlock = (block: number) => {
    if (block < 0 || cache.has(block) || loading.has(block)) return;
    loading.add(block);
    const gen = generation;
    source
      .getRows(block * BLOCK, Math.min(meta.rowCount, (block + 1) * BLOCK))
      .then((data) => {
        if (destroyed || gen !== generation) return;
        cache.set(block, data);
        // Simplest eviction: remove the oldest block.
        if (cache.size > MAX_BLOCKS) cache.delete(cache.keys().next().value as number);
        lastKey = '';
        schedule();
      })
      .catch(() => {
        /* the source is closed or the worker failed: the cells stay empty */
      })
      .finally(() => {
        if (gen === generation) loading.delete(block);
      });
  };

  const cellText = (row: number, col: number): string | undefined => cache.get(Math.floor(row / BLOCK))?.rows[row % BLOCK]?.[col];
  const cellStyle = (row: number, col: number): CellStyle | undefined => {
    const id = cache.get(Math.floor(row / BLOCK))?.styles?.[row % BLOCK]?.[col];
    return id ? meta.styles?.[id] : undefined;
  };

  /** The first column whose right edge is to the right of x. */
  const colAt = (x: number): number => {
    let lo = 0;
    let hi = meta.columnCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colX[mid + 1] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const makeCell = (row: number, col: number, value: string | undefined, style: CellStyle | undefined, height = rowHeightAt(row)): HTMLDivElement => {
    const cell = el('div', 'fv-grid-cell');
    // Several lines of text are visible if the cell wraps or the row is tall enough.
    const multiline = !!value && height >= rowH * 1.6 && (style?.wrap || value.includes('\n'));
    const runs = value ? meta.rich?.[`${row}:${col}`] : undefined;
    const rot = style?.rot;
    if (value && (rot || runs) && !multiline) {
      // Rotated or multi-format text gets an inner element; plain cells stay a single text node.
      const text = el('span', rot ? 'fv-grid-rot' : 'fv-grid-rich');
      if (runs) {
        for (const run of runs) {
          const span = el('span', undefined, run.t);
          if (run.bold) span.style.fontWeight = '600';
          if (run.italic) span.style.fontStyle = 'italic';
          if (run.underline || run.strike) span.style.textDecoration = `${run.underline ? 'underline' : ''} ${run.strike ? 'line-through' : ''}`.trim();
          if (run.color) span.style.color = run.color;
          if (run.size) span.style.fontSize = `${Math.round((run.size / 11) * 100) / 100}em`;
          if (run.font) span.style.fontFamily = fontFamilyCss(run.font);
          if (run.sup || run.sub) {
            span.style.verticalAlign = run.sup ? 'super' : 'sub';
            span.style.fontSize = '0.75em';
          }
          text.appendChild(span);
        }
      } else text.textContent = value;
      if (rot === 255) text.classList.add('fv-grid-stacked');
      else if (rot === 90 || rot === -90) {
        text.classList.add('fv-grid-vertical');
        if (rot === 90) text.style.transform = 'rotate(180deg)';
      } else if (rot) {
        text.style.transform = `rotate(${-rot}deg)`;
        text.style.transformOrigin = rot > 0 ? '0 100%' : '0 0';
      }
      cell.appendChild(text);
      if (rot) {
        cell.classList.add('fv-rotated');
        cell.style.lineHeight = '';
      }
    } else if (value) {
      if (multiline) {
        const text = el('span', 'fv-grid-wraptext', value);
        if (!style?.wrap) text.style.whiteSpace = 'pre';
        cell.appendChild(text);
        cell.classList.add('fv-wrap');
        cell.style.alignItems = style?.valign === 'top' ? 'flex-start' : style?.valign === 'middle' ? 'center' : 'flex-end';
        cell.style.justifyContent = style?.align === 'center' ? 'center' : style?.align === 'right' ? 'flex-end' : 'flex-start';
      } else {
        // The cell shows the first line; the full text is in the panel below the table.
        const nl = value.indexOf('\n');
        cell.textContent = nl < 0 ? value : `${value.slice(0, nl)} ⏎`;
      }
      if (NUMERIC_RE.test(value)) cell.classList.add('fv-num');
    }
    if (!multiline && !rot && height !== rowH) cell.style.lineHeight = `${style?.valign === 'top' ? rowH : height}px`;
    if (style?.icon && value) {
      const icon = el('span', 'fv-grid-icon', style.icon.char);
      icon.style.color = style.icon.color;
      cell.prepend(icon);
    }
    if (meta.notes?.[`${row}:${col}`]) cell.classList.add('fv-noted');
    applyStyle(cell, style);
    if (selected && selected.row === row && selected.col === col) cell.classList.add('fv-selected');
    cell.dataset.r = String(row);
    cell.dataset.c = String(col);
    return cell;
  };

  const render = () => {
    frame = 0;
    if (destroyed || meta.rowCount === 0) return;
    const { rowCount, columnCount } = meta;
    const top = scroller.scrollTop;
    const left = scroller.scrollLeft;
    const viewH = scroller.clientHeight;
    const viewW = scroller.clientWidth;

    const r0 = clamp(rowAt(top) - OVERSCAN_ROWS, 0, rowCount);
    const r1 = clamp(rowAt(top + viewH - headH) + 1 + OVERSCAN_ROWS, 0, rowCount);
    const c0 = clamp(colAt(left + numW) - OVERSCAN_COLS, 0, columnCount);
    const c1 = clamp(colAt(left + viewW) + 1 + OVERSCAN_COLS, 0, columnCount);

    for (let b = Math.floor(r0 / BLOCK); b <= Math.floor(Math.max(r0, r1 - 1) / BLOCK); b++) requestBlock(b);

    // Merges that intersect the window. Their anchor cells may lie outside it.
    const merges: Merge[] = [];
    if (meta.merges) {
      for (const m of meta.merges) {
        if (m.r1 >= r0 && m.r0 < r1 && m.c1 >= c0 && m.c0 < c1) {
          merges.push(m);
          requestBlock(Math.floor(m.r0 / BLOCK));
        }
      }
    }

    const key = `${r0}:${r1}:${c0}:${c1}:${selected ? `${selected.row},${selected.col}` : ''}`;
    if (key === lastKey) return;
    lastKey = key;

    const covered = new Set<number>();
    for (const m of merges) {
      for (let r = Math.max(m.r0, r0); r <= Math.min(m.r1, r1 - 1); r++) {
        for (let c = Math.max(m.c0, c0); c <= Math.min(m.c1, c1 - 1); c++) covered.add(r * 16384 + c);
      }
    }

    // Column header.
    const headFrag = document.createDocumentFragment();
    const corner = el('div', 'fv-grid-corner');
    corner.style.width = `${numW}px`;
    headFrag.appendChild(corner);
    for (let c = c0; c < c1; c++) {
      const cell = el('div', 'fv-grid-colhead', columnName(meta.colLabels?.[c] ?? c));
      cell.style.left = `${colX[c]}px`;
      cell.style.width = `${colX[c + 1] - colX[c]}px`;
      headFrag.appendChild(cell);
    }
    head.replaceChildren(headFrag);

    // Rows.
    const frag = document.createDocumentFragment();
    for (let r = r0; r < r1; r++) {
      const row = el('div', 'fv-grid-row');
      row.style.top = `${rowTop(r)}px`;
      if (rowY) row.style.height = `${rowHeightAt(r)}px`;
      const num = el('div', 'fv-grid-rownum', String((meta.rowLabels?.[r] ?? r) + 1));
      num.style.width = `${numW}px`;
      row.appendChild(num);
      const block = cache.get(Math.floor(r / BLOCK));
      const data = block?.rows[r % BLOCK];
      const styleRow = block?.styles?.[r % BLOCK];
      if (data || styleRow) {
        for (let c = c0; c < c1; c++) {
          const value = data?.[c];
          const styleId = styleRow?.[c];
          if (!value && !styleId) continue;
          if (covered.size && covered.has(r * 16384 + c)) continue;
          const style = styleId ? meta.styles?.[styleId] : undefined;
          const cell = makeCell(r, c, value, style);
          // As in Excel: long text continues over empty neighbouring cells.
          let from = c;
          let to = c;
          if (value && !style?.border && !style?.fill && !style?.wrap && !style?.bar && value.length * charWidth * ((style?.size ?? 11) / 11) > colX[c + 1] - colX[c] - 12) {
            const free = (k: number) => !data?.[k] && !styleRow?.[k] && !(covered.size && covered.has(r * 16384 + k));
            if (style?.align === 'right') while (from > 0 && free(from - 1) && value.length * charWidth > colX[c + 1] - colX[from]) from--;
            else if (style?.align !== 'center') while (to + 1 < columnCount && free(to + 1) && value.length * charWidth > colX[to + 1] - colX[c]) to++;
            if (from !== c || to !== c) cell.classList.add('fv-overflow');
          }
          cell.style.left = `${colX[from]}px`;
          cell.style.width = `${colX[to + 1] - colX[from]}px`;
          row.appendChild(cell);
        }
      }
      frag.appendChild(row);
    }
    rowsLayer.replaceChildren(frag);

    // Merged cells are drawn as a separate layer above the grid lines.
    const mergeFrag = document.createDocumentFragment();
    for (const m of merges) {
      const cEnd = Math.min(m.c1, columnCount - 1);
      const rEnd = Math.min(m.r1, rowCount - 1);
      const mergedH = rowTop(rEnd + 1) - rowTop(m.r0);
      const cell = makeCell(m.r0, m.c0, cellText(m.r0, m.c0), cellStyle(m.r0, m.c0), mergedH);
      cell.classList.add('fv-merged');
      cell.style.left = `${colX[m.c0]}px`;
      cell.style.top = `${rowTop(m.r0)}px`;
      cell.style.width = `${colX[cEnd + 1] - colX[m.c0]}px`;
      cell.style.height = `${mergedH}px`;
      if (!cell.classList.contains('fv-wrap')) cell.style.lineHeight = `${mergedH}px`;
      mergeFrag.appendChild(cell);
    }
    mergeLayer.replaceChildren(mergeFrag);
  };

  /** Pictures, charts and shapes of the sheet: they lie above the cells and scroll with them. */
  function renderObjects(): void {
    for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
    const frag = document.createDocumentFragment();
    const edge = (index: number, part: number | undefined, start: (i: number) => number, count: number) => {
      const i = clamp(index, 0, count);
      const size = i < count ? start(i + 1) - start(i) : 0;
      return start(i) + size * (part ?? 0);
    };
    for (const o of (meta.objects ?? []) as SheetObject[]) {
      const sized = o.w !== undefined && o.h !== undefined;
      const x0 = edge(o.c0, o.dx0, (i) => colX[i], meta.columnCount) + (sized ? (o.ox ?? 0) * zoom : 0);
      const y0 = edge(o.r0, o.dy0, rowTop, meta.rowCount) + (sized ? (o.oy ?? 0) * zoom : 0);
      const x1 = sized ? x0 + o.w! * zoom : edge(o.c1, o.dx1, (i) => colX[i], meta.columnCount);
      const y1 = sized ? y0 + o.h! * zoom : edge(o.r1, o.dy1, rowTop, meta.rowCount);
      const w = Math.max(8, x1 - x0);
      const h = Math.max(8, y1 - y0);
      const box = el('div', 'fv-grid-object');
      box.style.left = `${x0}px`;
      box.style.top = `${y0}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      if (o.image) {
        const url = URL.createObjectURL(new Blob([o.image.data], { type: o.image.mime }));
        objectUrls.push(url);
        const img = el('img');
        img.src = url;
        img.alt = '';
        img.draggable = false;
        box.appendChild(img);
      } else if (o.chart) {
        // A chart is drawn in its own pixels and stretches with the sheet zoom.
        box.appendChild(renderChart(o.chart, Math.max(160, Math.round(w / zoom)), Math.max(110, Math.round(h / zoom)), ctx.options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined)));
      } else {
        box.classList.add('fv-grid-shape');
        if (o.fill) {
          box.style.background = o.fill;
          box.style.color = contrastColor(o.fill);
        }
        if (o.stroke) box.style.border = `1px solid ${o.stroke}`;
        if (o.shape === 'ellipse') box.style.borderRadius = '50%';
        else if (o.shape === 'round') box.style.borderRadius = '12px';
        if (o.text) box.textContent = o.text;
      }
      frag.appendChild(box);
    }
    objectLayer.replaceChildren(frag);
  }

  const schedule = () => {
    if (!frame && !destroyed) frame = requestAnimationFrame(render);
  };

  const onClick = (event: Event) => {
    const target = (event.target as HTMLElement).closest?.('.fv-grid-cell') as HTMLElement | null;
    if (!target) {
      selected = null;
      detail.hidden = true;
    } else {
      const row = Number(target.dataset.r);
      const col = Number(target.dataset.c);
      selected = { row, col };
      const text = el('span', 'fv-grid-detail-text', cellText(row, col) ?? '');
      const note = meta.notes?.[`${row}:${col}`];
      if (note) text.appendChild(el('span', 'fv-grid-detail-note', note));
      detail.replaceChildren(el('span', 'fv-grid-detail-ref', `${columnName(meta.colLabels?.[col] ?? col)}${(meta.rowLabels?.[row] ?? row) + 1}`), text);
      detail.hidden = false;
    }
    lastKey = '';
    schedule();
  };

  const renderTabs = () => {
    tabs.hidden = source.sheets.length < 2;
    if (tabs.hidden) return;
    tabs.replaceChildren(
      ...source.sheets.map((name, i) => {
        const tab = el('button', 'fv-tab', name || `${i + 1}`);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(i === activeSheet));
        if (i === activeSheet) tab.classList.add('fv-tab-active');
        tab.addEventListener('click', () => void selectSheet(i));
        return tab;
      }),
    );
  };

  const selectSheet = async (index: number) => {
    if (index === activeSheet || destroyed) return;
    const ticket = ++switching;
    activeSheet = index;
    renderTabs();
    let next: TableMeta;
    try {
      next = await source.selectSheet(index);
    } catch {
      return;
    }
    if (destroyed || ticket !== switching) return;
    meta = next;
    generation++;
    cache.clear();
    loading.clear();
    selected = null;
    detail.hidden = true;
    zoom = clamp(zoom, 0.6, maxZoom());
    layout();
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
    rowsLayer.replaceChildren();
    mergeLayer.replaceChildren();
    render();
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  body.addEventListener('click', onClick);
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(scroller);

  const setZoom = (next: number) => {
    const anchorRow = clamp(rowAt(scroller.scrollTop), 0, Math.max(0, meta.rowCount - 1));
    const anchorPart = meta.rowCount ? (scroller.scrollTop - rowTop(anchorRow)) / Math.max(1, rowHeightAt(anchorRow)) : 0;
    const total = colX[meta.columnCount];
    const leftRatio = total > 0 ? scroller.scrollLeft / total : 0;
    zoom = clamp(next, 0.6, maxZoom());
    layout();
    scroller.scrollTop = meta.rowCount ? rowTop(anchorRow) + anchorPart * rowHeightAt(anchorRow) : 0;
    scroller.scrollLeft = leftRatio * colX[meta.columnCount];
    schedule();
  };

  renderTabs();
  layout();
  render();

  return {
    zoomIn: () => setZoom(zoom * 1.15),
    zoomBy: (factor) => setZoom(zoom * factor),
    zoomOut: () => setZoom(zoom / 1.15),
    zoomReset: () => setZoom(1),
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
      scroller.removeEventListener('scroll', schedule);
      body.removeEventListener('click', onClick);
      root.remove();
      source.dispose();
    },
  };
}
