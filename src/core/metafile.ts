/**
 * Windows metafiles (EMF and WMF) → SVG.
 * A metafile is a recording of drawing commands; here they are replayed "on paper" and become SVG shapes.
 * Supported: lines, polygons, curves, arcs, paths, text, bitmaps and rectangular clipping.
 * Not supported: EMF+ (GDI+ records), pattern brushes, raster operations other than plain copy and fill.
 */

interface Pen {
  color: string;
  width: number;
  /** 5 is the "null pen". */
  style: number;
}
interface Brush {
  color: string;
  none: boolean;
}
interface Font {
  height: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  escapement: number;
  face: string;
  charset: number;
}
interface GdiObject {
  pen?: Pen;
  brush?: Brush;
  font?: Font;
}

interface State {
  wox: number; woy: number; wex: number; wey: number;
  vox: number; voy: number; vex: number; vey: number;
  /** World transform: m11, m12, m21, m22, dx, dy. */
  xf: number[];
  pen: Pen;
  brush: Brush;
  font: Font;
  textColor: string;
  align: number;
  winding: boolean;
  cx: number; cy: number;
  clip?: number[];
}

const MAX_OUTPUT = 6_000_000;
const DEFAULT_FONT: Font = { height: 0, weight: 400, italic: false, underline: false, strike: false, escapement: 0, face: 'Arial', charset: 0 };

const colorOf = (v: number): string => `#${((1 << 24) | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff)).toString(16).slice(1)}`;
const num = (v: number): string => String(Math.round(v * 100) / 100);
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const CHARSETS: Record<number, string> = { 204: 'windows-1251', 238: 'windows-1250', 161: 'windows-1253', 162: 'windows-1254', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5' };

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** DIB bitmap → BMP file as a data URL. */
function dibUrl(header: Uint8Array, bits: Uint8Array): string | undefined {
  if (header.length < 40 || !bits.length) return undefined;
  const file = new Uint8Array(14 + header.length + bits.length);
  const v = new DataView(file.buffer);
  file[0] = 0x42;
  file[1] = 0x4d;
  v.setUint32(2, file.length, true);
  v.setUint32(10, 14 + header.length, true);
  file.set(header, 14);
  file.set(bits, 14 + header.length);
  return `data:image/bmp;base64,${base64(file)}`;
}

/** Length of the DIB header together with the palette. */
function dibHeaderLength(dib: Uint8Array): number {
  if (dib.length < 40) return 0;
  const v = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const size = v.getUint32(0, true);
  const bpp = v.getUint16(14, true);
  const compression = v.getUint32(16, true);
  let colors = v.getUint32(32, true);
  if (!colors && bpp <= 8) colors = 1 << bpp;
  return size + colors * 4 + (compression === 3 && size === 40 ? 12 : 0);
}

class Gdi {
  readonly out: string[] = [];
  private size = 0;
  private readonly clips = new Map<string, string>();
  private readonly defs: string[] = [];
  readonly stack: State[] = [];
  s: State = {
    wox: 0, woy: 0, wex: 1, wey: 1, vox: 0, voy: 0, vex: 1, vey: 1, xf: [1, 0, 0, 1, 0, 0],
    pen: { color: '#000000', width: 0, style: 0 }, brush: { color: '#ffffff', none: false }, font: DEFAULT_FONT,
    textColor: '#000000', align: 0, winding: false, cx: 0, cy: 0,
  };
  /** An open path (between "begin path" and "end path"). */
  path: string | null = null;
  pathDone = '';
  drawn = 0;

  get full(): boolean {
    return this.size > MAX_OUTPUT;
  }
  save(): void {
    this.stack.push({ ...this.s, xf: [...this.s.xf], clip: this.s.clip ? [...this.s.clip] : undefined });
  }
  restore(n: number): void {
    // A negative number is how many steps back, a positive one is the save number.
    let target = n < 0 ? this.stack.length + n : n - 1;
    target = Math.max(0, Math.min(this.stack.length - 1, target));
    const state = this.stack[target];
    if (!state) return;
    this.stack.length = target;
    this.s = state;
  }
  /** Logical coordinates → sheet coordinates. */
  pt(x: number, y: number): [number, number] {
    const s = this.s;
    const wx = x * s.xf[0] + y * s.xf[2] + s.xf[4];
    const wy = x * s.xf[1] + y * s.xf[3] + s.xf[5];
    return [((wx - s.wox) * s.vex) / s.wex + s.vox, ((wy - s.woy) * s.vey) / s.wey + s.voy];
  }
  scaleX(): number {
    const s = this.s;
    return Math.abs((Math.hypot(s.xf[0], s.xf[1]) * s.vex) / s.wex) || 1;
  }
  scaleY(): number {
    const s = this.s;
    return Math.abs((Math.hypot(s.xf[2], s.xf[3]) * s.vey) / s.wey) || 1;
  }
  p(x: number, y: number): string {
    const [a, b] = this.pt(x, y);
    return `${num(a)} ${num(b)}`;
  }
  private push(text: string): void {
    this.size += text.length;
    if (this.size <= MAX_OUTPUT) this.out.push(text);
  }
  private clipAttr(): string {
    const c = this.s.clip;
    if (!c) return '';
    const key = c.map(num).join(' ');
    let id = this.clips.get(key);
    if (!id) {
      id = `c${this.clips.size}`;
      this.clips.set(key, id);
      this.defs.push(`<clipPath id="${id}"><rect x="${num(c[0])}" y="${num(c[1])}" width="${num(Math.max(0, c[2] - c[0]))}" height="${num(Math.max(0, c[3] - c[1]))}"/></clipPath>`);
    }
    return ` clip-path="url(#${id})"`;
  }
  /** Clipping by a rectangle (in logical coordinates); intersect: intersect with the current one. */
  clipRect(l: number, t: number, r: number, b: number, intersect: boolean): void {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    let c = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    const old = this.s.clip;
    if (intersect && old) c = [Math.max(c[0], old[0]), Math.max(c[1], old[1]), Math.min(c[2], old[2]), Math.min(c[3], old[3])];
    this.s.clip = c;
  }
  private strokeAttrs(): string {
    const pen = this.s.pen;
    if (pen.style === 5) return ' stroke="none"';
    const width = Math.max(1, pen.width * this.scaleX());
    const dash = pen.style === 1 ? ` stroke-dasharray="${num(width * 6)} ${num(width * 3)}"` : pen.style === 2 ? ` stroke-dasharray="${num(width)} ${num(width * 2)}"` : pen.style === 3 || pen.style === 4 ? ` stroke-dasharray="${num(width * 6)} ${num(width * 2)} ${num(width)} ${num(width * 2)}"` : '';
    return ` stroke="${pen.color}" stroke-width="${num(width)}" stroke-linejoin="round"${dash}`;
  }
  /** A finished path in sheet coordinates. */
  shape(d: string, fill: boolean, stroke: boolean): void {
    if (!d) return;
    const brush = this.s.brush;
    const fillAttr = fill && !brush.none ? ` fill="${brush.color}"${this.s.winding ? '' : ' fill-rule="evenodd"'}` : ' fill="none"';
    const strokeAttr = stroke ? this.strokeAttrs() : ' stroke="none"';
    if (fillAttr === ' fill="none"' && strokeAttr === ' stroke="none"') return;
    this.push(`<path d="${d}"${fillAttr}${strokeAttr}${this.clipAttr()}/>`);
    this.drawn++;
  }
  /** A shape either extends the open path or is drawn at once. */
  figure(d: string, fill: boolean, stroke = true): void {
    if (this.path !== null) this.path += d;
    else this.shape(d, fill, stroke);
  }
  poly(points: number[], close: boolean): string {
    let d = '';
    for (let i = 0; i + 1 < points.length; i += 2) d += `${i ? 'L' : 'M'}${this.p(points[i], points[i + 1])}`;
    return d && close ? `${d}Z` : d;
  }
  rect(l: number, t: number, r: number, b: number): string {
    return `M${this.p(l, t)}L${this.p(r, t)}L${this.p(r, b)}L${this.p(l, b)}Z`;
  }
  fillRect(l: number, t: number, r: number, b: number, color: string): void {
    this.push(`<path d="${this.rect(l, t, r, b)}" fill="${color}"${this.clipAttr()}/>`);
    this.drawn++;
  }
  ellipse(l: number, t: number, r: number, b: number): string {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    const rx = Math.abs(x1 - x0) / 2;
    const ry = Math.abs(y1 - y0) / 2;
    const cy = (y0 + y1) / 2;
    const left = Math.min(x0, x1);
    return `M${num(left)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(left + rx * 2)} ${num(cy)}A${num(rx)} ${num(ry)} 0 1 0 ${num(left)} ${num(cy)}Z`;
  }
  roundRect(l: number, t: number, r: number, b: number, cw: number, ch: number): string {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    const rx = Math.min(w / 2, (Math.abs(cw) * this.scaleX()) / 2);
    const ry = Math.min(h / 2, (Math.abs(ch) * this.scaleY()) / 2);
    return `M${num(x + rx)} ${num(y)}H${num(x + w - rx)}A${num(rx)} ${num(ry)} 0 0 1 ${num(x + w)} ${num(y + ry)}V${num(y + h - ry)}A${num(rx)} ${num(ry)} 0 0 1 ${num(x + w - rx)} ${num(y + h)}H${num(x + rx)}A${num(rx)} ${num(ry)} 0 0 1 ${num(x)} ${num(y + h - ry)}V${num(y + ry)}A${num(rx)} ${num(ry)} 0 0 1 ${num(x + rx)} ${num(y)}Z`;
  }
  /** Ellipse arc counter-clockwise from the "start" ray to the "end" ray; kind: 0 arc, 1 pie, 2 chord. */
  arc(l: number, t: number, r: number, b: number, sx: number, sy: number, ex: number, ey: number, kind: number): string {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2 || 1;
    const ry = Math.abs(y1 - y0) / 2 || 1;
    const [ax, ay] = this.pt(sx, sy);
    const [bx, by] = this.pt(ex, ey);
    const a1 = Math.atan2(-(ay - cy) / ry, (ax - cx) / rx);
    const a2 = Math.atan2(-(by - cy) / ry, (bx - cx) / rx);
    let extent = a2 - a1;
    while (extent <= 0) extent += Math.PI * 2;
    const from = `${num(cx + rx * Math.cos(a1))} ${num(cy - ry * Math.sin(a1))}`;
    const to = `${num(cx + rx * Math.cos(a2))} ${num(cy - ry * Math.sin(a2))}`;
    let d: string;
    if (extent > Math.PI * 2 - 1e-6) d = this.ellipse(l, t, r, b).replace(/Z$/, '');
    else d = `M${from}A${num(rx)} ${num(ry)} 0 ${extent > Math.PI ? 1 : 0} 0 ${to}`;
    if (kind === 1) d += `L${num(cx)} ${num(cy)}Z`;
    else if (kind === 2) d += 'Z';
    return d;
  }
  text(x: number, y: number, text: string, dx?: number[]): void {
    const s = this.s;
    const font = s.font;
    const useCurrent = (s.align & 1) !== 0;
    if (useCurrent) {
      x = s.cx;
      y = s.cy;
    }
    const clean = text.replace(/\0+$/, '');
    const em = (font.height < 0 ? -font.height : font.height > 0 ? font.height * 0.87 : 12) * this.scaleY();
    const width = dx && dx.length >= clean.length ? dx.slice(0, clean.length).reduce((a, b) => a + b, 0) : clean.length * Math.abs(font.height || 12) * 0.5;
    if (useCurrent) s.cx += width;
    if (!clean.trim() || em < 0.5) return;
    const [px, py] = this.pt(x, y);
    const horizontal = s.align & 6;
    const anchor = horizontal === 6 ? 'middle' : horizontal === 2 ? 'end' : 'start';
    const vertical = s.align & 24;
    const dy = vertical === 24 ? 0 : vertical === 8 ? -em * 0.22 : em * 0.9;
    const attrs = [`x="${num(px)}"`, `y="${num(py + dy)}"`, `font-family="${esc(font.face)}, sans-serif"`, `font-size="${num(em)}"`, `fill="${s.textColor}"`];
    if (anchor !== 'start') attrs.push(`text-anchor="${anchor}"`);
    if (font.weight >= 600) attrs.push('font-weight="bold"');
    if (font.italic) attrs.push('font-style="italic"');
    if (font.underline || font.strike) attrs.push(`text-decoration="${[font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].join(' ').trim()}"`);
    // String width from the file: the device font may differ, yet the string must take the same room.
    if (dx && dx.length >= clean.length && clean.length > 1) {
      const length = width * this.scaleX();
      if (length > 1) attrs.push(`textLength="${num(length)}"`);
    }
    if (font.escapement) attrs.push(`transform="rotate(${num(-font.escapement / 10)} ${num(px)} ${num(py)})"`);
    this.push(`<text ${attrs.join(' ')} xml:space="preserve"${this.clipAttr()}>${esc(clean)}</text>`);
    this.drawn++;
  }
  image(x: number, y: number, w: number, h: number, header: Uint8Array, bits: Uint8Array): void {
    const url = dibUrl(header, bits);
    if (!url) return;
    const [x0, y0] = this.pt(x, y);
    const [x1, y1] = this.pt(x + w, y + h);
    this.push(`<image x="${num(Math.min(x0, x1))}" y="${num(Math.min(y0, y1))}" width="${num(Math.abs(x1 - x0))}" height="${num(Math.abs(y1 - y0))}" preserveAspectRatio="none" href="${url}"${this.clipAttr()}/>`);
    this.drawn++;
  }
  /** Raster operation without a picture: fill with the brush, black or white. */
  patBlt(x: number, y: number, w: number, h: number, rop: number): void {
    const color = rop === 0x00f00021 ? (this.s.brush.none ? undefined : this.s.brush.color) : rop === 0x00000042 ? '#000000' : rop === 0x00ff0062 ? '#ffffff' : undefined;
    if (color) this.fillRect(x, y, x + w, y + h, color);
  }
  svg(x: number, y: number, w: number, h: number, pxW: number, pxH: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(pxW)}" height="${num(pxH)}" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" preserveAspectRatio="none">${this.defs.length ? `<defs>${this.defs.join('')}</defs>` : ''}${this.out.join('')}</svg>`;
  }
}

const STOCK: Record<number, GdiObject> = {
  0: { brush: { color: '#ffffff', none: false } }, 1: { brush: { color: '#c0c0c0', none: false } }, 2: { brush: { color: '#808080', none: false } },
  3: { brush: { color: '#404040', none: false } }, 4: { brush: { color: '#000000', none: false } }, 5: { brush: { color: '#000000', none: true } },
  6: { pen: { color: '#ffffff', width: 0, style: 0 } }, 7: { pen: { color: '#000000', width: 0, style: 0 } }, 8: { pen: { color: '#000000', width: 0, style: 5 } },
  10: { font: DEFAULT_FONT }, 11: { font: DEFAULT_FONT }, 12: { font: DEFAULT_FONT }, 13: { font: DEFAULT_FONT }, 14: { font: DEFAULT_FONT }, 16: { font: DEFAULT_FONT }, 17: { font: DEFAULT_FONT },
};

function select(g: Gdi, object: GdiObject | undefined): void {
  if (!object) return;
  if (object.pen) g.s.pen = object.pen;
  if (object.brush) g.s.brush = object.brush;
  if (object.font) g.s.font = object.font;
}

function emfToSvg(data: Uint8Array): string | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 88 || v.getUint32(0, true) !== 1 || v.getUint32(40, true) !== 0x464d4520) return null;
  let bl = v.getInt32(8, true), bt = v.getInt32(12, true), br = v.getInt32(16, true), bb = v.getInt32(20, true);
  const fl = v.getInt32(24, true), ft = v.getInt32(28, true), fr = v.getInt32(32, true), fb = v.getInt32(36, true);
  const devW = v.getInt32(72, true), devH = v.getInt32(76, true), mmW = v.getInt32(80, true), mmH = v.getInt32(84, true);
  if (br <= bl || bb <= bt) {
    // Bounds are not recorded: derive them from the sheet size in hundredths of a millimetre.
    const kx = mmW > 0 ? devW / (mmW * 100) : 0.0378;
    const ky = mmH > 0 ? devH / (mmH * 100) : 0.0378;
    bl = Math.round(fl * kx); bt = Math.round(ft * ky); br = Math.round(fr * kx); bb = Math.round(fb * ky);
  }
  if (br <= bl || bb <= bt) return null;
  const pxW = fr > fl ? ((fr - fl) / 2540) * 96 : br - bl + 1;
  const pxH = fb > ft ? ((fb - ft) / 2540) * 96 : bb - bt + 1;

  const g = new Gdi();
  const objects = new Map<number, GdiObject>();
  const i32 = (at: number) => v.getInt32(at, true);
  const u32 = (at: number) => v.getUint32(at, true);
  const points32 = (at: number, count: number, end: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count && at + i * 8 + 8 <= end; i++) out.push(i32(at + i * 8), i32(at + i * 8 + 4));
    return out;
  };
  const points16 = (at: number, count: number, end: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count && at + i * 4 + 4 <= end; i++) out.push(v.getInt16(at + i * 4, true), v.getInt16(at + i * 4 + 2, true));
    return out;
  };
  const bezier = (pts: number[], from: number): string => {
    let d = '';
    for (let i = from; i + 5 < pts.length; i += 6) d += `C${g.p(pts[i], pts[i + 1])} ${g.p(pts[i + 2], pts[i + 3])} ${g.p(pts[i + 4], pts[i + 5])}`;
    return d;
  };
  const lineTo = (pts: number[]): string => {
    let d = '';
    for (let i = 0; i + 1 < pts.length; i += 2) d += `L${g.p(pts[i], pts[i + 1])}`;
    return d;
  };
  /** Continuation from the current point: into the open path or as a separate line. */
  const continueFrom = (d: string, lastX: number, lastY: number): void => {
    if (g.path !== null) {
      if (!g.path) g.path = `M${g.p(g.s.cx, g.s.cy)}`;
      g.path += d;
    } else g.shape(`M${g.p(g.s.cx, g.s.cy)}${d}`, false, true);
    g.s.cx = lastX;
    g.s.cy = lastY;
  };
  const multiply = (a: number[], b: number[]): number[] => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const dib = (rec: number, offBmi: number, cbBmi: number, offBits: number, cbBits: number, end: number): [Uint8Array, Uint8Array] | undefined => {
    if (!cbBmi || !cbBits || rec + offBmi + cbBmi > end || rec + offBits + cbBits > end) return undefined;
    return [data.subarray(rec + offBmi, rec + offBmi + cbBmi), data.subarray(rec + offBits, rec + offBits + cbBits)];
  };

  let pos = 0;
  for (let guard = 0; pos + 8 <= data.length && guard < 400_000 && !g.full; guard++) {
    const type = u32(pos);
    const size = u32(pos + 4);
    if (size < 8 || pos + size > data.length) break;
    const a = pos + 8;
    const end = pos + size;
    const s = g.s;
    switch (type) {
      case 9: s.wex = i32(a) || 1; s.wey = i32(a + 4) || 1; break;
      case 10: s.wox = i32(a); s.woy = i32(a + 4); break;
      case 11: s.vex = i32(a) || 1; s.vey = i32(a + 4) || 1; break;
      case 12: s.vox = i32(a); s.voy = i32(a + 4); break;
      case 17: {
        // Modes with a fixed unit: computed through the device size.
        const mode = i32(a);
        const perMm = mmW > 0 ? devW / mmW : 3.78;
        const unit = mode === 2 ? 0.1 : mode === 3 ? 0.01 : mode === 4 ? 0.254 : mode === 5 ? 0.0254 : mode === 6 ? 25.4 / 1440 : 0;
        if (mode === 1) { s.wex = s.wey = s.vex = s.vey = 1; }
        else if (unit) { s.wex = 1; s.wey = 1; s.vex = unit * perMm; s.vey = -unit * perMm; }
        break;
      }
      case 19: s.winding = i32(a) === 2; break;
      case 22: s.align = u32(a); break;
      case 24: s.textColor = colorOf(u32(a)); break;
      case 27: s.cx = i32(a); s.cy = i32(a + 4); if (g.path !== null) g.path += `M${g.p(s.cx, s.cy)}`; break;
      case 30: g.clipRect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12), true); break;
      case 33: g.save(); break;
      case 34: g.restore(i32(a)); break;
      case 35: s.xf = [v.getFloat32(a, true), v.getFloat32(a + 4, true), v.getFloat32(a + 8, true), v.getFloat32(a + 12, true), v.getFloat32(a + 16, true), v.getFloat32(a + 20, true)]; break;
      case 36: {
        const m = [v.getFloat32(a, true), v.getFloat32(a + 4, true), v.getFloat32(a + 8, true), v.getFloat32(a + 12, true), v.getFloat32(a + 16, true), v.getFloat32(a + 20, true)];
        const mode = u32(a + 24);
        s.xf = mode === 1 ? [1, 0, 0, 1, 0, 0] : mode === 2 ? multiply(m, s.xf) : mode === 3 ? multiply(s.xf, m) : m;
        break;
      }
      case 37: {
        const id = u32(a);
        select(g, id & 0x80000000 ? STOCK[id & 0x7fffffff] : objects.get(id));
        break;
      }
      case 38: objects.set(u32(a), { pen: { style: u32(a + 4) & 0xf, width: i32(a + 8), color: colorOf(u32(a + 16)) } }); break;
      case 95: if (size >= 44) objects.set(u32(a), { pen: { style: u32(a + 20) & 0xf, width: u32(a + 24), color: colorOf(u32(a + 32)) } }); break;
      case 39: objects.set(u32(a), { brush: { none: u32(a + 4) === 1, color: colorOf(u32(a + 8)) } }); break;
      // Pattern brushes cannot be drawn: replaced with a grey fill.
      case 93: case 94: objects.set(u32(a), { brush: { none: false, color: '#c0c0c0' } }); break;
      case 82: {
        if (size < 8 + 4 + 92) break;
        const f = a + 4;
        let face = '';
        for (let i = 0; i < 32; i++) {
          const ch = v.getUint16(f + 28 + i * 2, true);
          if (!ch) break;
          face += String.fromCharCode(ch);
        }
        objects.set(u32(a), { font: { height: i32(f), escapement: i32(f + 8), weight: i32(f + 16), italic: data[f + 20] !== 0, underline: data[f + 21] !== 0, strike: data[f + 22] !== 0, charset: data[f + 23], face: face || 'Arial' } });
        break;
      }
      case 40: objects.delete(u32(a)); break;
      case 2: case 85: {
        const pts = type === 2 ? points32(a + 20, u32(a + 16), end) : points16(a + 20, u32(a + 16), end);
        if (pts.length >= 8) g.figure(`M${g.p(pts[0], pts[1])}${bezier(pts, 2)}`, false);
        break;
      }
      case 3: case 86: {
        const pts = type === 3 ? points32(a + 20, u32(a + 16), end) : points16(a + 20, u32(a + 16), end);
        g.figure(g.poly(pts, true), true);
        break;
      }
      case 4: case 87: {
        const pts = type === 4 ? points32(a + 20, u32(a + 16), end) : points16(a + 20, u32(a + 16), end);
        g.figure(g.poly(pts, false), false);
        break;
      }
      case 5: case 88: {
        const pts = type === 5 ? points32(a + 20, u32(a + 16), end) : points16(a + 20, u32(a + 16), end);
        if (pts.length >= 6) continueFrom(bezier(pts, 0), pts[pts.length - 2], pts[pts.length - 1]);
        break;
      }
      case 6: case 89: {
        const pts = type === 6 ? points32(a + 20, u32(a + 16), end) : points16(a + 20, u32(a + 16), end);
        if (pts.length >= 2) continueFrom(lineTo(pts), pts[pts.length - 2], pts[pts.length - 1]);
        break;
      }
      case 7: case 8: case 90: case 91: {
        const polys = u32(a + 16);
        const total = u32(a + 20);
        if (polys > 100_000 || a + 24 + polys * 4 > end) break;
        const wide = type === 7 || type === 8;
        const pts = wide ? points32(a + 24 + polys * 4, total, end) : points16(a + 24 + polys * 4, total, end);
        const closed = type === 8 || type === 91;
        let d = '';
        let from = 0;
        for (let i = 0; i < polys; i++) {
          const count = u32(a + 24 + i * 4);
          d += g.poly(pts.slice(from * 2, (from + count) * 2), closed);
          from += count;
        }
        g.figure(d, closed);
        break;
      }
      case 42: g.figure(g.ellipse(i32(a), i32(a + 4), i32(a + 8), i32(a + 12)), true); break;
      case 43: g.figure(g.rect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12)), true); break;
      case 44: g.figure(g.roundRect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12), i32(a + 16), i32(a + 20)), true); break;
      case 45: case 46: case 47: case 55: {
        const d = g.arc(i32(a), i32(a + 4), i32(a + 8), i32(a + 12), i32(a + 16), i32(a + 20), i32(a + 24), i32(a + 28), type === 47 ? 1 : type === 46 ? 2 : 0);
        if (type === 55) {
          continueFrom(d.replace(/^M/, 'L'), i32(a + 24), i32(a + 28));
        } else g.figure(d, type !== 45);
        break;
      }
      case 54: continueFrom(`L${g.p(i32(a), i32(a + 4))}`, i32(a), i32(a + 4)); break;
      case 59: g.path = ''; break;
      case 60: g.pathDone = g.path ?? ''; g.path = null; break;
      case 61: if (g.path !== null) g.path += 'Z'; break;
      case 62: g.shape(g.pathDone, true, false); g.pathDone = ''; break;
      case 63: g.shape(g.pathDone, true, true); g.pathDone = ''; break;
      case 64: g.shape(g.pathDone, false, true); g.pathDone = ''; break;
      case 67: g.pathDone = ''; break;
      case 75: {
        // Clip region: take its bounding rectangle (in device coordinates).
        const bytes = u32(a);
        const mode = u32(a + 4);
        if (!bytes || mode !== 5 || a + 8 + 32 > end) { if (mode === 5) s.clip = undefined; break; }
        const r = a + 8 + 16;
        s.clip = [i32(r), i32(r + 4), i32(r + 8), i32(r + 12)];
        break;
      }
      case 76: case 77: {
        const x = i32(a + 16), y = i32(a + 20), w = i32(a + 24), h = i32(a + 28);
        const rop = u32(a + 32);
        const bitmap = dib(pos, u32(a + 76), u32(a + 80), u32(a + 84), u32(a + 88), end);
        if (bitmap) g.image(x, y, w, h, bitmap[0], bitmap[1]);
        else g.patBlt(x, y, w, h, rop);
        break;
      }
      case 81: {
        const bitmap = dib(pos, u32(a + 40), u32(a + 44), u32(a + 48), u32(a + 52), end);
        if (bitmap) g.image(i32(a + 16), i32(a + 20), i32(a + 64), i32(a + 68), bitmap[0], bitmap[1]);
        break;
      }
      case 83: case 84: {
        if (size < 76) break;
        const x = i32(a + 28), y = i32(a + 32);
        const count = u32(a + 36);
        const offString = u32(a + 40);
        const offDx = u32(a + 64);
        if (!count || count > 100_000) break;
        let text = '';
        if (type === 84) {
          if (pos + offString + count * 2 > end) break;
          for (let i = 0; i < count; i++) text += String.fromCharCode(v.getUint16(pos + offString + i * 2, true));
        } else {
          if (pos + offString + count > end) break;
          text = new TextDecoder(CHARSETS[s.font.charset] ?? 'windows-1252').decode(data.subarray(pos + offString, pos + offString + count));
        }
        const dx: number[] = [];
        if (offDx && pos + offDx + count * 4 <= end) for (let i = 0; i < count; i++) dx.push(u32(pos + offDx + i * 4));
        g.text(x, y, text, dx.length ? dx : undefined);
        break;
      }
      case 108: {
        const count = u32(a + 8);
        const options = u32(a + 12);
        const at = a + 28 + (options & 0x100 ? 0 : 16);
        let text = '';
        if (options & 0x200) for (let i = 0; i < count && at + i < end; i++) text += String.fromCharCode(data[at + i]);
        else for (let i = 0; i < count && at + i * 2 + 2 <= end; i++) text += String.fromCharCode(v.getUint16(at + i * 2, true));
        g.text(i32(a), i32(a + 4), text);
        break;
      }
      case 14: pos = data.length; continue;
    }
    pos = end;
  }
  if (!g.drawn) return null;
  return g.svg(bl, bt, br - bl + 1, bb - bt + 1, pxW, pxH);
}

function wmfToSvg(data: Uint8Array): string | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  let box: number[] | undefined;
  let inch = 1440;
  if (data.length >= 22 && v.getUint32(0, true) === 0x9ac6cdd7) {
    box = [v.getInt16(6, true), v.getInt16(8, true), v.getInt16(10, true), v.getInt16(12, true)];
    inch = v.getUint16(14, true) || 1440;
    pos = 22;
  }
  if (pos + 18 > data.length) return null;
  const headerType = v.getUint16(pos, true);
  const headerSize = v.getUint16(pos + 2, true);
  if ((headerType !== 1 && headerType !== 2) || headerSize !== 9) return null;
  pos += headerSize * 2;

  const g = new Gdi();
  const s0 = g.s;
  // The drawing sheet is a rectangle from zero the size of the window; the window comes from the placeable header or the first command.
  let view: number[] | undefined;
  if (box) {
    s0.wox = box[0]; s0.woy = box[1]; s0.wex = box[2] - box[0] || 1; s0.wey = box[3] - box[1] || 1;
    view = [Math.abs(s0.wex), Math.abs(s0.wey)];
    s0.vex = view[0]; s0.vey = view[1];
  }
  const objects: (GdiObject | undefined)[] = [];
  const add = (object: GdiObject) => {
    const free = objects.findIndex((o) => o === undefined);
    if (free >= 0) objects[free] = object;
    else objects.push(object);
  };
  const i16 = (at: number) => v.getInt16(at, true);
  const u16 = (at: number) => v.getUint16(at, true);
  const decodeText = (at: number, count: number) => new TextDecoder(CHARSETS[g.s.font.charset] ?? 'windows-1252').decode(data.subarray(at, at + count));
  const bitmapAt = (at: number, end: number): [Uint8Array, Uint8Array] | undefined => {
    const dibBytes = data.subarray(at, end);
    const headerLength = dibHeaderLength(dibBytes);
    if (!headerLength || headerLength >= dibBytes.length) return undefined;
    return [dibBytes.subarray(0, headerLength), dibBytes.subarray(headerLength)];
  };

  for (let guard = 0; pos + 6 <= data.length && guard < 400_000 && !g.full; guard++) {
    const size = v.getUint32(pos, true) * 2;
    const fn = u16(pos + 4);
    if (size < 6 || pos + size > data.length || fn === 0) break;
    const a = pos + 6;
    const end = pos + size;
    const s = g.s;
    switch (fn) {
      case 0x020b: s.woy = i16(a); s.wox = i16(a + 2); break;
      case 0x020c:
        s.wey = i16(a) || 1; s.wex = i16(a + 2) || 1;
        if (!view) view = [Math.abs(s.wex), Math.abs(s.wey)];
        s.vex = view[0]; s.vey = view[1];
        break;
      case 0x0106: s.winding = u16(a) === 2; break;
      case 0x012e: s.align = u16(a); break;
      case 0x0209: s.textColor = colorOf(v.getUint32(a, true)); break;
      case 0x001e: g.save(); break;
      case 0x0127: g.restore(i16(a)); break;
      case 0x02fa: add({ pen: { style: u16(a) & 0xf, width: i16(a + 2), color: colorOf(v.getUint32(a + 6, true)) } }); break;
      case 0x02fc: add({ brush: { none: u16(a) === 1, color: colorOf(v.getUint32(a + 2, true)) } }); break;
      case 0x02fb: {
        if (size < 6 + 18) { add({}); break; }
        let nameEnd = a + 18;
        while (nameEnd < end && data[nameEnd]) nameEnd++;
        const charset = data[a + 13];
        const face = new TextDecoder(CHARSETS[charset] ?? 'windows-1252').decode(data.subarray(a + 18, nameEnd));
        add({ font: { height: i16(a), escapement: i16(a + 4), weight: i16(a + 8), italic: data[a + 10] !== 0, underline: data[a + 11] !== 0, strike: data[a + 12] !== 0, charset, face: face || 'Arial' } });
        break;
      }
      // Objects that are not drawn but occupy a slot in the object table.
      case 0x00f7: case 0x06ff: case 0x02fd: case 0x06fe: add({}); break;
      case 0x01f9: case 0x0142: add({ brush: { none: false, color: '#c0c0c0' } }); break;
      case 0x012d: select(g, objects[u16(a)]); break;
      case 0x01f0: objects[u16(a)] = undefined; break;
      case 0x0214: s.cy = i16(a); s.cx = i16(a + 2); break;
      case 0x0213: {
        const y = i16(a), x = i16(a + 2);
        g.shape(`M${g.p(s.cx, s.cy)}L${g.p(x, y)}`, false, true);
        s.cx = x; s.cy = y;
        break;
      }
      case 0x0324: case 0x0325: {
        const count = u16(a);
        const pts: number[] = [];
        for (let i = 0; i < count && a + 2 + i * 4 + 4 <= end; i++) pts.push(i16(a + 2 + i * 4), i16(a + 4 + i * 4));
        g.shape(g.poly(pts, fn === 0x0324), fn === 0x0324, true);
        break;
      }
      case 0x0538: {
        const polys = u16(a);
        let at = a + 2 + polys * 2;
        let d = '';
        for (let i = 0; i < polys && a + 2 + i * 2 + 2 <= end; i++) {
          const count = u16(a + 2 + i * 2);
          const pts: number[] = [];
          for (let k = 0; k < count && at + 4 <= end; k++, at += 4) pts.push(i16(at), i16(at + 2));
          d += g.poly(pts, true);
        }
        g.shape(d, true, true);
        break;
      }
      case 0x041b: g.shape(g.rect(i16(a + 6), i16(a + 4), i16(a + 2), i16(a)), true, true); break;
      case 0x0418: g.shape(g.ellipse(i16(a + 6), i16(a + 4), i16(a + 2), i16(a)), true, true); break;
      case 0x061c: g.shape(g.roundRect(i16(a + 10), i16(a + 8), i16(a + 6), i16(a + 4), i16(a + 2), i16(a)), true, true); break;
      case 0x0817: case 0x081a: case 0x0830:
        g.shape(g.arc(i16(a + 14), i16(a + 12), i16(a + 10), i16(a + 8), i16(a + 6), i16(a + 4), i16(a + 2), i16(a), fn === 0x081a ? 1 : fn === 0x0830 ? 2 : 0), fn !== 0x0817, true);
        break;
      case 0x0416: g.clipRect(i16(a + 6), i16(a + 4), i16(a + 2), i16(a), true); break;
      case 0x0521: {
        const count = u16(a);
        const at = a + 2 + count + (count & 1);
        if (at + 4 <= end) g.text(i16(at + 2), i16(at), decodeText(a + 2, count));
        break;
      }
      case 0x0a32: {
        const y = i16(a), x = i16(a + 2);
        const count = u16(a + 4);
        const options = u16(a + 6);
        const at = a + 8 + (options & 6 ? 8 : 0);
        if (at + count > end) break;
        const dxAt = at + count + (count & 1);
        const dx: number[] = [];
        if (dxAt + count * 2 <= end) for (let i = 0; i < count; i++) dx.push(i16(dxAt + i * 2));
        g.text(x, y, decodeText(at, count), dx.length ? dx : undefined);
        break;
      }
      case 0x061d: g.patBlt(i16(a + 10), i16(a + 8), i16(a + 6), i16(a + 4), v.getUint32(a, true)); break;
      case 0x0f43: {
        const bitmap = bitmapAt(a + 22, end);
        if (bitmap) g.image(i16(a + 20), i16(a + 18), i16(a + 16), i16(a + 14), bitmap[0], bitmap[1]);
        break;
      }
      case 0x0b41: {
        const bitmap = size > 6 + 22 ? bitmapAt(a + 20, end) : undefined;
        if (bitmap) g.image(i16(a + 18), i16(a + 16), i16(a + 14), i16(a + 12), bitmap[0], bitmap[1]);
        else if (size >= 6 + 20) g.patBlt(i16(a + 18), i16(a + 16), i16(a + 14), i16(a + 12), v.getUint32(a, true));
        break;
      }
      case 0x0940: {
        const bitmap = size > 6 + 18 ? bitmapAt(a + 16, end) : undefined;
        if (bitmap) g.image(i16(a + 14), i16(a + 12), i16(a + 10), i16(a + 8), bitmap[0], bitmap[1]);
        break;
      }
    }
    pos = end;
  }
  if (!g.drawn || !view) return null;
  return g.svg(0, 0, view[0], view[1], (view[0] / inch) * 96, (view[1] / inch) * 96);
}

/** Detects the metafile kind by content: 'emf', 'wmf' or undefined. */
export function metafileKind(data: Uint8Array): 'emf' | 'wmf' | undefined {
  if (data.length < 18) return undefined;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 44 && v.getUint32(0, true) === 1 && v.getUint32(40, true) === 0x464d4520) return 'emf';
  if (v.getUint32(0, true) === 0x9ac6cdd7) return 'wmf';
  if ((v.getUint16(0, true) === 1 || v.getUint16(0, true) === 2) && v.getUint16(2, true) === 9 && (v.getUint16(4, true) === 0x0300 || v.getUint16(4, true) === 0x0100)) return 'wmf';
  return undefined;
}

/** EMF or WMF metafile → SVG text; null if it cannot be parsed or there is nothing to draw. */
export function metafileToSvg(data: Uint8Array): string | null {
  try {
    const kind = metafileKind(data);
    return kind === 'emf' ? emfToSvg(data) : kind === 'wmf' ? wmfToSvg(data) : null;
  } catch {
    return null;
  }
}

/** A metafile as a picture for the document model. */
export function metafileImage(data: Uint8Array): { mime: string; data: ArrayBuffer } | undefined {
  const svg = metafileToSvg(data);
  if (!svg) return undefined;
  return { mime: 'image/svg+xml', data: new TextEncoder().encode(svg).buffer as ArrayBuffer };
}
