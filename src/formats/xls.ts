/**
 * Reader of xls (the binary Excel 97–2003 format, BIFF8; basic support for BIFF5 from Excel 5/95).
 * A workbook is a stream of "type, length, data" records inside a CFB container.
 */
import { CfbReader } from '../core/cfb';
import type { DocImage } from '../core/docmodel';
import { readBlipStore, XlsSheetExtras } from './xls-extras';
import { decryptXlsStream } from '../core/office-crypto';
import { decodeXmlBytes } from '../core/xml';
import { decodeHtml } from './html';
import { openHtmlTable, openSpreadsheetXml } from './xls-text';
import { builtinFormat, createLocale, formatGeneral, formatValue, type NumFmtLocale } from '../core/numfmt';
import { indexedColor, SheetBuilder, StyleTable, type CellStyle, type SheetModel, type Workbook, type WorkbookOptions } from '../core/workbook';

const R = {
  BOF: 0x0809, EOF: 0x000a, BOUNDSHEET: 0x0085, SST: 0x00fc, CONTINUE: 0x003c, FORMAT: 0x041e, XF: 0x00e0,
  FONT: 0x0031, DATEMODE: 0x0022, CODEPAGE: 0x0042, FILEPASS: 0x002f, PALETTE: 0x0092,
  LABELSST: 0x00fd, LABEL: 0x0204, RSTRING: 0x00d6, NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd, FORMULA: 0x0006,
  STRING: 0x0207, BOOLERR: 0x0205, MERGEDCELLS: 0x00e5, COLINFO: 0x007d, ROW: 0x0208, NOTE: 0x001c, OBJ: 0x005d, TXO: 0x01b6, DEFCOLWIDTH: 0x0055,
};

const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };

export class XlsPasswordError extends Error {
  constructor() {
    super('The workbook is password protected');
    this.name = 'XlsPasswordError';
  }
}

/**
 * Reader of data split over several records (SST + CONTINUE).
 * A format subtlety: if a string's text runs into the next record, that record starts
 * with a flag byte that sets the character width anew (1 or 2 bytes).
 */
class SegmentReader {
  private si = 0;
  private pos = 0;
  constructor(private readonly segs: Uint8Array[]) {}

  get done(): boolean {
    while (this.si < this.segs.length && this.pos >= this.segs[this.si].length) {
      this.si++;
      this.pos = 0;
    }
    return this.si >= this.segs.length;
  }

  u8(): number {
    if (this.done) throw new Error('Unexpected end of the shared string table');
    return this.segs[this.si][this.pos++];
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number): void {
    while (n > 0 && !this.done) {
      const take = Math.min(n, this.segs[this.si].length - this.pos);
      this.pos += take;
      n -= take;
    }
  }
  chars(count: number, wide: boolean): string {
    let out = '';
    let left = count;
    while (left > 0) {
      if (this.pos >= this.segs[this.si]?.length) {
        this.si++;
        this.pos = 0;
        if (this.si >= this.segs.length) break;
        wide = (this.segs[this.si][this.pos++] & 1) === 1; // continuation flag
      }
      const seg = this.segs[this.si];
      const avail = seg.length - this.pos;
      const take = Math.min(left, wide ? avail >> 1 : avail);
      if (take === 0) {
        this.pos = seg.length;
        continue;
      }
      if (wide) {
        for (let i = 0; i < take; i++, this.pos += 2) out += String.fromCharCode(seg[this.pos] | (seg[this.pos + 1] << 8));
      } else {
        for (let i = 0; i < take; i++) out += String.fromCharCode(seg[this.pos++]);
      }
      left -= take;
    }
    return out;
  }
}

function readSst(segs: Uint8Array[]): string[] {
  const r = new SegmentReader(segs);
  r.u32(); // total references
  const unique = r.u32();
  const out: string[] = [];
  for (let i = 0; i < unique && !r.done; i++) {
    const cch = r.u16();
    const flags = r.u8();
    const runs = flags & 0x08 ? r.u16() : 0;
    const ext = flags & 0x04 ? r.u32() : 0;
    out.push(r.chars(cch, (flags & 1) === 1));
    r.skip(runs * 4 + ext);
  }
  return out;
}

interface Xf {
  format: string | undefined;
  style: number;
  /** Style for numeric values: without explicit alignment numbers are right-aligned. */
  numStyle: number;
}

interface Globals {
  biff5: boolean;
  codepage: TextDecoder;
  sst: string[];
  xfs: Xf[];
  date1904: boolean;
  sheets: { name: string; offset: number }[];
  styles: StyleTable;
  palette?: string[];
  /** Workbook pictures in the order of their numbers in the shared drawing store. */
  blips: (DocImage | undefined)[];
  /** All workbook sheets in order (hidden ones included) and the table of sheet references from formulas. */
  allOffsets: number[];
  sheetRefs: number[];
  rawCache: Map<number, Map<number, number | string>>;
}

function decodeRk(rk: number): number {
  let value: number;
  if (rk & 2) {
    value = rk >> 2;
  } else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, rk & 0xfffffffc, true);
    value = buf.getFloat64(0, true);
  }
  return rk & 1 ? value / 100 : value;
}

/** A BIFF8 string with a 16-bit length: cch, flags, characters. */
function readString(data: Uint8Array, offset: number, lenBytes: 1 | 2, g: { biff5: boolean; codepage: TextDecoder }): string {
  let p = offset;
  const cch = lenBytes === 2 ? data[p] | (data[p + 1] << 8) : data[p];
  p += lenBytes;
  if (g.biff5) return g.codepage.decode(data.subarray(p, p + cch));
  const flags = data[p++];
  if (flags & 0x08) p += 2;
  if (flags & 0x04) p += 4;
  let out = '';
  if (flags & 1) {
    for (let i = 0; i < cch && p + 1 < data.length; i++, p += 2) out += String.fromCharCode(data[p] | (data[p + 1] << 8));
  } else {
    for (let i = 0; i < cch && p < data.length; i++) out += String.fromCharCode(data[p++]);
  }
  return out;
}

function readGlobals(stream: Uint8Array, styles: StyleTable, fallbackEncoding: string | undefined): Globals {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let codepageName = fallbackEncoding ?? 'windows-1251';
  const g: Globals = { biff5: false, codepage: new TextDecoder('windows-1252'), sst: [], xfs: [], date1904: false, sheets: [], styles, blips: [], allOffsets: [], sheetRefs: [], rawCache: new Map() };
  const drawingGroup: Uint8Array[] = [];
  let inDrawingGroup = false;
  const formats = new Map<number, string>();
  const fonts: { bold: boolean; italic: boolean; color: number; size: number; underline: boolean; strike: boolean }[] = [];
  const rawXfs: { font: number; fmt: number; align: number; wrap: boolean; valign: number; pattern: number; fore: number; lines: number }[] = [];
  let palette: string[] | undefined;
  let sstSegs: Uint8Array[] | null = null;
  const pendingSheets: { nameAt: number; offset: number; type: number; hidden: number; data: Uint8Array }[] = [];

  let pos = 0;
  let first = true;
  while (pos + 4 <= stream.length) {
    const id = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    const data = stream.subarray(pos + 4, pos + 4 + len);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    pos += 4 + len;

    if (first) {
      if (id !== R.BOF) throw new Error('Workbook start (BOF) not found');
      g.biff5 = dv.getUint16(0, true) !== 0x0600;
      first = false;
      continue;
    }
    if (id !== R.CONTINUE && sstSegs) {
      g.sst = readSst(sstSegs);
      sstSegs = null;
    }

    if (id !== R.CONTINUE) inDrawingGroup = id === 0x00eb;
    switch (id) {
      case R.FILEPASS:
        throw new XlsPasswordError();
      case R.CODEPAGE: {
        const cp = dv.getUint16(0, true);
        if (cp >= 1250 && cp <= 1258) codepageName = `windows-${cp}`;
        else if (cp === 866) codepageName = 'ibm866';
        else if (cp === 10007) codepageName = 'x-mac-cyrillic';
        break;
      }
      case R.DATEMODE:
        g.date1904 = dv.getUint16(0, true) === 1;
        break;
      case R.FONT:
        fonts.push({ bold: dv.getUint16(6, true) >= 600, italic: (dv.getUint16(2, true) & 2) !== 0, color: dv.getUint16(4, true), size: dv.getUint16(0, true) / 20, underline: len > 10 && data[10] !== 0, strike: (dv.getUint16(2, true) & 8) !== 0 });
        break;
      case R.FORMAT:
        formats.set(dv.getUint16(0, true), readString(data, 2, g.biff5 ? 1 : 2, { biff5: g.biff5, codepage: new TextDecoder(safeEncoding(codepageName)) }));
        break;
      case R.XF:
        if (len >= 16) {
          rawXfs.push({
            font: dv.getUint16(0, true),
            fmt: dv.getUint16(2, true),
            align: data[6] & 7,
            wrap: (data[6] & 0x08) !== 0,
            valign: (data[6] >> 4) & 7,
            pattern: !g.biff5 && len >= 20 ? dv.getUint32(14, true) >>> 26 : 0,
            fore: !g.biff5 && len >= 20 ? dv.getUint16(18, true) & 0x7f : 0,
            lines: !g.biff5 && len >= 20 ? dv.getUint16(10, true) : 0,
          });
        }
        break;
      case R.PALETTE: {
        const count = dv.getUint16(0, true);
        palette = [];
        for (let i = 0; i < count && 2 + i * 4 + 3 <= data.length; i++) {
          const o = 2 + i * 4;
          palette[8 + i] = `#${((1 << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]).toString(16).slice(1)}`;
        }
        break;
      }
      case R.BOUNDSHEET:
        pendingSheets.push({ nameAt: 6, offset: dv.getUint32(0, true), hidden: data[4] & 3, type: data[5], data });
        break;
      case R.SST:
        sstSegs = [data];
        break;
      case R.CONTINUE:
        if (sstSegs) sstSegs.push(data);
        else if (inDrawingGroup) drawingGroup.push(data);
        break;
      case 0x00eb:
        drawingGroup.push(data);
        break;
      case 0x0017: {
        // Table of sheet references: formulas hold a row number of this table.
        const count = len >= 2 ? dv.getUint16(0, true) : 0;
        for (let i = 0; i < count && 2 + i * 6 + 6 <= len; i++) g.sheetRefs.push(dv.getInt16(2 + i * 6 + 2, true));
        break;
      }
      case R.EOF:
        pos = stream.length; // end of the globals
        break;
    }
  }
  if (sstSegs) g.sst = readSst(sstSegs);
  g.codepage = new TextDecoder(safeEncoding(codepageName));
  g.palette = palette;
  if (drawingGroup.length) {
    const total = drawingGroup.reduce((n, part) => n + part.length, 0);
    if (total <= 256 * 1024 * 1024) {
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const part of drawingGroup) {
        bytes.set(part, at);
        at += part.length;
      }
      try {
        g.blips = readBlipStore(bytes);
      } catch {
        g.blips = [];
      }
    }
  }

  g.allOffsets = pendingSheets.map((s) => s.offset);
  for (const s of pendingSheets) {
    if (s.type !== 0 || s.hidden !== 0) continue; // only regular visible sheets
    g.sheets.push({ name: readString(s.data, s.nameAt, 1, g), offset: s.offset });
  }

  g.xfs = rawXfs.map((x) => {
    // A format quirk: there is no font with index 4, indices after it are shifted.
    const font = fonts[x.font >= 4 ? x.font - 1 : x.font];
    const style: CellStyle = {};
    if (font?.bold) style.bold = true;
    if (font?.italic) style.italic = true;
    if (font && font.color >= 8 && font.color < 64) {
      const c = indexedColor(font.color, palette);
      if (c && c !== '#000000') style.color = c;
    }
    if (x.pattern !== 0 && x.fore >= 8 && x.fore < 64) {
      const c = indexedColor(x.fore, palette);
      if (c) style.fill = c;
    }
    // Border line styles: four bits per side — left, right, top, bottom.
    const border = (x.lines & 0x0f00 ? 't' : '') + (x.lines & 0x00f0 ? 'r' : '') + (x.lines & 0xf000 ? 'b' : '') + (x.lines & 0x000f ? 'l' : '');
    if (border) style.border = border;
    if (font?.underline) style.underline = true;
    if (font?.strike) style.strike = true;
    const baseSize = fonts[0]?.size || 10;
    if (font?.size && Math.abs(font.size - baseSize) >= 0.5) style.size = Math.round((font.size / baseSize) * 11 * 10) / 10;
    if (x.wrap) style.wrap = true;
    if (x.valign === 0) style.valign = 'top';
    else if (x.valign === 1) style.valign = 'middle';
    if (x.align === 1) style.align = 'left';
    else if (x.align === 2 || x.align === 6) style.align = 'center';
    else if (x.align === 3) style.align = 'right';
    return { format: formats.get(x.fmt) ?? builtinFormat(x.fmt), style: styles.add(style), numStyle: styles.add(style.align ? style : { ...style, align: 'right' }) };
  });
  return g;
}

function safeEncoding(name: string): string {
  try {
    new TextDecoder(name);
    return name;
  } catch {
    return 'windows-1252';
  }
}

/** Unformatted cell values of a sheet (for charts): numbers and strings, at most 400 thousand. */
function rawSheet(stream: Uint8Array, offset: number, g: Globals): Map<number, number | string> {
  const cached = g.rawCache.get(offset);
  if (cached) return cached;
  const out = new Map<number, number | string>();
  g.rawCache.set(offset, out);
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let depth = 0;
  for (let pos = offset; pos + 4 <= stream.length && out.size < 400_000; ) {
    const id = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    const at = pos + 4;
    pos += 4 + len;
    if (id === R.BOF) { depth++; continue; }
    if (id === R.EOF) { if (--depth <= 0) break; continue; }
    if (depth !== 1 || len < 8 || at + len > stream.length) continue;
    const row = view.getUint16(at, true);
    const col = view.getUint16(at + 2, true);
    const key = row * 16384 + col;
    if (id === R.NUMBER && len >= 14) out.set(key, view.getFloat64(at + 6, true));
    else if (id === R.RK && len >= 10) out.set(key, decodeRk(view.getInt32(at + 6, true)));
    else if (id === R.MULRK) for (let p = 4, c = col; p + 6 <= len - 2; p += 6, c++) out.set(row * 16384 + c, decodeRk(view.getInt32(at + p + 2, true)));
    else if (id === R.FORMULA && len >= 14 && view.getUint16(at + 12, true) !== 0xffff) out.set(key, view.getFloat64(at + 6, true));
    else if (id === R.LABELSST && len >= 10) out.set(key, g.sst[view.getUint32(at + 6, true)] ?? '');
  }
  return out;
}

function parseSheet(stream: Uint8Array, offset: number, g: Globals, locale: NumFmtLocale, maxRows: number, rightStyle: number): SheetBuilder {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const builder = new SheetBuilder(maxRows);
  const extras = new XlsSheetExtras(g.blips, g.palette, (bytes) => g.codepage.decode(bytes), (sheetRef, r0, r1, c0, c1) => {
    const sheetOffset = g.allOffsets[g.sheetRefs[sheetRef]];
    if (sheetOffset === undefined || r1 - r0 > 5000 || c1 - c0 > 255) return [];
    const raw = rawSheet(stream, sheetOffset, g);
    const cells: (number | string | null)[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(raw.get(r * 16384 + c) ?? null);
    return cells;
  });
  let afterDrawing = false;
  const put = (row: number, col: number, xfIndex: number, text: string) => {
    builder.set(row, col, text, g.xfs[xfIndex]?.style ?? 0);
    if (text !== '') extras.value(row, col, text);
  };
  const num = (row: number, col: number, xfIndex: number, value: number) => {
    extras.value(row, col, value);
    const fmt = g.xfs[xfIndex]?.format;
    builder.set(row, col, fmt ? formatValue(value, fmt, locale, g.date1904) : formatGeneral(value, locale), g.xfs[xfIndex]?.numStyle ?? rightStyle);
  };
  let pendingString: { row: number; col: number; xf: number } | null = null;
  const noteTexts = new Map<number, string>();
  let lastObjectId = -1;
  let expectNoteText = 0;
  let depth = 0;
  let pos = offset;

  while (pos + 4 <= stream.length) {
    const id = view.getUint16(pos, true);
    const len = view.getUint16(pos + 2, true);
    const data = stream.subarray(pos + 4, pos + 4 + len);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    pos += 4 + len;

    if (id === R.BOF) {
      // A nested stream is a chart embedded in the sheet.
      if (++depth === 2) extras.beginChart();
      continue;
    }
    if (id === R.EOF) {
      if (depth === 2) extras.endChart();
      if (--depth <= 0) break;
      continue;
    }
    if (depth > 1) {
      if (depth === 2) extras.chartRecord(id, data);
      continue;
    }
    // A drawing description may continue in the following records.
    if (id === 0x00ec || (id === R.CONTINUE && afterDrawing)) extras.record(0x00ec, data, noteTexts);
    else if (id === R.OBJ || id === 0x01b0 || id === 0x01b1 || id === 0x0879 || id === 0x087a || id === 0x087b) extras.record(id, data, noteTexts);
    afterDrawing = id === 0x00ec || (id === R.CONTINUE && afterDrawing);
    // Cell records start with "row, column, style"; they cannot be shorter than six bytes.
    const isCell = id === R.LABELSST || id === R.LABEL || id === R.RSTRING || id === R.NUMBER || id === R.RK || id === R.MULRK || id === R.BOOLERR || id === R.FORMULA;
    if (isCell && len < 8) continue;
    if (id === R.MERGEDCELLS && len < 2) continue;

    switch (id) {
      case R.LABELSST:
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true), g.sst[dv.getUint32(6, true)] ?? '');
        break;
      case R.LABEL:
      case R.RSTRING:
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true), readString(data, 6, 2, g));
        break;
      case R.NUMBER:
        num(dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true), dv.getFloat64(6, true));
        break;
      case R.RK:
        num(dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true), decodeRk(dv.getInt32(6, true)));
        break;
      case R.MULRK: {
        const row = dv.getUint16(0, true);
        let col = dv.getUint16(2, true);
        for (let p = 4; p + 6 <= len - 2; p += 6, col++) num(row, col, dv.getUint16(p, true), decodeRk(dv.getInt32(p + 2, true)));
        break;
      }
      case R.BOOLERR: {
        const value = data[6];
        put(dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true), data[7] ? ERRORS[value] ?? '#ERR' : value ? locale.trueText : locale.falseText);
        break;
      }
      case R.FORMULA: {
        if (len < 14) break;
        const row = dv.getUint16(0, true);
        const col = dv.getUint16(2, true);
        const xf = dv.getUint16(4, true);
        if (dv.getUint16(12, true) === 0xffff) {
          // The formula result is not a number: the type is in the first byte.
          const kind = data[6];
          if (kind === 0) pendingString = { row, col, xf }; // the text comes in the next STRING record
          else if (kind === 1) put(row, col, xf, data[8] ? locale.trueText : locale.falseText);
          else if (kind === 2) put(row, col, xf, ERRORS[data[8]] ?? '#ERR');
        } else {
          num(row, col, xf, dv.getFloat64(6, true));
        }
        break;
      }
      case R.STRING:
        if (pendingString) {
          put(pendingString.row, pendingString.col, pendingString.xf, readString(data, 0, 2, g));
          pendingString = null;
        }
        break;
      case R.MERGEDCELLS: {
        const count = dv.getUint16(0, true);
        for (let i = 0; i < count && 2 + i * 8 + 8 <= len; i++) {
          const o = 2 + i * 8;
          builder.addMerge({ r0: dv.getUint16(o, true), r1: dv.getUint16(o + 2, true), c0: dv.getUint16(o + 4, true), c1: dv.getUint16(o + 6, true) });
        }
        break;
      }
      case R.COLINFO: {
        if (len < 6) break;
        const firstCol = dv.getUint16(0, true);
        const lastCol = Math.min(dv.getUint16(2, true), firstCol + 2000, 255);
        const width = dv.getUint16(4, true) / 256;
        const colHidden = len >= 10 && (dv.getUint16(8, true) & 1) !== 0;
        for (let c = firstCol; c <= lastCol; c++) {
          if (colHidden) builder.hideCol(c);
          else builder.setWidth(c, width);
        }
        break;
      }
      case R.ROW: {
        // Bit 0x20 is a zero-height row: hidden by hand or by a collapsed group.
        if (len >= 14 && dv.getUint16(12, true) & 0x20) builder.hideRow(dv.getUint16(0, true));
        // Height in twentieths of a point; the high bit means "default height".
        if (len >= 8 && !(dv.getUint16(6, true) & 0x8000)) builder.setHeight(dv.getUint16(0, true), (dv.getUint16(6, true) & 0x7fff) / 20);
        break;
      }
      // Comments: an object with a number followed by its text; later a NOTE record links the number to a cell.
      case R.OBJ:
        if (len >= 8 && dv.getUint16(0, true) === 0x15) lastObjectId = dv.getUint16(6, true);
        break;
      case R.TXO:
        expectNoteText = len >= 12 && dv.getUint16(10, true) > 0 ? dv.getUint16(10, true) : 0;
        break;
      case R.CONTINUE:
        if (expectNoteText > 0 && len >= 1) {
          const wide = (data[0] & 1) !== 0;
          const count = Math.min(expectNoteText, wide ? (len - 1) >> 1 : len - 1);
          const text = wide ? new TextDecoder('utf-16le').decode(data.subarray(1, 1 + count * 2)) : g.codepage.decode(data.subarray(1, 1 + count));
          noteTexts.set(lastObjectId, (noteTexts.get(lastObjectId) ?? '') + text);
          expectNoteText -= count;
        }
        break;
      case R.NOTE: {
        if (len >= 8 && !g.biff5) {
          const text = noteTexts.get(dv.getUint16(6, true));
          if (text) builder.addNote(dv.getUint16(0, true), dv.getUint16(2, true), text.trim());
        }
        break;
      }
      case R.DEFCOLWIDTH:
        if (len >= 2) builder.defaultWidth = dv.getUint16(0, true) + 1;
        break;
    }
  }
  try {
    extras.finish(builder, g.styles, noteTexts);
  } catch {
    // A failure in the extras (drawings, conditional formatting) must not prevent showing the data.
  }
  return builder;
}

export async function openXls(blob: Blob, options: WorkbookOptions): Promise<Workbook> {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (!(head[0] === 0xd0 && head[1] === 0xcf)) {
    // Not a binary workbook: an export as XML Spreadsheet 2003 or an HTML table under the .xls extension.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const start = new TextDecoder().decode(bytes.subarray(0, 2048));
    if (/<\?mso-application|urn:schemas-microsoft-com:office:spreadsheet/.test(start) && !/<html[\s>]/i.test(start)) return openSpreadsheetXml(decodeXmlBytes(bytes), options);
    return openHtmlTable(decodeHtml(bytes, options.fallbackEncoding), options);
  }
  const cfb = await CfbReader.open(blob);
  const entry = cfb.find('Workbook', 'Book');
  if (!entry) throw new Error('The file has no Excel workbook');
  const stream = decryptXlsStream(cfb.read(entry), options.password);
  const styles = new StyleTable();
  const globals = readGlobals(stream, styles, options.fallbackEncoding);
  if (globals.sheets.length === 0) throw new Error('The workbook has no sheets with data');
  const locale = createLocale(options.lang);

  const opened = new Map<number, SheetModel>();
  return {
    sheets: globals.sheets.map((s) => s.name),
    async openSheet(i) {
      let model = opened.get(i);
      if (!model) {
        model = parseSheet(stream, globals.sheets[i].offset, globals, locale, options.maxRows, styles.add({ align: 'right' })).build(styles.list);
        opened.set(i, model);
      }
      return model;
    },
  };
}
