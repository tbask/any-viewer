/**
 * Reader of doc (the binary Word 97–2003 format).
 *
 * Text is stored in pieces (the "piece table"), formatting in separate property lists
 * bound to file offsets. Read here: text, paragraphs, headings (by built-in styles),
 * bold/italic/underline/size/colour, alignment and indents, tables, inline PNG/JPEG
 * pictures, fields (the result is shown).
 * Footnotes, comments, headers/footers and text box text are read too; hidden text and text deleted
 * with change tracking are not output, as in Word itself.
 * Not read: list numbering (items get a bullet), Word 6/95 documents.
 */
import { CfbReader } from '../core/cfb';
import { appendPart, applyCellEdges, compactRunStyle, formatCounter, hasVisibleContent, prefixNote, type DocPartLabels, sniffImageMime, type Block, type DocModel, type Inline, type ParaStyle, type RunStyle, type TableCell, type TableRow } from '../core/docmodel';
import { createDocDecryptor, PasswordError } from '../core/office-crypto';
import { blipImage, findMetafileBlip } from '../core/images';
import type { SlideShape } from '../core/slidemodel';
import { blocksToParas, CanvasGroup } from './drawingml';
import { customShapePath, LEGACY_SHAPE_TYPES } from './shape-types';
import { metafileImage } from '../core/metafile';
import type { DocOptions } from './documents';


interface Piece {
  cpStart: number;
  cpEnd: number;
  fc: number;
  compressed: boolean;
}

interface PropRun {
  fcStart: number;
  fcEnd: number;
  /** Offset and length of a property list in the WordDocument stream. */
  offset: number;
  length: number;
  istd: number;
}

interface CharProps {
  rs: RunStyle;
  /** Properties given as "opposite to the style". */
  invert: { b?: boolean; i?: boolean; s?: boolean };
  special: boolean;
  hidden: boolean;
  picLocation: number;
}

interface ParaProps {
  style: ParaStyle;
  inTable: boolean;
  rowEnd: boolean;
  list: boolean;
  level: number;
  pageBreakBefore: boolean;
  /** Cell edges of a table row (present only at the end-of-row mark). */
  edges?: number[];
}

/** The standard Word palette (sprmCIco indices). */
const ICO = ['', '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#ffff00', '#ffffff', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0'];

/** Walks the properties (sprm) in a list and calls the handler for each. */
function forEachSprm(data: Uint8Array, start: number, length: number, handler: (sprm: number, at: number, size: number) => void): void {
  let p = start;
  const end = Math.min(start + length, data.length);
  while (p + 2 <= end) {
    const sprm = data[p] | (data[p + 1] << 8);
    p += 2;
    const spra = sprm >> 13;
    let size: number;
    switch (spra) {
      case 0:
      case 1:
        size = 1;
        break;
      case 2:
      case 4:
      case 5:
        size = 2;
        break;
      case 3:
        size = 4;
        break;
      case 7:
        size = 3;
        break;
      default:
        // Variable length: usually in the first byte; for a table definition in two.
        if (sprm === 0xd608 || sprm === 0xd606) {
          size = (data[p] | (data[p + 1] << 8)) + 1;
        } else if (sprm === 0xc615) {
          size = data[p] === 255 ? end - p : data[p] + 1;
        } else {
          size = data[p] + 1;
        }
    }
    if (p + size > end) break;
    handler(sprm, p, size);
    p += size;
  }
}

function loadFkpRuns(doc: Uint8Array, table: Uint8Array, fc: number, lcb: number, isPara: boolean): PropRun[] {
  const runs: PropRun[] = [];
  if (!lcb || fc + lcb > table.length) return runs;
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  const count = Math.floor((lcb - 4) / 8);
  for (let i = 0; i < count; i++) {
    const pn = tv.getUint32(fc + (count + 1) * 4 + i * 4, true) & 0x3fffff;
    const page = pn * 512;
    if (page + 512 > doc.length) continue;
    const crun = doc[page + 511];
    for (let r = 0; r < crun; r++) {
      const fcStart = dv.getUint32(page + r * 4, true);
      const fcEnd = dv.getUint32(page + (r + 1) * 4, true);
      const bxAt = page + (crun + 1) * 4 + r * (isPara ? 13 : 1);
      const off = doc[bxAt] * 2;
      let offset = 0;
      let length = 0;
      let istd = 0;
      if (off > 0) {
        let at = page + off;
        if (isPara) {
          let cb = doc[at++];
          if (cb === 0) cb = doc[at++] * 2;
          else cb = cb * 2 - 1;
          istd = doc[at] | (doc[at + 1] << 8);
          offset = at + 2;
          length = Math.max(0, cb - 2);
        } else {
          length = doc[at];
          offset = at + 1;
        }
        if (offset + length > page + 512) length = Math.max(0, page + 512 - offset);
      }
      runs.push({ fcStart, fcEnd, offset, length, istd });
    }
  }
  return runs.sort((a, b) => a.fcStart - b.fcStart);
}

function findRun(runs: PropRun[], fc: number, hint: number): number {
  const h = runs[hint];
  if (h && fc >= h.fcStart && fc < h.fcEnd) return hint;
  const next = runs[hint + 1];
  if (next && fc >= next.fcStart && fc < next.fcEnd) return hint + 1;
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fc < runs[mid].fcStart) hi = mid - 1;
    else if (fc >= runs[mid].fcEnd) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export async function parseDoc(blob: Blob, options: DocOptions = {}): Promise<DocModel> {
  const cfb = await CfbReader.open(blob);
  const docEntry = cfb.find('WordDocument');
  if (!docEntry) throw new Error('The file has no Word document');
  let doc = cfb.read(docEntry);
  let dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  if (doc.length < 512) throw new Error('The document is corrupt');
  const ident = dv.getUint16(0, true);
  const nFib = dv.getUint16(2, true);
  if (ident !== 0xa5ec || nFib < 193) throw new Error('Word 6/95 and earlier documents are not supported');
  const flags = dv.getUint16(10, true);
  const tableEntry = cfb.find(flags & 0x0200 ? '1Table' : '0Table') ?? cfb.find('1Table', '0Table');
  if (!tableEntry) throw new Error('The document is corrupt: no table stream');
  let table = cfb.read(tableEntry);
  const dataEntry = cfb.find('Data');
  let dataStream = dataEntry ? cfb.read(dataEntry) : undefined;
  if (flags & 0x0100) {
    // The document is encrypted. Plain XOR obfuscation (bit 0x8000) is the Word 95 method and is not supported.
    if (flags & 0x8000) throw new PasswordError('unsupported');
    const headerLength = dv.getUint32(14, true);
    const decrypt = createDocDecryptor(table.subarray(0, headerLength), options.password);
    doc = decrypt(doc, 68);
    dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
    table = decrypt(table, headerLength);
    if (dataStream) dataStream = decrypt(dataStream, 0);
  }
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);

  const ccpText = dv.getInt32(76, true);
  const pair = (index: number) => ({ fc: dv.getUint32(154 + index * 8, true), lcb: dv.getUint32(158 + index * 8, true) });
  const chpxInfo = pair(12);
  const papxInfo = pair(13);
  const clx = pair(33);

  // --- text piece table ---
  const pieces: Piece[] = [];
  let p = clx.fc;
  const clxEnd = Math.min(clx.fc + clx.lcb, table.length);
  while (p < clxEnd) {
    const type = table[p];
    if (type === 1) {
      p += 3 + tv.getUint16(p + 1, true);
    } else if (type === 2) {
      const lcb = tv.getUint32(p + 1, true);
      const start = p + 5;
      const count = Math.floor((lcb - 4) / 12);
      for (let i = 0; i < count; i++) {
        const cpStart = tv.getUint32(start + i * 4, true);
        const cpEnd = tv.getUint32(start + (i + 1) * 4, true);
        const fcRaw = tv.getUint32(start + (count + 1) * 4 + i * 8 + 2, true);
        const compressed = (fcRaw & 0x40000000) !== 0;
        const fc = compressed ? (fcRaw & 0x3fffffff) >> 1 : fcRaw & 0x3fffffff;
        pieces.push({ cpStart, cpEnd, fc, compressed });
      }
      break;
    } else {
      break;
    }
  }
  if (!pieces.length) throw new Error('The document is corrupt: no text found');

  const chpx = loadFkpRuns(doc, table, chpxInfo.fc, chpxInfo.lcb, false);
  const papx = loadFkpRuns(doc, table, papxInfo.fc, papxInfo.lcb, true);

  /** Applies character properties from the sprm list in buf to out. */
  const applyCharSprms = (buf: Uint8Array, offset: number, length: number, out: CharProps): void => {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // 0: off, 1: on, 0x80: as in the style, 0x81: opposite to the style.
    const toggle = (at: number, key: 'b' | 'i' | 's') => {
      const v = buf[at];
      if (v === 0x81) out.invert[key] = true;
      else if (v !== 0x80) out.rs[key] = v === 0 ? 0 : 1;
    };
    forEachSprm(buf, offset, length, (sprm, at) => {
      switch (sprm) {
        case 0x0835: toggle(at, 'b'); break;
        case 0x0836: toggle(at, 'i'); break;
        case 0x0837: toggle(at, 's'); break;
        case 0x2a3e: out.rs.u = buf[at] ? 1 : 0; break;
        case 0x4a43: out.rs.size = (buf[at] | (buf[at + 1] << 8)) / 2; break;
        case 0x2a48: out.rs.va = buf[at] === 1 ? 'sup' : buf[at] === 2 ? 'sub' : ''; break;
        case 0x2a42: out.rs.color = ICO[buf[at]] === '#000000' ? '' : ICO[buf[at]] ?? ''; break;
        case 0x6870: {
          const c = `#${((1 << 24) | (buf[at] << 16) | (buf[at + 1] << 8) | buf[at + 2]).toString(16).slice(1)}`;
          out.rs.color = buf[at + 3] === 0xff || c === '#000000' ? '' : c;
          break;
        }
        case 0x2a0c: out.rs.bg = buf[at] ? ICO[buf[at]] : undefined; break;
        case 0x0855: out.special = buf[at] !== 0; break;
        // Hidden text and text deleted with change tracking. 0x80: "as in the style", any other non-zero: on.
        case 0x083c:
        case 0x0800: if (buf[at] !== 0 && buf[at] !== 0x80) out.hidden = true; else if (buf[at] === 0) out.hidden = false; break;
        case 0x6a03: out.picLocation = view.getUint32(at, true); break;
      }
    });
  };

  /** Applies paragraph properties from the sprm list in buf to out. */
  const applyParaSprms = (buf: Uint8Array, offset: number, length: number, out: ParaProps): void => {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const s16 = (at: number) => view.getInt16(at, true);
    forEachSprm(buf, offset, length, (sprm, at) => {
      switch (sprm) {
        case 0x2461:
        case 0x2403: {
          const jc = buf[at];
          out.style.align = jc === 1 ? 'center' : jc === 2 ? 'right' : jc === 3 || jc === 4 ? 'justify' : 'left';
          break;
        }
        case 0x2416: out.inTable = buf[at] !== 0; break;
        case 0x2417: out.rowEnd = buf[at] !== 0; break;
        case 0x845e:
        case 0x840f: out.style.ml = s16(at) / 20; break;
        case 0x845d:
        case 0x840e: out.style.mr = s16(at) / 20; break;
        case 0x8460:
        case 0x8411: out.style.ti = s16(at) / 20; break;
        case 0xa413: out.style.mt = (buf[at] | (buf[at + 1] << 8)) / 20; break;
        case 0xa414: out.style.mb = (buf[at] | (buf[at + 1] << 8)) / 20; break;
        case 0x460b: out.list = (buf[at] | (buf[at + 1] << 8)) !== 0; break;
        case 0x260a: out.level = Math.min(buf[at], 8); break;
        case 0x2407: out.pageBreakBefore = buf[at] !== 0; break;
        case 0xd608: {
          // Table row definition: cell count and cell edges.
          const cells = buf[at + 2];
          const edges: number[] = [];
          for (let k = 1; k <= cells; k++) edges.push(view.getInt16(at + 3 + k * 2, true) - view.getInt16(at + 3, true));
          out.edges = edges;
          break;
        }
      }
    });
  };

  const newCharProps = (): CharProps => ({ rs: {}, invert: {}, special: false, hidden: false, picLocation: -1 });
  const newParaProps = (): ParaProps => ({ style: {}, inTable: false, rowEnd: false, list: false, level: 0, pageBreakBefore: false });

  // --- style sheet: font, size, colour and alignment given by the paragraph style ---
  interface StyleDef {
    sti: number;
    base: number;
    char: CharProps;
    para: ParaProps;
  }
  const styleDefs: (StyleDef | undefined)[] = [];
  const stsh = pair(1);
  if (stsh.lcb > 4 && stsh.fc + stsh.lcb <= table.length) {
    const cbStshi = tv.getUint16(stsh.fc, true);
    const cstd = tv.getUint16(stsh.fc + 2, true);
    const cbBase = tv.getUint16(stsh.fc + 4, true);
    let at = stsh.fc + 2 + cbStshi;
    const end = stsh.fc + stsh.lcb;
    for (let i = 0; i < cstd && at + 2 <= end; i++) {
      const cbStd = tv.getUint16(at, true);
      const std = at + 2;
      at = std + cbStd;
      if (cbStd < cbBase + 2 || at > end) continue;
      const sti = tv.getUint16(std, true) & 0x0fff;
      const word2 = tv.getUint16(std + 2, true);
      const kind = word2 & 0x0f; // 1: paragraph style, 2: character style
      const base = word2 >> 4;
      const cupx = tv.getUint16(std + 4, true) & 0x0f;
      // Style name: length in characters, UTF-16, terminating zero.
      let q = std + cbBase;
      q += 2 + (tv.getUint16(q, true) + 1) * 2;
      const def: StyleDef = { sti, base, char: newCharProps(), para: newParaProps() };
      for (let u = 0; u < cupx && q + 2 <= at; u++) {
        if ((q - std) & 1) q++; // property blocks are aligned to an even boundary
        const cb = tv.getUint16(q, true);
        const body = q + 2;
        if (body + cb > at) break;
        if (kind === 1 && u === 0) applyParaSprms(table, body + 2, Math.max(0, cb - 2), def.para);
        else if ((kind === 1 && u === 1) || (kind === 2 && u === 0)) applyCharSprms(table, body, cb, def.char);
        q = body + cb;
      }
      styleDefs[i] = def;
    }
  }
  const resolvedStyles = new Map<number, { rs: RunStyle; para: ParaStyle; heading?: number }>();
  const resolveStyle = (istd: number, depth = 0): { rs: RunStyle; para: ParaStyle; heading?: number } => {
    const hit = resolvedStyles.get(istd);
    if (hit) return hit;
    const def = styleDefs[istd];
    if (!def) return { rs: {}, para: {} };
    const parent = def.base !== 0x0fff && def.base !== istd && depth < 20 ? resolveStyle(def.base, depth + 1) : { rs: {}, para: {} };
    const rs: RunStyle = { ...parent.rs };
    for (const key in def.char.rs) {
      const v = (def.char.rs as Record<string, unknown>)[key];
      if (v !== undefined) (rs as Record<string, unknown>)[key] = v;
    }
    for (const key of ['b', 'i', 's'] as const) if (def.char.invert[key]) rs[key] = parent.rs[key] ? 0 : 1;
    // Built-in styles: 1–9 are "Heading 1–9", 62 is "Title".
    const heading = def.sti >= 1 && def.sti <= 6 ? def.sti : def.sti === 62 ? 1 : parent.heading;
    const out = { rs, para: { ...parent.para, ...def.para.style }, heading };
    resolvedStyles.set(istd, out);
    return out;
  };

  const charCache = new Map<number, CharProps>();
  const charProps = (run: PropRun | undefined): CharProps => {
    if (!run || !run.length) return newCharProps();
    const cached = charCache.get(run.offset);
    if (cached) return cached;
    const out = newCharProps();
    applyCharSprms(doc, run.offset, run.length, out);
    charCache.set(run.offset, out);
    return out;
  };

  const paraProps = (run: PropRun | undefined): ParaProps => {
    const out = newParaProps();
    if (!run) return out;
    const style = resolveStyle(run.istd);
    out.style = { ...style.para };
    if (style.heading) out.style.heading = style.heading;
    else if (!styleDefs.length && run.istd >= 1 && run.istd <= 6) out.style.heading = run.istd;
    applyParaSprms(doc, run.offset, run.length, out);
    return out;
  };

  /** Text formatting: the paragraph style, with the run's own properties on top. */
  const effectiveRunStyle = (cprops: CharProps, istd: number): RunStyle | undefined => {
    const base = resolveStyle(istd).rs;
    const rs: RunStyle = { ...base };
    for (const key in cprops.rs) {
      const v = (cprops.rs as Record<string, unknown>)[key];
      if (v !== undefined) (rs as Record<string, unknown>)[key] = v;
    }
    for (const key of ['b', 'i', 's'] as const) if (cprops.invert[key]) rs[key] = base[key] ? 0 : 1;
    return compactRunStyle(rs);
  };

  // --- building the model ---
  const model: DocModel = { blocks: [], images: {} };
  let runs: Inline[] = [];
  let cellBlocks: Block[] = [];
  let rowCells: TableCell[] = [];
  let tableRows: TableRow[] = [];
  let rowEdges: (number[] | undefined)[] = [];
  let fieldDepth = 0;
  const instruction: boolean[] = []; // for every nested field: whether the field code is running now (it is not shown)
  let imageCount = 0;
  let textBuf = '';
  let textStyle: RunStyle | undefined;
  let textKey = '';

  const flushText = () => {
    if (textBuf) runs.push({ k: 'text', text: textBuf, s: textStyle });
    textBuf = '';
  };
  const flushTable = () => {
    if (rowCells.length) {
      tableRows.push({ cells: rowCells });
      rowEdges.push(undefined);
    }
    if (tableRows.length) model.blocks.push({ k: 'table', rows: tableRows, widths: applyCellEdges(tableRows, rowEdges) });
    rowCells = [];
    tableRows = [];
    rowEdges = [];
    cellBlocks = [];
  };
  const makeParagraph = (pp: ParaProps): Block => {
    flushText();
    const block: Block = { k: 'p', runs };
    if (pp.list && !pp.style.heading) {
      block.marker = '•';
      block.level = pp.level;
    }
    if (Object.keys(pp.style).length) block.s = pp.style;
    runs = [];
    return block;
  };

  const addPicture = (location: number) => {
    if (!dataStream || location < 0 || location + 6 > dataStream.length) return;
    const ddv = new DataView(dataStream.buffer, dataStream.byteOffset, dataStream.byteLength);
    const lcb = ddv.getUint32(location, true);
    const header = ddv.getUint16(location + 4, true);
    const end = Math.min(location + lcb, dataStream.length);
    // The record holds a drawing container; the PNG or JPEG itself is found by signature.
    for (let i = location + header; i + 8 < end; i++) {
      const b = dataStream[i];
      const isPng = b === 0x89 && dataStream[i + 1] === 0x50 && dataStream[i + 2] === 0x4e && dataStream[i + 3] === 0x47;
      const isJpeg = b === 0xff && dataStream[i + 1] === 0xd8 && dataStream[i + 2] === 0xff;
      if (!isPng && !isJpeg) continue;
      const bytes = dataStream.slice(i, end);
      const mime = sniffImageMime(bytes);
      if (!mime) return;
      const id = `doc-image-${++imageCount}`;
      model.images[id] = { mime, data: bytes.buffer as ArrayBuffer };
      // Size: goal width and height in twips, scaled, lie in the record header.
      const wGoal = ddv.getUint16(location + 28, true);
      const hGoal = ddv.getUint16(location + 30, true);
      const mx = ddv.getUint16(location + 32, true) || 1000;
      const my = ddv.getUint16(location + 34, true) || 1000;
      const w = Math.round((wGoal * mx) / 1000 / 15);
      const h = Math.round((hGoal * my) / 1000 / 15);
      flushText();
      runs.push(w > 4 && h > 4 && w < 4000 ? { k: 'img', id, w, h } : { k: 'img', id });
      return;
    }
    // No bitmap: a metafile in the drawing record, or a bare WMF right after the header.
    const meta = findMetafileBlip(dataStream, location + header, end) ?? (ddv.getUint16(location + 6, true) === 8 ? metafileImage(dataStream.subarray(location + header, end)) : undefined);
    if (meta) {
      const id = `doc-image-${++imageCount}`;
      model.images[id] = meta;
      const w = Math.round((ddv.getUint16(location + 28, true) * (ddv.getUint16(location + 32, true) || 1000)) / 1000 / 15);
      const h = Math.round((ddv.getUint16(location + 30, true) * (ddv.getUint16(location + 34, true) || 1000)) / 1000 / 15);
      flushText();
      runs.push(w > 4 && h > 4 && w < 4000 ? { k: 'img', id, w, h } : { k: 'img', id });
    }
  };

  // --- floating drawings ---
  // The text holds an anchor character; its position gives the shape, the shape gives the picture number
  // in the shared store, and the picture data itself lies in the main document stream.
  const anchors = new Map<number, { spid: number; w: number; h: number; x: number; y: number }>();
  const spa = pair(40);
  if (spa.lcb >= 30 && spa.fc + spa.lcb <= table.length) {
    const n = Math.floor((spa.lcb - 4) / 30);
    for (let i = 0; i < n; i++) {
      const at = spa.fc + (n + 1) * 4 + i * 26;
      anchors.set(tv.getUint32(spa.fc + i * 4, true), {
        spid: tv.getUint32(at, true),
        x: Math.round(tv.getInt32(at + 4, true) / 15),
        y: Math.round(tv.getInt32(at + 8, true) / 15),
        w: Math.round((tv.getInt32(at + 12, true) - tv.getInt32(at + 4, true)) / 15),
        h: Math.round((tv.getInt32(at + 16, true) - tv.getInt32(at + 8, true)) / 15),
      });
    }
  }
  const blipOffsets: { offset: number; size: number }[] = [];
  const shapeBlip = new Map<number, number>();
  /** Shape looks by shape number: preset outline type and colours. */
  const shapeLooks = new Map<number, { type: number; fill?: string; stroke?: string; filled?: boolean; lined?: boolean; wordArt?: boolean; path?: (string | number)[] }>();
  const dgg = pair(50);
  if (anchors.size && dgg.lcb > 8 && dgg.fc + dgg.lcb <= table.length) {
    const walkArt = (start: number, end: number, depth: number): void => {
      let q = start;
      let spid = 0;
      while (q + 8 <= end) {
        const verInst = tv.getUint16(q, true);
        const type = tv.getUint16(q + 2, true);
        const len = tv.getUint32(q + 4, true);
        if (type < 0xf000 || type > 0xf200 || q + 8 + len > end) {
          q++; // a single service byte stands between drawing containers
          continue;
        }
        const body = q + 8;
        if ((verInst & 0x0f) === 0x0f && depth < 12) {
          walkArt(body, body + len, depth + 1);
        } else if (type === 0xf007 && len >= 36) {
          blipOffsets.push({ offset: tv.getUint32(body + 28, true), size: tv.getUint32(body + 20, true) });
        } else if (type === 0xf00a && len >= 4) {
          spid = tv.getUint32(body, true);
          shapeLooks.set(spid, { type: verInst >> 4 });
        } else if (type === 0xf00b) {
          const count = verInst >> 4;
          const look = shapeLooks.get(spid);
          const rgb = (value: number): string | undefined => (value >>> 24 ? undefined : `#${((1 << 24) | ((value & 0xff) << 16) | (value & 0xff00) | ((value >> 16) & 0xff)).toString(16).slice(1)}`);
          let extra = body + count * 6;
          const geo: (number | undefined)[] = [];
          let vertices: Uint8Array | undefined;
          let segments: Uint8Array | undefined;
          for (let k = 0; k < count && body + k * 6 + 6 <= body + len; k++) {
            const head = tv.getUint16(body + k * 6, true);
            const id = head & 0x3fff;
            const value = tv.getUint32(body + k * 6 + 2, true);
            if (head & 0x8000) {
              // Array data follows the property list; the length is written sometimes with the header, sometimes without.
              let size = value;
              if ((id === 325 || id === 326) && extra + 6 <= body + len) {
                const item = tv.getUint16(extra + 4, true);
                if (tv.getUint16(extra, true) * (item === 0xfff0 ? 4 : item) === value) size = value + 6;
              }
              if (extra + size <= body + len) {
                if (id === 325) vertices = table.subarray(extra, extra + size);
                else if (id === 326) segments = table.subarray(extra, extra + size);
              }
              extra += size;
              if (look && id === 192) look.wordArt = true;
              continue;
            }
            if (id >= 320 && id <= 323) geo[id - 320] = value;
            if (id === 260) shapeBlip.set(spid, value);
            else if (look && id === 385) look.fill = rgb(value);
            else if (look && id === 448) look.stroke = rgb(value);
            else if (look && id === 447 && value & 0x100000) look.filled = (value & 0x10) !== 0;
            else if (look && id === 511 && value & 0x80000) look.lined = (value & 0x08) !== 0;
          }
          if (look && vertices) look.path = customShapePath(vertices, segments, geo);
        }
        q = body + len;
      }
    };
    walkArt(dgg.fc, dgg.fc + dgg.lcb, 0);
  }
  const addFloatingPicture = (cp: number) => {
    const anchor = anchors.get(cp);
    const blip = anchor ? blipOffsets[(shapeBlip.get(anchor.spid) ?? 0) - 1] : undefined;
    if (!anchor || !blip || blip.offset + 8 > doc.length) return;
    const end = Math.min(blip.offset + 8 + dv.getUint32(blip.offset + 4, true), doc.length);
    for (let i = blip.offset + 8; i + 8 < Math.min(end, blip.offset + 200); i++) {
      const isPng = doc[i] === 0x89 && doc[i + 1] === 0x50 && doc[i + 2] === 0x4e && doc[i + 3] === 0x47;
      const isJpeg = doc[i] === 0xff && doc[i + 1] === 0xd8 && doc[i + 2] === 0xff;
      if (!isPng && !isJpeg) continue;
      const bytes = doc.slice(i, end);
      const id = `doc-image-${++imageCount}`;
      model.images[id] = { mime: isPng ? 'image/png' : 'image/jpeg', data: bytes.buffer as ArrayBuffer };
      flushText();
      runs.push(anchor.w > 4 && anchor.h > 4 ? { k: 'img', id, w: anchor.w, h: anchor.h } : { k: 'img', id });
      return;
    }
    const meta = blipImage(doc, blip.offset);
    if (meta) {
      const id = `doc-image-${++imageCount}`;
      model.images[id] = meta;
      flushText();
      runs.push(anchor.w > 4 && anchor.h > 4 ? { k: 'img', id, w: anchor.w, h: anchor.h } : { k: 'img', id });
    }
  };

  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  let chpxHint = 0;
  let papxHint = 0;

  // --- document parts that follow the main one in the common text stream: footnotes, headers/footers, comments,
  // endnotes, text boxes ---
  const ccp = [76, 80, 84, 88, 92, 96, 100].map((o) => Math.max(0, dv.getInt32(o, true)));
  const partStart = (index: number) => ccp.slice(0, index).reduce((a, b) => a + b, 0);
  /** Positions from a service table (the first count+1 four-byte numbers). */
  const plcCps = (index: number, itemSize: number): number[] => {
    const { fc, lcb } = pair(index);
    if (lcb < 8 || fc + lcb > table.length) return [];
    const n = Math.floor((lcb - 4) / (4 + itemSize));
    const out: number[] = [];
    for (let k = 0; k <= n; k++) out.push(tv.getUint32(fc + k * 4, true));
    return out;
  };
  const footnoteRefs = plcCps(2, 2).slice(0, -1);
  const endnoteRefs = plcCps(46, 2).slice(0, -1);
  // Text boxes: for each the number of its shape is known.
  const boxCps = plcCps(56, 22);
  const boxes: { from: number; to: number; spid: number; used: boolean }[] = [];
  for (let k = 0; k + 1 < boxCps.length; k++) {
    const from = boxCps[k];
    const to = boxCps[k + 1];
    if (to <= from || to > ccp[6]) break;
    boxes.push({ from, to, spid: tv.getUint32(pair(56).fc + boxCps.length * 4 + k * 22 + 14, true), used: false });
  }
  let pendingBoxes: Block[] = [];
  let noteNumber = 0;
  let commentNumber = 0;

  /** Parses a range of text positions into blocks. */
  const renderRange = (cpFrom: number, cpTo: number): Block[] => {
    const saved = { blocks: model.blocks, runs, cellBlocks, rowCells, tableRows, rowEdges, textBuf, textStyle, textKey, pendingBoxes, noteNumber, commentNumber };
    model.blocks = [];
    runs = [];
    cellBlocks = [];
    rowCells = [];
    tableRows = [];
    rowEdges = [];
    textBuf = '';
    textKey = '';
    pendingBoxes = [];
    noteNumber = 0;
    commentNumber = 0;
    walkRange(cpFrom, cpTo);
    flushText();
    if (runs.length) model.blocks.push({ k: 'p', runs });
    flushTable();
    // The last paragraph of a part is always empty: remove it.
    const tail = model.blocks[model.blocks.length - 1];
    if (tail && tail.k === 'p' && tail.runs.length === 0) model.blocks.pop();
    const result = model.blocks;
    model.blocks = saved.blocks;
    ({ runs, cellBlocks, rowCells, tableRows, rowEdges, textBuf, textStyle, textKey, pendingBoxes, noteNumber, commentNumber } = saved);
    return result;
  };

  let shapeGroup: CanvasGroup | null = null;
  const boxFor = (spid: number): void => {
    const box = boxes.find((b) => !b.used && b.spid === spid);
    if (!box) return;
    box.used = true;
    const inner = renderRange(partStart(6) + box.from, partStart(6) + box.to);
    if (!hasVisibleContent(inner)) return;
    // A shape with a preset outline or a fill is drawn on a canvas; a plain text box stays a frame with text.
    const look = shapeLooks.get(spid);
    const size = [...anchors.values()].find((a) => a.spid === spid);
    const geom = look ? LEGACY_SHAPE_TYPES[look.type] : undefined;
    const fill = look && look.filled !== false ? look.fill ?? (look.type !== 202 ? '#ffffff' : undefined) : undefined;
    const paras = look && size && !look.wordArt && (geom || look.path || look.type === 3 || (fill && fill !== '#ffffff')) ? blocksToParas(inner) : undefined;
    if (look && size && paras && size.w > 4 && size.h > 4) {
      const shape: SlideShape = { x: 0, y: 0, w: size.w, h: size.h, paras, anchor: 'middle' };
      if (fill) shape.fill = fill;
      if (look.lined !== false) shape.stroke = look.stroke ?? '#000000';
      if (geom) shape.geom = geom;
      else if (look.type === 3) shape.shape = 'ellipse';
      else if (look.type === 2) shape.shape = 'round';
      else if (look.path) shape.path = look.path;
      // Shapes of one paragraph share a canvas, keeping their relative positions.
      if (!(shapeGroup && pendingBoxes[pendingBoxes.length - 1] === shapeGroup.block && shapeGroup.add(shape, size.x, size.y))) {
        shapeGroup = new CanvasGroup();
        shapeGroup.add(shape, size.x, size.y);
        pendingBoxes.push(shapeGroup.block);
      }
      return;
    }
    pendingBoxes.push({ k: 'table', rows: [{ cells: [{ blocks: inner }] }] });
  };

  const walkRange = (rangeFrom: number, rangeTo: number): void => {
   for (const piece of pieces) {
    if (piece.cpStart >= rangeTo) break;
    if (piece.cpEnd <= rangeFrom) continue;
    const cpStart = Math.max(piece.cpStart, rangeFrom);
    const cpEnd = Math.min(piece.cpEnd, rangeTo);
    const count = cpEnd - cpStart;
    const width = piece.compressed ? 1 : 2;
    const pieceFc = piece.fc + (cpStart - piece.cpStart) * width;
    if (count <= 0 || pieceFc + count * width > doc.length) continue;
    const text = (piece.compressed ? cp1252 : utf16).decode(doc.subarray(pieceFc, pieceFc + count * width));

    for (let i = 0; i < count; i++) {
      const fc = pieceFc + i * width;
      const cp = cpStart + i;
      const code = text.charCodeAt(i);

      const ci = findRun(chpx, fc, chpxHint);
      if (ci >= 0) chpxHint = ci;
      const cprops = charProps(ci >= 0 ? chpx[ci] : undefined);

      if (code === 13 || code === 7 || code === 12) {
        const pi = findRun(papx, fc, papxHint);
        if (pi >= 0) papxHint = pi;
        const pp = paraProps(pi >= 0 ? papx[pi] : undefined);
        if (code === 7) {
          // Cell end mark; at the end of a table row there is one more such mark flagged "end of row".
          if (pp.rowEnd) {
            flushText();
            runs = [];
            if (rowCells.length) {
              tableRows.push({ cells: rowCells });
              rowEdges.push(pp.edges);
            }
            rowCells = [];
          } else {
            const block = makeParagraph(pp);
            if (block.k === 'p' && (block.runs.length || cellBlocks.length === 0)) cellBlocks.push(block);
            rowCells.push({ blocks: cellBlocks });
            cellBlocks = [];
          }
        } else if (pp.inTable && code === 13) {
          cellBlocks.push(makeParagraph(pp));
        } else {
          flushTable();
          if (pp.pageBreakBefore) model.blocks.push({ k: 'pagebreak' });
          const hadContent = runs.length > 0 || textBuf !== '';
          if (code === 13 || hadContent) model.blocks.push(makeParagraph(pp));
          if (code === 12) model.blocks.push({ k: 'pagebreak' });
        }
        if (pendingBoxes.length && !pp.inTable) {
          model.blocks.push(...pendingBoxes);
          pendingBoxes = [];
        }
        continue;
      }

      // Fields: "begin, field code, separator, result, end". Only the result is shown.
      if (code === 19) {
        instruction[fieldDepth++] = true;
        continue;
      }
      if (code === 20) {
        if (fieldDepth > 0) instruction[fieldDepth - 1] = false;
        continue;
      }
      if (code === 21) {
        if (fieldDepth > 0) fieldDepth--;
        continue;
      }
      if (fieldDepth > 0 && instruction.slice(0, fieldDepth).some(Boolean)) continue;
      if (cprops.hidden) continue;

      if (cprops.special || code === 8) {
        if (code === 1) addPicture(cprops.picLocation);
        else if (code === 8) {
          addFloatingPicture(cp);
          const anchor = anchors.get(cp);
          if (anchor) boxFor(anchor.spid);
        } else if (code === 2 || code === 5) {
          // Automatic footnote or comment mark: a reference in the main text, its number inside the part.
          let mark: string;
          if (code === 5) mark = `[${++commentNumber}]`;
          else if (endnoteRefs.includes(cp)) mark = formatCounter(endnoteRefs.indexOf(cp) + 1, 'lowerRoman');
          else if (footnoteRefs.includes(cp)) mark = String(footnoteRefs.indexOf(cp) + 1);
          else mark = String(++noteNumber);
          flushText();
          textKey = '';
          runs.push({ k: 'text', text: mark, s: { va: 'sup' } });
        }
        continue;
      }
      if (code === 9) {
        flushText();
        runs.push({ k: 'tab' });
        continue;
      }
      if (code === 11) {
        flushText();
        runs.push({ k: 'br' });
        continue;
      }
      if (code === 31) continue;
      if (code < 32 && code !== 30) continue;

      // The paragraph style the character belongs to gives the default formatting.
      const pi = findRun(papx, fc, papxHint);
      if (pi >= 0) papxHint = pi;
      const istd = pi >= 0 ? papx[pi].istd : 0;
      const key = `${ci >= 0 ? chpx[ci].offset : ''}/${istd}`;
      if (key !== textKey) {
        flushText();
        textKey = key;
        textStyle = effectiveRunStyle(cprops, istd);
      }
      textBuf += code === 30 ? '‑' : text[i];
    }
   }
  };

  walkRange(0, ccpText);
  flushText();
  if (runs.length) model.blocks.push({ k: 'p', runs });
  flushTable();
  // The last Word paragraph is always empty: remove it.
  const last = model.blocks[model.blocks.length - 1];
  if (last && last.k === 'p' && last.runs.length === 0) model.blocks.pop();
  model.blocks.push(...pendingBoxes);
  pendingBoxes = [];
  // Text boxes not bound to a mark in the text (inside a shape group, say) are output at the end.
  for (const box of boxes) {
    if (box.used) continue;
    const inner = renderRange(partStart(6) + box.from, partStart(6) + box.to);
    if (hasVisibleContent(inner)) model.blocks.push({ k: 'table', rows: [{ cells: [{ blocks: inner }] }] });
  }

  const labels: DocPartLabels = options.labels ?? {};
  const part = (index: number): Block[] => (ccp[index] > 0 ? renderRange(partStart(index), partStart(index) + ccp[index]) : []);
  // Footnotes have their own numbering; endnotes are told apart by Roman numerals.
  const endnotes = part(5);
  for (const b of endnotes) {
    if (b.k !== 'p') continue;
    const first = b.runs[0];
    if (first?.k === 'text' && first.s?.va === 'sup' && /^\d+$/.test(first.text)) first.text = formatCounter(Number(first.text), 'lowerRoman');
  }
  appendPart(model.blocks, labels.footnotes, part(1));
  appendPart(model.blocks, labels.endnotes, endnotes);
  appendPart(model.blocks, labels.comments, part(4));

  // Headers/footers: six service entries about footnotes, then six per section —
  // even and odd headers, even and odd footers, first-page header and footer.
  const hdd = plcCps(11, 0);
  const story = (index: number): Block[] => {
    const from = hdd[index];
    const to = hdd[index + 1];
    if (from === undefined || to === undefined || to <= from || to > ccp[2]) return [];
    return renderRange(partStart(2) + from, partStart(2) + to);
  };
  for (let section = 6; section + 5 < hdd.length; section += 6) {
    const top = [...story(section + 4), ...story(section + 1)];
    let bottom = story(section + 3);
    if (!hasVisibleContent(bottom)) bottom = story(section + 5);
    if (!hasVisibleContent(top) && !hasVisibleContent(bottom)) continue;
    appendPart(model.blocks, labels.footer, bottom);
    appendPart(model.blocks, labels.header, top, true);
    break;
  }
  return model;
}
