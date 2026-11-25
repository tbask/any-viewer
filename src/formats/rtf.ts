/**
 * Reader of RTF (Rich Text Format).
 * The format is text with control words (\b, \par, \cell, …) and groups in braces.
 * Supported: emphasis, text size and colour, alignment and indents, tables, embedded
 * PNG/JPEG pictures and metafiles, code pages and Unicode, fields (the result is shown),
 * headers/footers, footnotes, comments and text box text. Hidden text and text deleted with change tracking
 * are not output, as in Word itself.
 * Not supported: styles from the style sheet (except headings), shape outlines with curves.
 */
import type { SlideShape } from '../core/slidemodel';
import { blocksToParas, CanvasGroup } from './drawingml';
import { LEGACY_SHAPE_TYPES } from './shape-types';
import { metafileImage } from '../core/metafile';
import { appendPart, applyCellEdges, compactRunStyle, hasVisibleContent, prefixNote, type Block, type DocPartLabels, type DocImage, type DocModel, type Inline, type ParaStyle, type RunStyle, type TableCell, type TableRow } from '../core/docmodel';
import type { DocOptions } from './documents';
import { isSymbolFont, symbolChar } from '../core/symbols';

const CHARSETS: Record<number, string> = {
  0: 'windows-1252', 1: 'windows-1252', 2: 'windows-1252', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5',
  161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256',
  186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250',
};

/** Groups whose content is not document text. */
const SKIP_DESTINATIONS = new Set([
  'info', 'headerl', 'footerl',
  'objdata', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'generator', 'listtable',
  'listoverridetable', 'rsidtbl', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'fldinst', 'nonshppict', 'bkmkstart',
  'bkmkend', 'revtbl', 'filetbl', 'private', 'comment', 'template', 'operator', 'author', 'title', 'subject', 'keywords',
  'atnid', 'atrfstart', 'atrfend', 'nonesttables', 'pn', 'pnseclvl', 'wgrffmtfilter', 'defchp', 'defpap', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc',
]);

const SPECIAL_CHARS: Record<string, string> = {
  emdash: '—', endash: '–', emspace: ' ', enspace: ' ', qmspace: ' ', bullet: '•',
  lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', '~': ' ', _: '‑',
};

type Destination = 'normal' | 'skip' | 'nestprops' | 'fonttbl' | 'colortbl' | 'pict' | 'stylesheet' | 'shape' | 'author' | 'sn' | 'sv';

/** Document parts collected separately from the main text. */
type SideKind = 'header' | 'headerf' | 'footer' | 'footerf' | 'footnote' | 'endnote' | 'comment' | 'box';
const SIDE_WORDS: Record<string, SideKind> = {
  header: 'header', headerr: 'header', headerf: 'headerf', footer: 'footer', footerr: 'footer', footerf: 'footerf',
  footnote: 'footnote', annotation: 'comment', shptxt: 'box',
};

interface State {
  dest: Destination;
  rs: RunStyle;
  para: ParaStyle;
  font: number;
  uc: number;
  inTable: boolean;
  /** The group that started a separate document part, and the nesting depth at that moment. */
  side?: { kind: SideKind; depth: number; restore: () => void; mark: string };
}

const decoders = new Map<string, TextDecoder>();
function decoder(name: string): TextDecoder {
  let d = decoders.get(name);
  if (!d) {
    try {
      d = new TextDecoder(name);
    } catch {
      d = new TextDecoder('windows-1252');
    }
    decoders.set(name, d);
  }
  return d;
}

const hexValue = (c: number): number => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1);

export function parseRtf(data: Uint8Array, options: DocOptions = {}): DocModel {
  if (data.length < 6 || data[0] !== 0x7b || data[1] !== 0x5c || data[2] !== 0x72 || data[3] !== 0x74 || data[4] !== 0x66) {
    throw new Error('The file is not an RTF document');
  }
  const model: DocModel = { blocks: [], images: {} };
  let defaultCodepage = options.fallbackEncoding ?? 'windows-1251';
  const fontCharsets = new Map<number, string>();
  /** Font names by number: needed to map characters of symbol fonts and to keep the typeface. */
  const fontNames = new Map<number, string>();
  let fontNameBytes: number[] = [];
  // --- nested table (a table inside a cell) ---
  let nestBase: number | undefined;
  let nestCellStart = 0;
  let nestRowCells: TableCell[] = [];
  let nestRows: TableRow[] = [];
  // --- paragraph properties that need several control words ---
  let borderSides = 0;
  let borderTarget: 'para' | 'cell' | '' = '';
  let tabAlign: 'right' | 'center' | 'decimal' | undefined;
  let tabLeader: string | undefined;
  let dropCapLines = 0;
  let pendingDropCap: { lines: number; runs: Inline[] } | undefined;
  let cellVerts: ('tb' | 'bt' | undefined)[] = [];
  let pendingVert: 'tb' | 'bt' | undefined;
  let cellAligns: ('middle' | 'bottom' | undefined)[] = [];
  let pendingAlign: 'middle' | 'bottom' | undefined;
  let rowHeight = 0;
  const colors: (string | undefined)[] = [];
  let color = { r: -1, g: -1, b: -1 };

  let state: State = { dest: 'normal', rs: {}, para: {}, font: -1, uc: 1, inTable: false };
  const stack: State[] = [];

  let runs: Inline[] = [];
  let pendingBytes: number[] = [];
  let skipChars = 0; // how many "fallback" characters to skip after \uN

  // The table is assembled as \cell and \row appear.
  let cellBlocks: Block[] = [];
  let rowCells: TableCell[] = [];
  let tableRows: TableRow[] = [];
  let cellFills: (string | undefined)[] = [];
  let pendingFill: string | undefined;
  let cellEdges: number[] = [];
  let rowEdges: (number[] | undefined)[] = [];
  let pageBreakBefore = false;

  // The style sheet is needed for one thing only: to learn which styles are headings.
  const headingStyles = new Map<number, number>();
  let styleNumber = 0;
  let styleNameBytes: number[] = [];

  // Picture.
  let pictHex: number[] = [];
  let pictType = '';
  let pictW = 0;
  let pictH = 0;
  let pictScaleX = 1;
  let pictScaleY = 1;
  let imageCount = 0;

  // Separate document parts: headers/footers, footnotes, comments, text boxes.
  const sides: Record<'header' | 'headerf' | 'footer' | 'footerf' | 'footnote' | 'endnote' | 'comment', Block[]> = { header: [], headerf: [], footer: [], footerf: [], footnote: [], endnote: [], comment: [] };
  let pendingBoxes: Block[] = [];
  // The shape being parsed: frame in twips and "name → value" properties.
  interface ShapeInfo { box: number[]; props: Map<string, string>; done: boolean }
  let shapeInfo = null as ShapeInfo | null;
  let shapeName: number[] = [];
  let shapeValue: number[] = [];
  /** A shape with an outline and a fill; blocks is its text. undefined: a plain text box without decoration. */
  let shapeGroup: CanvasGroup | null = null;
  const shapeCanvas = (blocks: Block[] | undefined): Block | undefined => {
    const info = shapeInfo;
    if (!info) return undefined;
    const prop = (name: string) => info.props.get(name);
    const type = Number(prop('shapeType') ?? 0);
    const w = Math.round((info.box[2] - info.box[0]) / 15);
    const h = Math.round((info.box[3] - info.box[1]) / 15);
    if (w < 4 || h < 4 || w > 4000 || h > 4000 || type === 75 || type === 202 || prop('gtextUNICODE') !== undefined) return undefined;
    const color = (value: string | undefined): string | undefined => {
      const n = Number(value);
      if (value === undefined || !Number.isFinite(n) || n < 0 || n > 0xffffff) return undefined;
      return `#${((1 << 24) | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)).toString(16).slice(1)}`;
    };
    const shape: SlideShape = { x: 0, y: 0, w, h };
    if (prop('fFilled') !== '0') shape.fill = color(prop('fillColor')) ?? '#ffffff';
    if (prop('fLine') !== '0') {
      shape.stroke = color(prop('lineColor')) ?? '#000000';
      const width = Number(prop('lineWidth'));
      if (width > 0) shape.strokeWidth = Math.max(1, width / 9525);
    }
    if (type === 3) shape.shape = 'ellipse';
    else if (type === 2) shape.shape = 'round';
    else if (LEGACY_SHAPE_TYPES[type]) shape.geom = LEGACY_SHAPE_TYPES[type];
    else if (prop('pVerticies')) {
      // Freeform outline: "size;count;(x,y);…" in shape geometry units; treated as a polyline.
      const points = [...prop('pVerticies')!.matchAll(/\((-?\d+),(-?\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      const gl = Number(prop('geoLeft') ?? 0);
      const gt = Number(prop('geoTop') ?? 0);
      const gw = Number(prop('geoRight') ?? 21600) - gl || 21600;
      const gh = Number(prop('geoBottom') ?? 21600) - gt || 21600;
      if (points.length >= 3 && points.length <= 2000) {
        const path: (string | number)[] = [];
        points.forEach(([x, y], i) => path.push(i ? 'L' : 'M', (x - gl) / gw, (y - gt) / gh));
        path.push('Z');
        // Curves in the segment description cannot be rendered as a polyline: such an outline is not drawn.
        const curved = [...(prop('pSegmentInfo') ?? '').matchAll(/;(\d+)/g)].slice(1).some((m) => Number(m[1]) >> 13 === 1);
        if (!curved) shape.path = path;
      }
    }
    const rotation = Number(prop('rotation'));
    if (rotation) shape.rot = rotation / 65536;
    if (blocks) {
      const paras = blocksToParas(blocks);
      if (!paras) return undefined;
      shape.paras = paras;
      shape.anchor = prop('anchorText') === '1' || prop('anchorText') === '4' ? 'middle' : prop('anchorText') === '2' || prop('anchorText') === '5' ? 'bottom' : 'top';
    }
    // A simple frame with text stays a regular text box.
    if (!shape.geom && !shape.shape && !shape.path && (!shape.fill || shape.fill === '#ffffff') && blocks) return undefined;
    if (!shape.fill && !shape.stroke) return undefined;
    // Shapes of one paragraph share a canvas, keeping their relative positions.
    const x = info.box[0] / 15;
    const y = info.box[1] / 15;
    if (shapeGroup && pendingBoxes[pendingBoxes.length - 1] === shapeGroup.block && shapeGroup.add(shape, x, y)) return shapeGroup.block;
    shapeGroup = new CanvasGroup();
    shapeGroup.add(shape, x, y);
    return shapeGroup.block;
  };
  let noteCounter = 0;
  let commentCounter = 0;
  let titlePage = false;
  let authorBytes: number[] = [];
  let lastAuthor = '';

  const enterSide = (kind: SideKind) => {
    flushBytes();
    const saved = { blocks: model.blocks, runs, cellBlocks, rowCells, tableRows, cellFills, pendingFill, cellEdges, rowEdges, pageBreakBefore, pendingBoxes };
    model.blocks = [];
    runs = [];
    cellBlocks = [];
    rowCells = [];
    tableRows = [];
    cellFills = [];
    pendingFill = undefined;
    cellEdges = [];
    rowEdges = [];
    pageBreakBefore = false;
    pendingBoxes = [];
    state.dest = 'normal';
    state.rs = {};
    state.para = {};
    state.inTable = false;
    state.side = {
      kind,
      depth: stack.length,
      mark: kind === 'comment' ? `[${commentCounter}]${lastAuthor ? ` ${lastAuthor}:` : ''}` : String(noteCounter),
      restore: () => {
        model.blocks = saved.blocks;
        ({ runs, cellBlocks, rowCells, tableRows, cellFills, pendingFill, cellEdges, rowEdges, pageBreakBefore, pendingBoxes } = saved);
      },
    };
  };

  const leaveSide = (side: NonNullable<State['side']>) => {
    endParagraph();
    if (rowCells.length || cellBlocks.length) endRow();
    flushTable();
    const collected = model.blocks;
    side.restore();
    if (!hasVisibleContent(collected)) return;
    if (side.kind === 'box') {
      const canvas = shapeCanvas(collected);
      if (shapeInfo) shapeInfo.done = true;
      if (!canvas) pendingBoxes.push({ k: 'table', rows: [{ cells: [{ blocks: collected }] }] });
      else if (pendingBoxes[pendingBoxes.length - 1] !== canvas) pendingBoxes.push(canvas);
    }
    else if (side.kind === 'footnote' || side.kind === 'endnote' || side.kind === 'comment') sides[side.kind].push(...(side.kind === 'comment' ? prefixNote(collected, side.mark) : collected));
    // Headers/footers repeat in every section; show the first non-empty one.
    else if (!sides[side.kind].length) sides[side.kind] = collected;
  };

  const flushBytes = () => {
    if (!pendingBytes.length) return;
    const cp = fontCharsets.get(state.font) ?? defaultCodepage;
    appendText(decoder(cp).decode(new Uint8Array(pendingBytes)));
    pendingBytes = [];
  };

  const appendText = (text: string) => {
    if (!text || state.dest !== 'normal' || state.rs.hide) return;
    const { hide: _hide, ...visible } = state.rs;
    const s = compactRunStyle(visible);
    const last = runs[runs.length - 1];
    if (last && last.k === 'text' && JSON.stringify(last.s) === JSON.stringify(s)) last.text += text;
    else runs.push({ k: 'text', text, s });
  };

  const flushTable = () => {
    if (rowCells.length) {
      tableRows.push({ cells: rowCells });
      rowEdges.push(cellEdges.length ? cellEdges.slice() : undefined);
      rowCells = [];
    }
    if (tableRows.length) {
      const widths = applyCellEdges(tableRows, rowEdges);
      model.blocks.push({ k: 'table', rows: tableRows, widths });
      tableRows = [];
      rowEdges = [];
    }
    cellBlocks = [];
  };

  /** Closes a nested table: it becomes a block of the cell that contains it. */
  const flushNested = () => {
    if (nestBase === undefined) return;
    if (nestRowCells.length) nestRows.push({ cells: nestRowCells });
    // Paragraphs that were not closed by \nestcell stay where they are, after the table.
    if (nestRows.length) cellBlocks.splice(Math.min(nestBase, cellBlocks.length), 0, { k: 'table', rows: nestRows });
    nestBase = undefined;
    nestRowCells = [];
    nestRows = [];
  };

  const endParagraph = (force = false) => {
    flushBytes();
    if (!runs.length && !force) return;
    if (dropCapLines && runs.length && runs.every((r) => r.k === 'text')) {
      // A drop cap is a framed paragraph of its own: its letters start the next paragraph.
      pendingDropCap = { lines: dropCapLines, runs };
      runs = [];
      return;
    }
    const block: Block = { k: 'p', runs };
    if (Object.keys(state.para).length) block.s = { ...state.para };
    if (pendingDropCap && runs.length) {
      const cap = pendingDropCap;
      pendingDropCap = undefined;
      const text = cap.runs.map((r) => (r.k === 'text' ? r.text : '')).join('');
      const first = runs[0];
      if (first.k === 'text') {
        runs[0] = { ...first, text: text + first.text };
        block.s = { ...block.s, dropCap: { lines: cap.lines, chars: text.length } };
      } else runs.unshift(...cap.runs);
    }
    runs = [];
    if (state.inTable) {
      cellBlocks.push(block);
    } else {
      flushTable();
      if (pageBreakBefore) model.blocks.push({ k: 'pagebreak' });
      model.blocks.push(block);
    }
    if (pendingBoxes.length) {
      (state.inTable ? cellBlocks : model.blocks).push(...pendingBoxes);
      pendingBoxes = [];
    }
    pageBreakBefore = false;
  };

  const endCell = () => {
    endParagraph();
    flushNested();
    const cell: TableCell = { blocks: cellBlocks };
    const fill = cellFills[rowCells.length];
    if (fill) cell.bg = fill;
    const vert = cellVerts[rowCells.length];
    if (vert) cell.vert = vert;
    const align = cellAligns[rowCells.length];
    if (align) cell.va = align;
    rowCells.push(cell);
    cellBlocks = [];
  };

  const endRow = () => {
    if (runs.length || cellBlocks.length) endCell();
    if (rowCells.length) {
      tableRows.push(rowHeight ? { cells: rowCells, h: rowHeight } : { cells: rowCells });
      rowEdges.push(cellEdges.length ? cellEdges.slice() : undefined);
    }
    rowCells = [];
  };

  const finishPicture = () => {
    if (!pictHex.length || !pictType) return;
    const id = `rtf-image-${++imageCount}`;
    const bytes = new Uint8Array(pictHex);
    const image: DocImage | undefined = pictType === 'metafile' ? metafileImage(bytes) : { mime: pictType, data: bytes.buffer as ArrayBuffer };
    if (!image) {
      imageCount--;
      return;
    }
    model.images[id] = image;
    // The picture belongs to the text around the \pict group.
    const target = stack.length ? stack[stack.length - 1] : state;
    if (target.dest === 'normal') runs.push({ k: 'img', id, w: pictW ? Math.round((pictW * pictScaleX) / 15) : undefined, h: pictH ? Math.round((pictH * pictScaleY) / 15) : undefined });
  };

  const control = (word: string, param: number | undefined) => {
    const st = state;
    // --- group destination change ---
    if (word === 'fonttbl') return void (st.dest = 'fonttbl');
    if (word === 'colortbl') return void (st.dest = 'colortbl');
    if (word === 'stylesheet') return void (st.dest = 'stylesheet');
    if (st.dest === 'stylesheet') {
      if (word === 's' && param !== undefined) styleNumber = param;
      return;
    }
    if (word === 'pict') {
      if (st.dest === 'normal') {
        flushBytes();
        st.dest = 'pict';
        pictHex = [];
        pictType = '';
        pictW = 0;
        pictH = 0;
        pictScaleX = 1;
        pictScaleY = 1;
      } else {
        st.dest = 'skip';
      }
      return;
    }
    if (SKIP_DESTINATIONS.has(word)) return void (st.dest = 'skip');
    if (word === 'shpinst') {
      if (st.dest === 'normal') shapeInfo = { box: [0, 0, 0, 0], props: new Map(), done: false };
      return void (st.dest = st.dest === 'normal' || st.dest === 'shape' ? 'shape' : 'skip');
    }
    if (st.dest === 'shape' && shapeInfo) {
      const side = word === 'shpleft' ? 0 : word === 'shptop' ? 1 : word === 'shpright' ? 2 : word === 'shpbottom' ? 3 : -1;
      if (side >= 0 && param !== undefined) shapeInfo.box[side] = param;
      else if (word === 'sn') {
        shapeName = [];
        return void (st.dest = 'sn');
      } else if (word === 'sv') {
        shapeValue = [];
        return void (st.dest = 'sv');
      }
    }
    if (st.dest === 'sn' || st.dest === 'sv') return;
    if (word === 'atnauthor') {
      authorBytes = [];
      return void (st.dest = 'author');
    }
    const sideKind = SIDE_WORDS[word];
    if (sideKind) {
      // A text box lives inside the shape description, the other parts in the main text.
      if (sideKind === 'box' ? st.dest === 'shape' : st.dest === 'normal' && !st.side) enterSide(sideKind);
      else st.dest = 'skip';
      return;
    }
    if (st.dest === 'shape' || st.dest === 'author') return;

    if (st.dest === 'nestprops') {
      // Properties of a nested row: only its end matters here; the cell edges belong to the nested table.
      if (word === 'nestrow') {
        if (nestRowCells.length) nestRows.push({ cells: nestRowCells });
        nestRowCells = [];
      }
      return;
    }
    if (st.dest === 'fonttbl') {
      if (word === 'f' && param !== undefined) {
        st.font = param;
        fontNameBytes = [];
      }
      else if (word === 'fcharset' && param !== undefined && CHARSETS[param]) fontCharsets.set(st.font, CHARSETS[param]);
      return;
    }
    if (st.dest === 'colortbl') {
      if (word === 'red') color.r = param ?? 0;
      else if (word === 'green') color.g = param ?? 0;
      else if (word === 'blue') color.b = param ?? 0;
      return;
    }
    if (st.dest === 'pict') {
      if (word === 'pngblip') pictType = 'image/png';
      else if (word === 'jpegblip') pictType = 'image/jpeg';
      else if (word === 'emfblip' || word === 'wmetafile') pictType = 'metafile';
      else if (word === 'picwgoal') pictW = param ?? 0;
      else if (word === 'pichgoal') pictH = param ?? 0;
      else if (word === 'picscalex' && param) pictScaleX = param / 100;
      else if (word === 'picscaley' && param) pictScaleY = param / 100;
      return;
    }
    if (st.dest === 'skip') return;
    if (word === 'nesttableprops') return void (st.dest = 'nestprops');

    const flag = (): 0 | 1 => (param === 0 ? 0 : 1);
    switch (word) {
      case 'ansicpg':
        if (param) defaultCodepage = param === 10007 ? 'x-mac-cyrillic' : param === 866 ? 'ibm866' : param === 65001 ? 'utf-8' : `windows-${param}`;
        break;
      case 'uc':
        st.uc = param ?? 1;
        break;
      case 'v':
        flushBytes();
        st.rs = { ...st.rs, hide: flag() };
        break;
      case 'deleted':
        // Text deleted with change tracking: it is absent from the final document.
        flushBytes();
        st.rs = { ...st.rs, hide: flag() };
        break;
      case 'titlepg':
        titlePage = true;
        break;
      case 'ftnalt':
        if (st.side?.kind === 'footnote') for (const s of [st, ...stack]) if (s.side) s.side.kind = 'endnote';
        break;
      case 'chftn':
        flushBytes();
        // Footnote mark: the next number in the text, its own number inside the footnote.
        appendText(st.side ? st.side.mark : String(++noteCounter));
        break;
      case 'chatn':
        flushBytes();
        if (st.side) appendText('');
        else appendText(`[${++commentCounter}]`);
        break;
      case 'u': {
        flushBytes();
        let code = param ?? 0;
        if (code < 0) code += 65536;
        // Symbol/Wingdings font characters lie in the private use area and are invisible without the font;
        // in practice these are almost always list bullets.
        appendText(code >= 0xf000 && code <= 0xf0ff ? symbolChar(fontNames.get(st.font) ?? 'Symbol', String.fromCharCode(code)) : String.fromCharCode(code));
        skipChars = st.uc;
        break;
      }
      case 'par':
        endParagraph(true);
        break;
      case 'sect':
        endParagraph();
        break;
      case 'line':
        flushBytes();
        runs.push({ k: 'br' });
        break;
      case 'tab':
        flushBytes();
        runs.push({ k: 'tab' });
        break;
      case 'page':
        endParagraph();
        if (!st.inTable) {
          flushTable();
          model.blocks.push({ k: 'pagebreak' });
        }
        break;
      case 'pard':
        flushBytes();
        st.para = {};
        st.inTable = false;
        pageBreakBefore = false;
        borderSides = 0;
        borderTarget = '';
        dropCapLines = 0;
        break;
      case 'itap':
        if ((param ?? 0) >= 2) {
          if (nestBase === undefined) {
            endParagraph();
            nestBase = cellBlocks.length;
            nestCellStart = nestBase;
          }
        } else if (nestBase !== undefined) {
          endParagraph();
          flushNested();
        }
        break;
      case 'nestcell': {
        st.inTable = true;
        endParagraph();
        if (nestBase === undefined) break;
        nestRowCells.push({ blocks: cellBlocks.splice(Math.min(nestCellStart, cellBlocks.length)) });
        nestCellStart = cellBlocks.length;
        break;
      }
      case 'nestrow':
        if (nestRowCells.length) nestRows.push({ cells: nestRowCells });
        nestRowCells = [];
        break;
      case 'brdrt':
      case 'brdrb':
      case 'brdrl':
      case 'brdrr':
      case 'box':
        borderTarget = 'para';
        borderSides += word === 'box' ? 4 : 1;
        if (borderSides >= 3 && !st.para.border) st.para = { ...st.para, border: '#404040' };
        break;
      case 'clbrdrt':
      case 'clbrdrb':
      case 'clbrdrl':
      case 'clbrdrr':
      case 'trbrdrt':
      case 'trbrdrb':
      case 'trbrdrl':
      case 'trbrdrr':
      case 'trbrdrh':
      case 'trbrdrv':
        borderTarget = 'cell';
        break;
      case 'brdrcf':
        if (borderTarget === 'para' && param && colors[param] && st.para.border) st.para = { ...st.para, border: colors[param] };
        break;
      case 'cbpat':
        if (param && colors[param]) st.para = { ...st.para, bg: colors[param] };
        break;
      case 'tqr':
        tabAlign = 'right';
        break;
      case 'tqc':
        tabAlign = 'center';
        break;
      case 'tqdec':
        tabAlign = 'decimal';
        break;
      case 'tldot':
      case 'tlmdot':
        tabLeader = '.';
        break;
      case 'tlhyph':
        tabLeader = '-';
        break;
      case 'tlul':
      case 'tlth':
        tabLeader = '_';
        break;
      case 'tx':
        if (param) st.para = { ...st.para, tabs: [...(st.para.tabs ?? []), { pos: param / 20, align: tabAlign, leader: tabLeader }] };
        tabAlign = undefined;
        tabLeader = undefined;
        break;
      case 'dropcapli':
        dropCapLines = param ?? 3;
        break;
      case 'scaps':
        flushBytes();
        st.rs = { ...st.rs, caps: flag() ? 'small' : '' };
        break;
      case 'caps':
        flushBytes();
        st.rs = { ...st.rs, caps: flag() ? 'all' : '' };
        break;
      case 'expnd':
        flushBytes();
        st.rs = { ...st.rs, ls: (param ?? 0) / 4 };
        break;
      case 'expndtw':
        flushBytes();
        st.rs = { ...st.rs, ls: (param ?? 0) / 20 };
        break;
      case 'charscalex':
        flushBytes();
        st.rs = { ...st.rs, scale: param && param !== 100 ? param / 100 : undefined };
        break;
      case 'shad':
      case 'embo':
      case 'impr':
        flushBytes();
        st.rs = { ...st.rs, shadow: flag() };
        break;
      case 'outl':
        flushBytes();
        st.rs = { ...st.rs, outline: flag() ? '#404040' : undefined };
        break;
      case 'striked':
        flushBytes();
        st.rs = { ...st.rs, ds: flag() };
        break;
      case 'cltxbtlr':
        pendingVert = 'bt';
        break;
      case 'cltxtbrl':
      case 'cltxtbrlv':
        pendingVert = 'tb';
        break;
      case 'clvertalc':
        pendingAlign = 'middle';
        break;
      case 'clvertalb':
        pendingAlign = 'bottom';
        break;
      case 'trrh':
        rowHeight = Math.abs(param ?? 0) / 20;
        break;
      case 'pagebb':
        pageBreakBefore = true;
        break;
      case 's': {
        const level = param !== undefined ? headingStyles.get(param) : undefined;
        if (level) st.para = { ...st.para, heading: level };
        break;
      }
      case 'plain':
        flushBytes();
        st.rs = {};
        break;
      case 'f':
        flushBytes();
        if (param !== undefined) {
          st.font = param;
          const name = fontNames.get(param);
          st.rs = { ...st.rs, font: name && !isSymbolFont(name) ? name : undefined, mono: name && /courier|consolas|mono/i.test(name) ? 1 : undefined };
        }
        break;
      case 'b':
        flushBytes();
        st.rs = { ...st.rs, b: flag() };
        break;
      case 'i':
        flushBytes();
        st.rs = { ...st.rs, i: flag() };
        break;
      case 'ul':
      case 'ulw':
        flushBytes();
        st.rs = { ...st.rs, u: flag(), ul: undefined };
        break;
      case 'uld':
      case 'uldb':
      case 'ulwave':
      case 'uldash':
      case 'uldashd':
      case 'ulth':
        flushBytes();
        st.rs = { ...st.rs, u: flag(), ul: word === 'uldb' ? 'double' : word === 'ulwave' ? 'wavy' : word === 'uld' ? 'dotted' : word === 'ulth' ? undefined : 'dashed' };
        break;
      case 'ulnone':
        flushBytes();
        st.rs = { ...st.rs, u: 0 };
        break;
      case 'strike':
        flushBytes();
        st.rs = { ...st.rs, s: flag() };
        break;
      case 'fs':
        flushBytes();
        if (param) st.rs = { ...st.rs, size: param / 2 };
        break;
      case 'cf':
        flushBytes();
        st.rs = { ...st.rs, color: param ? colors[param] ?? '' : '' };
        break;
      case 'highlight':
      case 'chcbpat':
      case 'cb':
        flushBytes();
        st.rs = { ...st.rs, bg: param ? colors[param] : undefined };
        break;
      case 'super':
        flushBytes();
        st.rs = { ...st.rs, va: 'sup' };
        break;
      case 'sub':
        flushBytes();
        st.rs = { ...st.rs, va: 'sub' };
        break;
      case 'nosupersub':
        flushBytes();
        st.rs = { ...st.rs, va: '' };
        break;
      case 'qc':
        st.para = { ...st.para, align: 'center' };
        break;
      case 'qr':
        st.para = { ...st.para, align: 'right' };
        break;
      case 'qj':
        st.para = { ...st.para, align: 'justify' };
        break;
      case 'ql':
        st.para = { ...st.para, align: 'left' };
        break;
      case 'li':
        st.para = { ...st.para, ml: (param ?? 0) / 20 };
        break;
      case 'ri':
        st.para = { ...st.para, mr: (param ?? 0) / 20 };
        break;
      case 'fi':
        st.para = { ...st.para, ti: (param ?? 0) / 20 };
        break;
      case 'sb':
        st.para = { ...st.para, mt: (param ?? 0) / 20 };
        break;
      case 'sa':
        st.para = { ...st.para, mb: (param ?? 0) / 20 };
        break;
      case 'outlinelevel':
        if (param !== undefined && param < 6) st.para = { ...st.para, heading: param + 1 };
        break;
      case 'intbl':
        st.inTable = true;
        break;
      case 'trowd':
        cellFills = [];
        cellEdges = [];
        pendingFill = undefined;
        cellVerts = [];
        cellAligns = [];
        pendingVert = undefined;
        pendingAlign = undefined;
        rowHeight = 0;
        break;
      case 'clcbpat':
        pendingFill = param ? colors[param] : undefined;
        break;
      case 'cellx':
        cellFills.push(pendingFill);
        cellEdges.push(param ?? 0);
        cellVerts.push(pendingVert);
        cellAligns.push(pendingAlign);
        pendingFill = undefined;
        pendingVert = undefined;
        pendingAlign = undefined;
        break;
      case 'cell':
        st.inTable = true;
        endCell();
        break;
      case 'row':
        endRow();
        break;
      default: {
        const special = SPECIAL_CHARS[word];
        if (special) {
          flushBytes();
          appendText(special);
        }
      }
    }
  };

  const n = data.length;
  let i = 0;
  while (i < n) {
    const c = data[i];
    if (c === 0x7b /* { */) {
      flushBytes();
      stack.push(state);
      state = { ...state, rs: state.rs, para: state.para };
      i++;
    } else if (c === 0x7d /* } */) {
      flushBytes();
      const closing = state;
      if (closing.side && closing.side.depth === stack.length) {
        leaveSide(closing.side);
        state = stack.pop()!;
        i++;
        continue;
      }
      const openShape = shapeInfo as ShapeInfo | null;
      if (closing.dest === 'sv' && stack[stack.length - 1]?.dest !== 'sv' && openShape && openShape.props.size < 400) {
        openShape.props.set(String.fromCharCode(...shapeName).trim(), String.fromCharCode(...shapeValue).trim());
      }
      if (closing.dest === 'shape' && stack[stack.length - 1]?.dest === 'normal' && openShape) {
        // A shape without text: draw the shape itself.
        if (!openShape.done) {
          const canvas = shapeCanvas(undefined);
          if (canvas && pendingBoxes[pendingBoxes.length - 1] !== canvas) pendingBoxes.push(canvas);
        }
        shapeInfo = null;
      }
      if (closing.dest === 'author' && stack[stack.length - 1]?.dest !== 'author') lastAuthor = decoder(defaultCodepage).decode(new Uint8Array(authorBytes)).trim();
      if (closing.dest === 'pict' && (stack[stack.length - 1]?.dest ?? 'normal') !== 'pict') finishPicture();
      if (closing.dest === 'colortbl' && stack[stack.length - 1]?.dest !== 'colortbl') color = { r: -1, g: -1, b: -1 };
      if (closing.dest === 'stylesheet' && stack[stack.length - 1]?.dest === 'stylesheet') {
        // The description of one style has closed: "{\s1 ... heading 1;}".
        const name = decoder(defaultCodepage).decode(new Uint8Array(styleNameBytes)).replace(/;/g, '').trim();
        const m = /^(?:heading|заголовок)\s*(\d)$/i.exec(name);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 6) headingStyles.set(styleNumber, Number(m[1]));
        styleNameBytes = [];
        styleNumber = 0;
      }
      const prev = stack.pop();
      if (!prev) break;
      // Paragraph properties and the table flag outlive the group: in RTF they are reset by \pard, not by "}".
      state = closing.dest === 'normal' && prev.dest === 'normal' ? { ...prev, para: closing.para, inTable: closing.inTable } : prev;
      i++;
    } else if (c === 0x5c /* \ */) {
      const next = data[i + 1];
      if (next === 0x27 /* ' */) {
        const hi = hexValue(data[i + 2]);
        const lo = hexValue(data[i + 3]);
        i += 4;
        if (skipChars > 0) skipChars--;
        else if (hi >= 0 && lo >= 0 && state.dest === 'normal') pendingBytes.push(hi * 16 + lo);
        else if (hi >= 0 && lo >= 0 && state.dest === 'stylesheet') styleNameBytes.push(hi * 16 + lo);
      } else if (next === 0x5c || next === 0x7b || next === 0x7d) {
        i += 2;
        if (skipChars > 0) skipChars--;
        else if (state.dest === 'normal') pendingBytes.push(next);
      } else if (next === 0x2a /* * */) {
        // \* marks an optional group: if the next word is unknown, the group must be skipped.
        i += 2;
        let j = i;
        while (j < n && (data[j] === 0x20 || data[j] === 0x0d || data[j] === 0x0a)) j++;
        if (data[j] === 0x5c) {
          let k = j + 1;
          while (k < n && ((data[k] >= 97 && data[k] <= 122) || (data[k] >= 65 && data[k] <= 90))) k++;
          const word = String.fromCharCode(...data.subarray(j + 1, k));
          if (word !== 'shppict' && word !== 'pict' && word !== 'fldrslt' && word !== 'listtext' && word !== 'pntext' && word !== 'shpinst' && word !== 'annotation' && word !== 'atnauthor' && word !== 'nesttableprops' && !SIDE_WORDS[word]) {
            if (state.dest !== 'colortbl') state.dest = 'skip';
          }
        }
      } else if (next === 0x0a || next === 0x0d) {
        // "\" before a line break equals \par.
        i += 2;
        if (state.dest === 'normal') endParagraph(true);
      } else if ((next >= 97 && next <= 122) || (next >= 65 && next <= 90)) {
        let j = i + 1;
        while (j < n && ((data[j] >= 97 && data[j] <= 122) || (data[j] >= 65 && data[j] <= 90))) j++;
        const word = String.fromCharCode(...data.subarray(i + 1, j));
        let param: number | undefined;
        let k = j;
        if (data[k] === 0x2d) k++;
        const digitsStart = k;
        while (k < n && data[k] >= 48 && data[k] <= 57) k++;
        if (k > digitsStart) {
          param = Number(String.fromCharCode(...data.subarray(j, k)));
          j = k;
        }
        if (data[j] === 0x20) j++; // one space after a word is a delimiter, not text
        i = j;
        if (word === 'bin' && param && param > 0) {
          i += param; // binary data is skipped
        } else {
          control(word, param);
        }
      } else {
        // Control symbol: \~ \- \_ and the like.
        const special = SPECIAL_CHARS[String.fromCharCode(next)];
        i += 2;
        if (special && state.dest === 'normal') {
          flushBytes();
          appendText(special);
        }
      }
    } else if (c === 0x0d || c === 0x0a) {
      i++;
    } else {
      i++;
      if (skipChars > 0) {
        skipChars--;
      } else if (state.dest === 'normal') {
        pendingBytes.push(c);
      } else if (state.dest === 'stylesheet') {
        styleNameBytes.push(c);
      } else if (state.dest === 'fonttbl') {
        if (c === 0x3b /* ; */) {
          if (fontNameBytes.length) fontNames.set(state.font, decoder(defaultCodepage).decode(new Uint8Array(fontNameBytes)).trim().replace(/ (Cyr|CE|Greek|Tur|Baltic|\(Vietnamese\)|\(Hebrew\)|\(Arabic\))$/, ''));
          fontNameBytes = [];
        } else if (fontNameBytes.length < 80) fontNameBytes.push(c);
      } else if (state.dest === 'author') {
        authorBytes.push(c);
      } else if (state.dest === 'sn') {
        if (shapeName.length < 64) shapeName.push(c);
      } else if (state.dest === 'sv') {
        if (shapeValue.length < 8000) shapeValue.push(c);
      } else if (state.dest === 'pict') {
        const hi = hexValue(c);
        const lo = hexValue(data[i]);
        if (hi >= 0 && lo >= 0) {
          pictHex.push(hi * 16 + lo);
          i++;
        }
      } else if (state.dest === 'colortbl' && c === 0x3b /* ; */) {
        colors.push(color.r < 0 ? undefined : `#${((1 << 24) | (color.r << 16) | (Math.max(color.g, 0) << 8) | Math.max(color.b, 0)).toString(16).slice(1)}`);
        color = { r: -1, g: -1, b: -1 };
      }
    }
  }
  endParagraph();
  if (rowCells.length || cellBlocks.length) endRow();
  flushTable();
  const labels: DocPartLabels = options.labels ?? {};
  appendPart(model.blocks, labels.footnotes, sides.footnote);
  appendPart(model.blocks, labels.endnotes, sides.endnote);
  appendPart(model.blocks, labels.comments, sides.comment);
  appendPart(model.blocks, labels.footer, hasVisibleContent(sides.footer) ? sides.footer : titlePage ? sides.footerf : []);
  appendPart(model.blocks, labels.header, [...(titlePage ? sides.headerf : []), ...sides.header], true);
  return model;
}
