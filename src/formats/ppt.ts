/**
 * Reader of ppt (the binary PowerPoint 97–2003 format).
 *
 * The file is a tree of "type, length, data" records. Read: slides in show order, background, shapes with fill,
 * outline and preset geometry, groups (tables included: in this format they are shape groups), PNG and JPEG
 * pictures, formatted text (font, size, colour, emphasis, alignment, bullets), slide number and date,
 * formatting from the slide master. Hidden slides are not shown.
 * EMF/WMF pictures (charts and SmartArt are stored that way in this format) and password-protected files are read too.
 * Not read: animation, 3D effects.
 */
import { symbolChar } from '../core/symbols';
import { CfbReader } from '../core/cfb';
import { decryptPptStream } from '../core/office-crypto';
import { blipImage } from '../core/images';
import { customShapePath, LEGACY_SHAPE_TYPES } from './shape-types';
import { compactRunStyle, type Inline, type RunStyle } from '../core/docmodel';
import type { Slide, SlidePara, SlideShape, SlidesModel } from '../core/slidemodel';

const T = {
  DOCUMENT: 0x03e8, DOCUMENT_ATOM: 0x03e9, SLIDE: 0x03ee, SLIDE_ATOM: 0x03ef, MAIN_MASTER: 0x03f8, SLIDE_SHOW_INFO: 0x03f9,
  SLIDE_PERSIST: 0x03f3, SLIDE_LIST: 0x0ff0, ENVIRONMENT: 0x03f2, PERSIST_DIR: 0x1772, COLOR_SCHEME: 0x07f0,
  TEXT_HEADER: 0x0f9f, TEXT_CHARS: 0x0fa0, STYLE_TEXT: 0x0fa1, TEXT_BYTES: 0x0fa8, OUTLINE_REF: 0x0f9e, MASTER_STYLE: 0x0fa3,
  FONT_COLLECTION: 0x07d5, FONT_ENTITY: 0x0fb7, SLIDE_NUMBER_MC: 0x0fd8, DATE_MC: 0x0ff7, GENERIC_DATE_MC: 0x0ff8, RTF_DATE_MC: 0x1015,
  EX_OBJ_LIST: 0x0409, EX_HYPERLINK: 0x0fd7, EX_HYPERLINK_ATOM: 0x0fd3, CSTRING: 0x0fba, INTERACTIVE: 0x0ff2, INTERACTIVE_ATOM: 0x0ff3, TX_INTERACTIVE: 0x0fdf,
  DRAWING: 0x040c, DRAWING_GROUP: 0x040b, PLACEHOLDER: 0x0bc3, CRYPT: 0x2f14,
  DG: 0xf002, SPGR: 0xf003, SP: 0xf004, BSTORE: 0xf001, BSE: 0xf007, FSPGR: 0xf009, FSP: 0xf00a, FOPT: 0xf00b, FOPT2: 0xf121, FOPT3: 0xf122,
  CLIENT_TEXTBOX: 0xf00d, CHILD_ANCHOR: 0xf00f, CLIENT_ANCHOR: 0xf010, CLIENT_DATA: 0xf011,
};
const MASTER_UNITS_PER_PX = 576 / 96;
const EMU_PER_PX = 9525;

class PasswordError extends Error {
  constructor() {
    super('The presentation is password protected');
    this.name = 'PasswordError';
  }
}

interface Rec {
  type: number;
  instance: number;
  container: boolean;
  start: number;
  end: number;
}

interface ParaProps {
  align?: number;
  bullet?: boolean;
  bulletChar?: string;
  bulletFont?: number;
  bulletColor?: string;
  level?: number;
  spaceBefore?: number;
}
interface CharProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  shadow?: boolean;
  size?: number;
  color?: string;
  font?: string;
  position?: number;
}
interface TextItem {
  kind: number;
  text: string;
  paras?: { count: number; props: ParaProps }[];
  chars?: { count: number; props: CharProps }[];
  /** Service characters in text: position → what to substitute (slide number, date). */
  fields?: Map<number, 'number' | 'date'>;
  /** Links: character range → address. */
  links?: { begin: number; end: number; href: string }[];
}

/** Shape properties that hold arrays. */
const ARRAY_PROPS = new Set([325, 326, 337, 338, 341, 342, 343, 407, 899]);


export async function parsePpt(blob: Blob, options: { password?: string } = {}): Promise<SlidesModel> {
  const cfb = await CfbReader.open(blob);
  const entry = cfb.find('PowerPoint Document');
  if (!entry) throw new Error('The file has no PowerPoint presentation');
  const userEntry = cfb.find('Current User');
  const decrypted = decryptPptStream(cfb.read(entry), userEntry ? cfb.read(userEntry) : undefined, options.password);
  const data = decrypted ? decrypted.data : cfb.read(entry);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const picturesEntry = cfb.find('Pictures');
  const pictures = picturesEntry ? (decrypted ? decrypted.pictures(cfb.read(picturesEntry)) : cfb.read(picturesEntry)) : undefined;

  const recordAt = (p: number, end: number): Rec | undefined => {
    if (p + 8 > end) return undefined;
    const verInst = dv.getUint16(p, true);
    const recEnd = p + 8 + dv.getUint32(p + 4, true);
    if (recEnd > end) return undefined;
    return { type: dv.getUint16(p + 2, true), instance: verInst >> 4, container: (verInst & 0x0f) === 0x0f, start: p + 8, end: recEnd };
  };
  const records = function* (start: number, end: number): Generator<Rec> {
    let p = start;
    for (;;) {
      const rec = recordAt(p, end);
      if (!rec) return;
      yield rec;
      p = rec.end;
    }
  };
  const find = (rec: Rec | undefined, type: number): Rec | undefined => {
    if (!rec) return undefined;
    for (const r of records(rec.start, rec.end)) if (r.type === type) return r;
    return undefined;
  };

  const readText = (rec: Rec): string => {
    let out = '';
    if (rec.type === T.TEXT_CHARS) for (let p = rec.start; p + 1 < rec.end; p += 2) out += String.fromCharCode(dv.getUint16(p, true));
    else for (let p = rec.start; p < rec.end; p++) out += String.fromCharCode(data[p]);
    return out;
  };

  // --- top level: document, slides, masters, persist directory ---
  let width = 960;
  let height = 720;
  let documentRec: Rec | undefined;
  const slideRecs: Rec[] = [];
  const masterRecs: Rec[] = [];
  const persist = new Map<number, number>();
  for (const top of records(0, data.length)) {
    if (top.type === T.CRYPT) throw new PasswordError();
    if (top.type === T.DOCUMENT && top.container) documentRec = top;
    else if (top.type === T.SLIDE && top.container) slideRecs.push(top);
    else if (top.type === T.MAIN_MASTER && top.container) masterRecs.push(top);
    else if (top.type === T.PERSIST_DIR) {
      // Directory: "persist id → file offset". Later directory entries replace earlier ones.
      let p = top.start;
      while (p + 4 <= top.end) {
        const head = dv.getUint32(p, true);
        const first = head & 0xfffff;
        const count = head >>> 20;
        p += 4;
        for (let i = 0; i < count && p + 4 <= top.end; i++, p += 4) persist.set(first + i, dv.getUint32(p, true));
      }
    }
  }
  if (!documentRec && !slideRecs.length) throw new Error('No slides found in the presentation');

  const fonts: string[] = [];
  const fontName = (index: number | undefined): string | undefined => (index === undefined ? undefined : fonts[index]);
  // Link addresses from the document's list of external objects.
  const hyperlinks = new Map<number, string>();
  for (const link of records(find(documentRec, T.EX_OBJ_LIST)?.start ?? 0, find(documentRec, T.EX_OBJ_LIST)?.end ?? 0)) {
    if (link.type !== T.EX_HYPERLINK) continue;
    const atom = find(link, T.EX_HYPERLINK_ATOM);
    let target = '';
    for (const part of records(link.start, link.end)) if (part.type === T.CSTRING && (part.instance === 1 || (!target && part.instance === 0))) target = new TextDecoder('utf-16le').decode(data.subarray(part.start, part.end));
    if (atom && atom.end - atom.start >= 4 && /^(https?:|mailto:)/i.test(target)) hyperlinks.set(dv.getUint32(atom.start, true), target);
  }
  const sharedTexts = new Map<number, TextItem[]>(); // placeholder texts by slide reference
  const slideOrder: number[] = []; // slide references in show order
  /** Texts from the sequence "text header, the text itself, formatting, service characters". */
  const collectTexts = (start: number, end: number, shared: TextItem[] | undefined, out: TextItem[]): void => {
    let kind = 4;
    let current: TextItem | undefined;
    let pendingLink: string | undefined;
    for (const rec of records(start, end)) {
      if (rec.type === T.INTERACTIVE && rec.instance === 0) {
        const atom = find(rec, T.INTERACTIVE_ATOM);
        pendingLink = atom && atom.end - atom.start >= 8 ? hyperlinks.get(dv.getUint32(atom.start + 4, true)) : undefined;
      } else if (rec.type === T.TX_INTERACTIVE && rec.instance === 0 && rec.end - rec.start >= 8) {
        if (pendingLink && current) (current.links ??= []).push({ begin: dv.getInt32(rec.start, true), end: dv.getInt32(rec.start + 4, true), href: pendingLink });
        pendingLink = undefined;
      }
      if (rec.type === T.TEXT_HEADER) kind = dv.getUint32(rec.start, true);
      else if (rec.type === T.TEXT_CHARS || rec.type === T.TEXT_BYTES) {
        current = { kind, text: readText(rec) };
        out.push(current);
      } else if (rec.type === T.STYLE_TEXT && current) parseStyleRuns(rec, current);
      else if ((rec.type === T.SLIDE_NUMBER_MC || rec.type === T.DATE_MC || rec.type === T.GENERIC_DATE_MC || rec.type === T.RTF_DATE_MC) && current && rec.end - rec.start >= 4) {
        (current.fields ??= new Map()).set(dv.getInt32(rec.start, true), rec.type === T.SLIDE_NUMBER_MC ? 'number' : 'date');
      } else if (rec.type === T.OUTLINE_REF && shared) {
        const item = shared[dv.getInt32(rec.start, true)];
        if (item) {
          current = item;
          out.push(item);
        }
      }
    }
  };

  // --- text formatting ---
  const textColor = (at: number, scheme: string[]): string | undefined => {
    const index = data[at + 3];
    if (index === 0xfe) return `#${((1 << 24) | (data[at] << 16) | (data[at + 1] << 8) | data[at + 2]).toString(16).slice(1)}`;
    return index < 8 ? scheme[index] : undefined;
  };
  let activeScheme: string[] = [];
  /** Paragraph properties: returns the position after them. */
  const readPara = (p: number, props: ParaProps): number => {
    const mask = dv.getUint32(p, true);
    p += 4;
    if (mask & 0x000f) {
      const flags = dv.getUint16(p, true);
      if (mask & 0x0001) props.bullet = (flags & 1) !== 0;
      p += 2;
    }
    if (mask & 0x0080) {
      props.bulletChar = String.fromCharCode(dv.getUint16(p, true));
      p += 2;
    }
    if (mask & 0x0010) {
      props.bulletFont = dv.getUint16(p, true);
      p += 2;
    }
    if (mask & 0x0040) p += 2;
    if (mask & 0x0020) {
      // Bullet colour: red, green, blue and a kind byte (0xFE: an explicit colour).
      if (dv.getUint8(p + 3) === 0xfe) props.bulletColor = `#${[0, 1, 2].map((k) => dv.getUint8(p + k).toString(16).padStart(2, '0')).join('')}`;
      p += 4;
    }
    if (mask & 0x0800) {
      props.align = dv.getUint16(p, true);
      p += 2;
    }
    if (mask & 0x1000) p += 2;
    if (mask & 0x2000) {
      props.spaceBefore = dv.getInt16(p, true);
      p += 2;
    }
    if (mask & 0x4000) p += 2;
    if (mask & 0x0100) p += 2;
    if (mask & 0x0400) p += 2;
    if (mask & 0x8000) p += 2;
    if (mask & 0x100000) p += 2 + dv.getUint16(p, true) * 4;
    if (mask & 0x10000) p += 2;
    if (mask & 0xe0000) p += 2;
    if (mask & 0x200000) p += 2;
    return p;
  };
  const readChar = (p: number, props: CharProps): number => {
    const mask = dv.getUint32(p, true);
    p += 4;
    if (mask & 0xffff) {
      const style = dv.getUint16(p, true);
      if (mask & 0x01) props.bold = (style & 0x01) !== 0;
      if (mask & 0x02) props.italic = (style & 0x02) !== 0;
      if (mask & 0x04) props.underline = (style & 0x04) !== 0;
      if (mask & 0x10) props.shadow = (style & 0x10) !== 0;
      p += 2;
    }
    if (mask & 0x10000) {
      props.font = fonts[dv.getUint16(p, true)];
      p += 2;
    }
    if (mask & 0x200000) p += 2;
    if (mask & 0x400000) p += 2;
    if (mask & 0x800000) p += 2;
    if (mask & 0x20000) {
      props.size = dv.getUint16(p, true);
      p += 2;
    }
    if (mask & 0x40000) {
      props.color = textColor(p, activeScheme);
      p += 4;
    }
    if (mask & 0x80000) {
      props.position = dv.getInt16(p, true);
      p += 2;
    }
    return p;
  };
  function parseStyleRuns(rec: Rec, item: TextItem): void {
    // Formatting describes the text plus one terminating character.
    const total = item.text.length + 1;
    const paras: NonNullable<TextItem['paras']> = [];
    const chars: NonNullable<TextItem['chars']> = [];
    try {
      let p = rec.start;
      for (let covered = 0; covered < total && p + 10 <= rec.end; ) {
        const count = dv.getUint32(p, true);
        const props: ParaProps = { level: dv.getUint16(p + 4, true) };
        p = readPara(p + 6, props);
        paras.push({ count, props });
        covered += count;
      }
      for (let covered = 0; covered < total && p + 8 <= rec.end; ) {
        const count = dv.getUint32(p, true);
        const props: CharProps = {};
        p = readChar(p + 4, props);
        chars.push({ count, props });
        covered += count;
      }
    } catch {
      return; // damaged formatting: the text is shown without it
    }
    item.paras = paras;
    item.chars = chars;
  }

  // --- default formatting from the master: text type → levels ---
  type LevelStyle = { para: ParaProps; char: CharProps };
  const readMasterStyles = (holder: Rec | undefined, into: Map<number, LevelStyle[]>): void => {
    if (!holder) return;
    for (const rec of records(holder.start, holder.end)) {
      if (rec.type !== T.MASTER_STYLE) continue;
      try {
        const levels: LevelStyle[] = [];
        const count = dv.getUint16(rec.start, true);
        let p = rec.start + 2;
        for (let i = 0; i < count && i < 5 && p + 8 <= rec.end; i++) {
          if (rec.instance >= 5) p += 2;
          const style: LevelStyle = { para: {}, char: {} };
          p = readPara(p, style.para);
          p = readChar(p, style.char);
          levels.push(style);
        }
        into.set(rec.instance, levels);
      } catch {
        /* a master without this style: defaults stay */
      }
    }
  };

  const schemeOf = (holder: Rec | undefined): string[] | undefined => {
    if (!holder) return undefined;
    for (const rec of records(holder.start, holder.end)) {
      if (rec.type === T.COLOR_SCHEME && rec.instance === 1 && rec.end - rec.start >= 32) {
        return Array.from({ length: 8 }, (_, i) => `#${((1 << 24) | (data[rec.start + i * 4] << 16) | (data[rec.start + i * 4 + 1] << 8) | data[rec.start + i * 4 + 2]).toString(16).slice(1)}`);
      }
    }
    return undefined;
  };

  // --- document: size, fonts, slide order, picture store ---
  const blips: { offset: number; size: number }[] = [];
  if (documentRec) {
    for (const rec of records(documentRec.start, documentRec.end)) {
      if (rec.type === T.DOCUMENT_ATOM) {
        width = Math.round(dv.getInt32(rec.start, true) / MASTER_UNITS_PER_PX);
        height = Math.round(dv.getInt32(rec.start + 4, true) / MASTER_UNITS_PER_PX);
      } else if (rec.type === T.ENVIRONMENT) {
        for (const font of records(find(rec, T.FONT_COLLECTION)?.start ?? 0, find(rec, T.FONT_COLLECTION)?.end ?? 0)) {
          if (font.type !== T.FONT_ENTITY) continue;
          let name = '';
          for (let p = font.start; p + 1 < Math.min(font.end, font.start + 64); p += 2) {
            const c = dv.getUint16(p, true);
            if (!c) break;
            name += String.fromCharCode(c);
          }
          fonts[font.instance] = name;
        }
      } else if (rec.type === T.SLIDE_LIST && rec.instance === 0) {
        let current: TextItem[] | undefined;
        let from = rec.start;
        const flush = (to: number) => {
          if (current) collectTexts(from, to, undefined, current);
        };
        for (const item of records(rec.start, rec.end)) {
          if (item.type !== T.SLIDE_PERSIST) continue;
          flush(item.start - 8);
          const ref = dv.getUint32(item.start, true);
          current = [];
          sharedTexts.set(ref, current);
          slideOrder.push(ref);
          from = item.end;
        }
        flush(rec.end);
      } else if (rec.type === T.DRAWING_GROUP) {
        const walk = (start: number, end: number, depth: number): void => {
          for (const r of records(start, end)) {
            if (r.type === T.BSE && r.end - r.start >= 36) blips.push({ size: dv.getUint32(r.start + 20, true), offset: dv.getUint32(r.start + 28, true) });
            else if (r.container && depth < 6) walk(r.start, r.end, depth + 1);
          }
        };
        walk(rec.start, rec.end, 0);
      }
    }
  }

  const master = masterRecs[0];
  const masterScheme = schemeOf(master) ?? ['#ffffff', '#000000', '#808080', '#000000', '#bbe0e3', '#333399', '#009999', '#99cc00'];
  const masterStyles = new Map<number, LevelStyle[]>();
  readMasterStyles(documentRec ? find(documentRec, T.ENVIRONMENT) : undefined, masterStyles);
  activeScheme = masterScheme;
  readMasterStyles(master, masterStyles);

  const model: SlidesModel = { width, height, slides: [], images: {} };
  const imageIds = new Map<number, string | null>();
  /** A picture from the shared store by its number (one-based). null: a format the browser will not show. */
  const imageFor = (index: number): string | null | undefined => {
    if (imageIds.has(index)) return imageIds.get(index);
    const blip = blips[index - 1];
    let id: string | null = null;
    if (blip && pictures && blip.offset + 8 < pictures.length) {
      const end = Math.min(pictures.length, blip.offset + 8 + (pictures[blip.offset + 4] | (pictures[blip.offset + 5] << 8) | (pictures[blip.offset + 6] << 16) | (pictures[blip.offset + 7] << 24)));
      // A variable-length service header precedes the picture data; the data itself is found by signature.
      for (let i = blip.offset + 8; i + 8 < Math.min(end, blip.offset + 80); i++) {
        const png = pictures[i] === 0x89 && pictures[i + 1] === 0x50 && pictures[i + 2] === 0x4e && pictures[i + 3] === 0x47;
        const jpeg = pictures[i] === 0xff && pictures[i + 1] === 0xd8 && pictures[i + 2] === 0xff;
        if (!png && !jpeg) continue;
        id = `ppt-image-${index}`;
        model.images[id] = { mime: png ? 'image/png' : 'image/jpeg', data: pictures.slice(i, end).buffer as ArrayBuffer };
        break;
      }
      if (!id) {
        // Neither PNG nor JPEG: a metafile (EMF, WMF) or a DIB bitmap.
        const image = blipImage(pictures, blip.offset);
        if (image) {
          id = `ppt-image-${index}`;
          model.images[id] = image;
        }
      }
    }
    imageIds.set(index, id);
    return id;
  };

  // --- shape properties ---
  interface Props {
    simple: Map<number, number>;
    complex: Map<number, Uint8Array>;
  }
  const readProps = (sp: Rec): Props => {
    const props: Props = { simple: new Map(), complex: new Map() };
    for (const rec of records(sp.start, sp.end)) {
      if (rec.type !== T.FOPT && rec.type !== T.FOPT2 && rec.type !== T.FOPT3) continue;
      let extra = rec.start + rec.instance * 6;
      for (let i = 0; i < rec.instance && rec.start + i * 6 + 6 <= rec.end; i++) {
        const head = dv.getUint16(rec.start + i * 6, true);
        const value = dv.getUint32(rec.start + i * 6 + 2, true);
        const id = head & 0x3fff;
        if (head & 0x8000) {
          // Array length is written sometimes with a six-byte header, sometimes without (LibreOffice writes it so).
          let size = value;
          if (ARRAY_PROPS.has(id) && extra + 6 <= rec.end) {
            const count = dv.getUint16(extra, true);
            const item = dv.getUint16(extra + 4, true);
            if (count * (item === 0xfff0 ? 4 : item) === value) size = value + 6;
          }
          if (extra + size <= rec.end) props.complex.set(id, data.subarray(extra, extra + size));
          extra += size;
        } else if (!props.simple.has(id)) props.simple.set(id, value);
      }
    }
    return props;
  };
  const artColor = (value: number | undefined, scheme: string[]): string | undefined => {
    if (value === undefined) return undefined;
    const flags = value >>> 24;
    if (flags & 0x08) return scheme[value & 0xff];
    if (flags & 0x10) return undefined; // system colour
    return `#${((1 << 24) | ((value & 0xff) << 16) | (value & 0xff00) | ((value >> 16) & 0xff)).toString(16).slice(1)}`;
  };
  /** A boolean flag: whether it is set explicitly and what it equals. */
  const flag = (props: Props, id: number, bit: number): boolean | undefined => {
    const v = props.simple.get(id);
    if (v === undefined || !(v & (bit << 16))) return undefined;
    return (v & bit) !== 0;
  };

  /** Freeform shape outline: vertices and the description of segments between them. */
  const customPath = (props: Props): (string | number)[] | undefined =>
    customShapePath(props.complex.get(325), props.complex.get(326), [props.simple.get(320), props.simple.get(321), props.simple.get(322), props.simple.get(323)]);

  /** An outline of one "ellipse by corners" command: this is how LibreOffice writes an ellipse that has no preset type. */
  const isEllipsePath = (props: Props): boolean => {
    const segments = props.complex.get(326);
    if (!segments || segments.length < 8) return false;
    const sv = new DataView(segments.buffer, segments.byteOffset, segments.byteLength);
    const n = sv.getUint16(0, true);
    // LibreOffice writes the four arcs of an ellipse as "four segments" with two parameter points per arc.
    const vertices = props.complex.get(325);
    if (n === 4 && vertices && vertices.length >= 6 && (vertices[0] | (vertices[1] << 8)) === 9 && sv.getUint16(6, true) === 0x4000 && sv.getUint16(8, true) === 0x0004 && sv.getUint16(10, true) >> 13 === 3) return true;
    let ellipse = false;
    for (let i = 0; i < n && 6 + i * 2 + 2 <= segments.length; i++) {
      const code = sv.getUint16(6 + i * 2, true);
      if (code >> 13 === 5) {
        const escape = (code >> 8) & 0x1f;
        if (escape === 1 || escape === 2) ellipse = true;
        else if (escape >= 3 && escape <= 8) return false;
      } else if (code >> 13 === 0 || code >> 13 === 1) return false;
    }
    return ellipse;
  };

  // --- shape text ---
  const today = (() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  })();
  const toParas = (item: TextItem, scheme: string[], slideNumber: number): SlidePara[] => {
    const base = item.kind === 6 ? 0 : item.kind === 5 || item.kind === 7 || item.kind === 8 ? 1 : item.kind;
    const levels = masterStyles.get(item.kind) ?? masterStyles.get(base) ?? masterStyles.get(4) ?? [];
    const isTitle = base === 0;
    const isBody = base === 1;
    let text = item.text;
    if (item.fields) {
      // The service character "*" is replaced by the field value; go from the end so that positions do not shift.
      for (const [pos, kind] of [...item.fields].sort((a, b) => b[0] - a[0])) {
        if (pos >= 0 && pos < text.length) text = text.slice(0, pos) + (kind === 'number' ? '\u0001' : '\u0002') + text.slice(pos + 1);
      }
    }
    const paras: SlidePara[] = [];
    let offset = 0;
    let paraIndex = 0;
    let paraLeft = item.paras?.[0]?.count ?? Infinity;
    let charIndex = 0;
    let charLeft = item.chars?.[0]?.count ?? Infinity;
    const lines = text.replace(/\r$/, '').split('\r');
    for (const line of lines) {
      const pp: ParaProps = item.paras?.[paraIndex]?.props ?? {};
      const level = Math.min(pp.level ?? 0, 4);
      // A level inherits from the previous ones whatever it does not set itself.
      const def: LevelStyle = { para: {}, char: {} };
      for (let i = 0; i <= level && i < levels.length; i++) {
        Object.assign(def.para, Object.fromEntries(Object.entries(levels[i].para).filter(([, v]) => v !== undefined)));
        Object.assign(def.char, Object.fromEntries(Object.entries(levels[i].char).filter(([, v]) => v !== undefined)));
      }
      const runs: Inline[] = [];
      let buffer = '';
      let style: RunStyle | undefined;
      const styleNow = (): RunStyle | undefined => {
        const cp: CharProps = item.chars?.[charIndex]?.props ?? {};
        return compactRunStyle({
          size: cp.size ?? def.char.size ?? (isTitle ? 44 : isBody ? 32 - level * 4 : 18),
          b: (cp.bold ?? def.char.bold) ? 1 : 0,
          i: (cp.italic ?? def.char.italic) ? 1 : 0,
          u: (cp.underline ?? def.char.underline) ? 1 : 0,
          shadow: (cp.shadow ?? def.char.shadow) ? 1 : 0,
          color: cp.color ?? def.char.color ?? scheme[isTitle ? 3 : 1],
          font: cp.font ?? def.char.font,
          va: cp.position ? (cp.position > 0 ? 'sup' : 'sub') : undefined,
        });
      };
      let key = -1;
      let href: string | undefined;
      const flushLink = () => {
        // A hyperlink looks like one: the link colour and an underline.
        if (buffer) runs.push(href ? { k: 'text', text: buffer, s: { ...style, u: 1, color: scheme[6] ?? '#0563c1' }, href } : { k: 'text', text: buffer, s: style });
        buffer = '';
      };
      for (let i = 0; i <= line.length; i++) {
        // The paragraph end mark also takes a place in the formatting count.
        if (i < line.length) {
          const link = item.links?.find((l) => offset >= l.begin && offset < l.end)?.href;
          if (key !== charIndex || link !== href) {
            flushLink();
            href = link;
            style = styleNow();
            key = charIndex;
          }
          const ch = line[i];
          if (ch === '\u000b') {
            flushLink();
            runs.push({ k: 'br' });
          } else if (ch === '\u0001') buffer += String(slideNumber);
          else if (ch === '\u0002') buffer += today;
          else buffer += ch;
        }
        offset++;
        if (--charLeft <= 0) {
          charIndex++;
          charLeft = item.chars?.[charIndex]?.count ?? Infinity;
        }
      }
      flushLink();
      const para: SlidePara = { runs };
      const align = pp.align ?? def.para.align;
      if (align === 1) para.align = 'center';
      else if (align === 2) para.align = 'right';
      else if (align === 3) para.align = 'justify';
      if (level) para.level = level;
      const bullet = pp.bullet ?? def.para.bullet ?? false;
      if (bullet && line.trim()) {
        const ch = pp.bulletChar ?? def.para.bulletChar ?? '•';
        // Bullets from symbol fonts (Wingdings) are invisible without the font: they are mapped to regular characters.
        const bulletFont = fontName(pp.bulletFont ?? def.para.bulletFont);
        para.marker = ch.charCodeAt(0) < 0x20 ? '•' : symbolChar(bulletFont ?? (ch.charCodeAt(0) >= 0xf000 ? 'Wingdings' : undefined), ch, '•').trim() || '•';
        const bulletColor = pp.bulletColor ?? def.para.bulletColor;
        if (bulletColor) para.markerColor = bulletColor;
      }
      if (!runs.length) para.runs.push({ k: 'text', text: '​', s: styleNow() });
      paras.push(para);
      paraLeft -= line.length + 1;
      if (paraLeft <= 0) {
        paraIndex++;
        paraLeft = item.paras?.[paraIndex]?.count ?? Infinity;
      }
    }
    void offset;
    return paras;
  };

  type Transform = (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number };
  const identity: Transform = (x, y, w, h) => ({ x, y, w, h });

  /** Fill of a shape or background from its properties. */
  const applyFill = (props: Props, scheme: string[], shape: SlideShape, filledByDefault: boolean): void => {
    const filled = flag(props, 447, 0x10) ?? (filledByDefault || props.simple.has(385));
    if (!filled) return;
    const color = artColor(props.simple.get(385), scheme) ?? scheme[4] ?? '#ffffff';
    const type = props.simple.get(384) ?? 0;
    const back = artColor(props.simple.get(387), scheme);
    if (type >= 4 && type <= 7) {
      const angle = ((props.simple.get(395) ?? 0) | 0) / 65536;
      // Gradient colour stops: a "colour, position" list or just two colours, main and second.
      const stops: { at: number; color: string }[] = [];
      const list = props.complex.get(407);
      if (list && list.length >= 6 + 16) {
        const lv = new DataView(list.buffer, list.byteOffset, list.byteLength);
        const count = lv.getUint16(0, true);
        for (let i = 0; i < count && 6 + i * 8 + 8 <= list.length; i++) {
          const c = artColor(lv.getUint32(6 + i * 8, true), scheme);
          if (c) stops.push({ at: Math.min(1, Math.max(0, lv.getInt32(6 + i * 8 + 4, true) / 65536)), color: c });
        }
      }
      // The second colour defaults to white.
      if (stops.length < 2) stops.splice(0, stops.length, { at: 0, color }, { at: 1, color: back ?? '#ffffff' });
      // The angle in the legacy format is counted differently: 0 is top to bottom.
      if (stops.length > 1) shape.gradient = { angle: 90 - angle, stops: stops.sort((a, b) => a.at - b.at) };
    }
    shape.fill = color;
    const opacity = props.simple.get(386);
    if (opacity !== undefined && opacity < 65536) shape.alpha = Math.max(0, opacity / 65536);
  };

  const collectShapes = (start: number, end: number, shared: TextItem[] | undefined, out: SlideShape[], tf: Transform, scheme: string[], slideNumber: number, fromMaster: boolean): void => {
    for (const rec of records(start, end)) {
      if (!rec.container) continue;
      if (rec.type === T.SPGR) {
        // Group: the first shape describes the group itself — the coordinate system of the children and the group's place.
        let inner = tf;
        let first = true;
        for (const sp of records(rec.start, rec.end)) {
          if (sp.type === T.SP && first) {
            first = false;
            const grid = find(sp, T.FSPGR);
            const client = find(sp, T.CLIENT_ANCHOR);
            const childAnchor = find(sp, T.CHILD_ANCHOR);
            if (grid && grid.end - grid.start >= 16 && (client || childAnchor)) {
              const gl = dv.getInt32(grid.start, true);
              const gt = dv.getInt32(grid.start + 4, true);
              const gw = dv.getInt32(grid.start + 8, true) - gl || 1;
              const gh = dv.getInt32(grid.start + 12, true) - gt || 1;
              let box: { x: number; y: number; w: number; h: number };
              if (client && client.end - client.start >= 8) {
                const top = dv.getInt16(client.start, true);
                const left = dv.getInt16(client.start + 2, true);
                box = tf(left / MASTER_UNITS_PER_PX, top / MASTER_UNITS_PER_PX, (dv.getInt16(client.start + 4, true) - left) / MASTER_UNITS_PER_PX, (dv.getInt16(client.start + 6, true) - top) / MASTER_UNITS_PER_PX);
              } else if (childAnchor && childAnchor.end - childAnchor.start >= 16) {
                const l = dv.getInt32(childAnchor.start, true);
                const t = dv.getInt32(childAnchor.start + 4, true);
                box = tf(l, t, dv.getInt32(childAnchor.start + 8, true) - l, dv.getInt32(childAnchor.start + 12, true) - t);
              } else continue;
              inner = (x, y, w, h) => ({ x: box.x + ((x - gl) / gw) * box.w, y: box.y + ((y - gt) / gh) * box.h, w: (w / gw) * box.w, h: (h / gh) * box.h });
            }
            continue;
          }
          if (sp.type === T.SP || sp.type === T.SPGR) collectShapes(sp.start - 8, sp.end, shared, out, inner, scheme, slideNumber, fromMaster);
        }
        continue;
      }
      if (rec.type !== T.SP) {
        collectShapes(rec.start, rec.end, shared, out, tf, scheme, slideNumber, fromMaster);
        continue;
      }
      const fsp = find(rec, T.FSP);
      const spFlags = fsp && fsp.end - fsp.start >= 8 ? dv.getUint32(fsp.start + 4, true) : 0;
      // The group itself, the drawing "patriarch", deleted shapes and the background are handled elsewhere.
      if (spFlags & (0x01 | 0x04 | 0x08 | 0x400)) continue;
      const type = fsp?.instance ?? 1;

      let box: { x: number; y: number; w: number; h: number } | undefined;
      let placeholder = -1;
      const texts: TextItem[] = [];
      for (const part of records(rec.start, rec.end)) {
        if (part.type === T.CLIENT_ANCHOR && part.end - part.start >= 8) {
          // Field order: top, left, right, bottom.
          const top = dv.getInt16(part.start, true);
          const left = dv.getInt16(part.start + 2, true);
          box = tf(left / MASTER_UNITS_PER_PX, top / MASTER_UNITS_PER_PX, (dv.getInt16(part.start + 4, true) - left) / MASTER_UNITS_PER_PX, (dv.getInt16(part.start + 6, true) - top) / MASTER_UNITS_PER_PX);
        } else if (part.type === T.CHILD_ANCHOR && part.end - part.start >= 16) {
          const l = dv.getInt32(part.start, true);
          const t = dv.getInt32(part.start + 4, true);
          box = tf(l, t, dv.getInt32(part.start + 8, true) - l, dv.getInt32(part.start + 12, true) - t);
        } else if (part.type === T.CLIENT_TEXTBOX) {
          collectTexts(part.start, part.end, shared, texts);
        } else if (part.type === T.CLIENT_DATA) {
          for (const item of records(part.start, part.end)) {
            if (item.type === T.PLACEHOLDER && item.end - item.start >= 5) placeholder = data[item.start + 4];
          }
        }
      }
      if (!box) continue;
      // Only formatting is taken from the master, not its empty placeholders.
      if (fromMaster && placeholder >= 0) continue;
      const props = readProps(rec);
      const shape: SlideShape = { x: Math.min(box.x, box.x + box.w), y: Math.min(box.y, box.y + box.h), w: Math.abs(box.w), h: Math.abs(box.h) };
      const rotation = props.simple.get(4);
      if (rotation) shape.rot = (rotation | 0) / 65536;
      if (spFlags & 0x40) shape.flipH = true;
      if (spFlags & 0x80) shape.flipV = true;

      const isLine = type === 20 || (type >= 32 && type <= 40);
      const isPicture = type === 75 || props.simple.has(260);
      const isTextBox = type === 202 || placeholder >= 0;
      if (isLine) {
        shape.shape = 'line';
        if (type >= 33 && type <= 40) {
          const adj: number[] = [];
          for (let i = 0; i < 3; i++) {
            const adjust = props.simple.get(327 + i);
            if (adjust !== undefined) adj[i] = (adjust | 0) / 21600;
          }
          shape.connector = { kind: type <= 36 ? 'bent' : 'curved', elbows: ((type - 33) % 4) + 1, ...(adj.length ? { adj } : {}) };
        }
      }
      else if (type === 3 || type === 120) shape.shape = 'ellipse';
      else if (type === 2 || type === 176) shape.shape = 'round';
      else if (LEGACY_SHAPE_TYPES[type]) shape.geom = LEGACY_SHAPE_TYPES[type];
      else if (!isPicture && isEllipsePath(props)) shape.shape = 'ellipse';
      else if (!isPicture && props.complex.has(325)) {
        const path = customPath(props);
        if (path) shape.path = path;
      }
      // A format quirk: a shape rotated closer to vertical has its frame recorded "lying down".
      const turn = (((shape.rot ?? 0) % 180) + 180) % 180;
      if (turn >= 45 && turn < 135) {
        const cx = shape.x + shape.w / 2;
        const cy = shape.y + shape.h / 2;
        [shape.w, shape.h] = [shape.h, shape.w];
        shape.x = cx - shape.w / 2;
        shape.y = cy - shape.h / 2;
      }

      if (!isLine && !isPicture) applyFill(props, scheme, shape, !isTextBox && type !== 0);
      const lined = flag(props, 511, 0x08) ?? (isLine || (!isTextBox && !isPicture) || props.simple.has(448));
      if (lined) {
        shape.stroke = artColor(props.simple.get(448), scheme) ?? scheme[1] ?? '#000000';
        const lineWidth = props.simple.get(459);
        if (lineWidth) shape.strokeWidth = Math.max(1, lineWidth / EMU_PER_PX);
        if (props.simple.get(462)) shape.dash = true;
        if (props.simple.get(464)) shape.arrowStart = true;
        if (props.simple.get(465)) shape.arrowEnd = true;
      }
      if (flag(props, 575, 0x02)) shape.shadow = true;

      if (isPicture) {
        const image = imageFor(props.simple.get(260) ?? 0);
        if (image) {
          shape.img = image;
          const part = (id: number) => Math.min(0.95, Math.max(0, ((props.simple.get(id) ?? 0) | 0) / 65536));
          const crop = { t: part(256), b: part(257), l: part(258), r: part(259) };
          if (crop.t || crop.b || crop.l || crop.r) shape.crop = crop;
        } else shape.placeholder = 'object'; // EMF/WMF: charts and SmartArt are stored this way in this format
      }

      // The placeholder type is more reliable than the text type: editors often mark body text as "other".
      const forced = placeholder === 13 || placeholder === 15 || placeholder === 1 ? 0 : placeholder === 14 || placeholder === 2 ? 1 : placeholder === 16 ? 5 : -1;
      const visible = texts.filter((t) => t.text.trim()).map((t) => (forced >= 0 && t.kind === 4 ? { ...t, kind: forced } : t));
      // WordArt: the text lies in the shape properties.
      const art = props.complex.get(192);
      if (!visible.length && art && art.length > 2) {
        const text = new TextDecoder('utf-16le').decode(art).replace(/\0+$/, '');
        const size = ((props.simple.get(195) ?? 36 * 65536) | 0) / 65536;
        delete shape.geom;
        delete shape.stroke;
        const color = shape.fill ?? scheme[1];
        delete shape.fill;
        delete shape.gradient;
        shape.paras = text.split(/\r\n?|\n/).map((line) => ({ align: 'center', runs: [{ k: 'text', text: line, s: { size: Math.min(size, Math.max(12, shape.h * 0.55)), b: 1, color } }] }) as SlidePara);
        shape.anchor = 'middle';
      } else if (visible.length) {
        shape.paras = visible.flatMap((t) => toParas(t, scheme, slideNumber));
        const anchor = props.simple.get(135);
        const first = visible[0].kind;
        shape.anchor = anchor === undefined ? (first === 0 || first === 6 ? 'middle' : 'top') : anchor === 1 || anchor === 4 ? 'middle' : anchor === 2 || anchor === 5 ? 'bottom' : 'top';
        const flow = props.simple.get(136);
        if (flow === 2) shape.textRot = 270;
        else if (flow === 1 || flow === 3 || flow === 5) shape.textRot = 90;
      }
      if (!shape.paras && !shape.fill && !shape.stroke && !shape.img && !shape.placeholder && !shape.gradient) continue;
      // An empty placeholder without formatting is not shown.
      if (placeholder >= 0 && !shape.paras && !shape.img) continue;
      out.push(shape);
    }
  };

  /** Background: a separate drawing shape with the "background" flag. */
  const backgroundOf = (holder: Rec | undefined, scheme: string[]): { bg?: string; gradient?: SlideShape['gradient']; img?: string } | undefined => {
    const dg = find(find(holder, T.DRAWING), T.DG);
    if (!dg) return undefined;
    for (const sp of records(dg.start, dg.end)) {
      if (sp.type !== T.SP) continue;
      const fsp = find(sp, T.FSP);
      if (!fsp || !(dv.getUint32(fsp.start + 4, true) & 0x400)) continue;
      const props = readProps(sp);
      const shape: SlideShape = { x: 0, y: 0, w: width, h: height };
      const image = (props.simple.get(384) ?? 0) === 3 ? imageFor(props.simple.get(390) ?? 0) : undefined;
      if (image) return { img: image };
      applyFill(props, scheme, shape, true);
      return { bg: shape.fill, gradient: shape.gradient };
    }
    return undefined;
  };

  // --- slides in show order ---
  const ordered: { rec: Rec; ref: number }[] = [];
  for (const ref of slideOrder) {
    const offset = persist.get(ref);
    const rec = offset !== undefined ? recordAt(offset, data.length) : undefined;
    if (rec && rec.type === T.SLIDE && rec.container) ordered.push({ rec, ref });
  }
  // The directory did not help (an old or damaged file): take slides in file order.
  const slides = ordered.length ? ordered : slideRecs.map((rec, i) => ({ rec, ref: slideOrder[i] ?? -1 }));
  if (!slides.length && !sharedTexts.size) throw new Error('No slides found in the presentation');

  slides.forEach(({ rec, ref }, index) => {
    // A hidden slide is not seen in the show; it is not shown here either.
    const show = find(rec, T.SLIDE_SHOW_INFO);
    if (show && show.end - show.start >= 12 && dv.getUint16(show.start + 10, true) & 0x04) return;
    const atom = find(rec, T.SLIDE_ATOM);
    const flags = atom && atom.end - atom.start >= 22 ? dv.getUint16(atom.start + 20, true) : 0x07;
    const scheme = (flags & 0x02 ? undefined : schemeOf(rec)) ?? masterScheme;
    activeScheme = scheme;
    const slide: Slide = { shapes: [] };
    const bg = (flags & 0x04 ? undefined : backgroundOf(rec, scheme)) ?? backgroundOf(master, masterScheme);
    if (bg?.bg) slide.bg = bg.bg;
    if (bg?.gradient) slide.bgGradient = bg.gradient;
    if (bg?.img) slide.bgImg = bg.img;
    const shared = sharedTexts.get(ref);
    if (flags & 0x01 && master) {
      const dg = find(find(master, T.DRAWING), T.DG);
      if (dg) collectShapes(dg.start, dg.end, undefined, slide.shapes, identity, masterScheme, index + 1, true);
    }
    const dg = find(find(rec, T.DRAWING), T.DG);
    if (dg) collectShapes(dg.start, dg.end, shared, slide.shapes, identity, scheme, index + 1, false);
    if (!slide.shapes.some((s) => s.paras) && shared?.length) {
      // Positions are unknown: show the texts one under another.
      let y = 40;
      for (const item of shared.filter((t) => t.text.trim())) {
        const paras = toParas(item, scheme, index + 1);
        const h = Math.min(height - y - 20, paras.length * (item.kind === 0 || item.kind === 6 ? 70 : 44) + 20);
        slide.shapes.push({ x: 48, y, w: width - 96, h: Math.max(h, 40), paras, anchor: 'top' });
        y += h + 16;
      }
    }
    model.slides.push(slide);
  });
  return model;
}
