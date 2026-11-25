/**
 * Saving and printing the opened file. Loaded on first use: most viewers never need it.
 *
 * Printing happens in a hidden same-origin iframe, so the page that embeds the viewer is not printed along
 * and its styles do not leak into the printout. The frame is filled with DOM APIs only (no markup strings).
 */
import { STYLES } from './styles';

/** Hands a Blob to the browser as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  saveUrl(url, name);
  // The download starts asynchronously; the URL must outlive the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Downloads by URL. For another origin the browser ignores `download` and opens the file, so it goes to a new tab. */
export function saveUrl(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name || 'file';
  link.rel = 'noopener';
  if (!url.startsWith('blob:') && !url.startsWith('data:')) link.target = '_blank';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const PRINT_STYLES = /* css */ `
:root {
  height: auto;
  min-height: 0;
  color-scheme: light;
  --fv-bg: #ffffff; --fv-surface: #ffffff; --fv-text: #1f2328; --fv-muted: #6b7280;
  --fv-border: #d9dde3; --fv-head-bg: #f6f7f9; --fv-accent: #1d4ed8;
}
html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2328; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.fv-print, .fv-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.fv-print > * { position: static; }
.fv-print .fv-doc, .fv-print .fv-slides, .fv-print .fv-text, .fv-print .fv-archive {
  position: static; overflow: visible; height: auto; padding: 0; background: none;
}
.fv-print .fv-doc-page { zoom: 1 !important; margin: 0 auto; box-shadow: none; min-height: 0; }
.fv-print .fv-doc-section, .fv-print .fv-slide-frame, .fv-print .fv-text-chunk { content-visibility: visible; contain-intrinsic-size: none !important; }
.fv-print .fv-doc-watermark { position: fixed; }
.fv-print .fv-text { font-size: 12px !important; padding: 0; }
.fv-print .fv-slides-list { width: auto; min-width: 0; gap: 0; }
.fv-print .fv-slide-frame { box-shadow: none; margin: 0 auto; break-inside: avoid; break-after: page; }
.fv-print .fv-slide-frame:last-child { break-after: auto; }
.fv-print .fv-archive-table th { position: static; }
.fv-print-image { display: block; max-width: 100%; max-height: 100vh; margin: 0 auto; }
.fv-print-caption { margin: 0 0 8px; font-weight: 600; }
.fv-print-table { border-collapse: collapse; font-size: 11px; line-height: 1.3; }
.fv-print-table td { border: 1px solid #d9dde3; padding: 2px 5px; vertical-align: bottom; white-space: pre-wrap; overflow-wrap: anywhere; }
.fv-print-table td.fv-num { text-align: right; font-variant-numeric: tabular-nums; }
.fv-print-table tr { break-inside: avoid; }
.fv-print-note { margin: 8px 0 0; color: #6b7280; font-size: 12px; }
`;

let activeFrame: HTMLIFrameElement | null = null;
let activeCleanup: (() => void) | null = null;

/** Removes the print frame left by the previous printout (some browsers never report that printing ended). */
export function disposePrint(): void {
  activeFrame?.remove();
  activeFrame = null;
  activeCleanup?.();
  activeCleanup = null;
}

function mountFrame(cleanup?: () => void): HTMLIFrameElement {
  disposePrint();
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // A real size (A4 at 96 dpi) so that the content is laid out before printing; kept off screen.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(frame);
  activeFrame = frame;
  activeCleanup = cleanup ?? null;
  return frame;
}

function run(frame: HTMLIFrameElement): void {
  const win = frame.contentWindow;
  if (!win) throw new Error('print frame is not available');
  win.addEventListener('afterprint', () => setTimeout(() => activeFrame === frame && disposePrint(), 1000), { once: true });
  win.focus();
  win.print();
}

/** Prints a PDF with the browser's own PDF engine: the original file, not its picture on screen. */
export async function printPdf(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }));
  const frame = mountFrame(() => URL.revokeObjectURL(url));
  await new Promise<void>((resolve) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.src = url;
  });
  // The built-in PDF viewer needs a moment after `load` before it can print.
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    run(frame);
  } catch {
    // No PDF viewer inside frames (some mobile browsers): open the file, the user prints from there.
    window.open(url, '_blank', 'noopener');
  }
}

export interface PrintOptions {
  title?: string;
  landscape?: boolean;
  /** Page margins as a CSS value. Documents bring their own side margins. */
  margin?: string;
  /** Print a copy of the node (the node belongs to the screen). Default: true. */
  clone?: boolean;
}

/** Prints an element: a copy of rendered content, or content built for printing. */
export async function printNode(content: HTMLElement, options: PrintOptions = {}): Promise<void> {
  const frame = mountFrame();
  const doc = frame.contentDocument;
  if (!doc) throw new Error('print frame is not available');
  doc.title = options.title ?? '';
  const style = doc.createElement('style');
  // The viewer styles are written for a shadow root; in the frame the variables live on the root element.
  style.textContent = `${STYLES.replace(/:host\b/g, ':root')}\n${PRINT_STYLES}\n@page { margin: ${options.margin ?? '12mm'};${options.landscape ? ' size: landscape;' : ''} }`;
  doc.head.appendChild(style);

  const copy = doc.importNode(content, true);
  if (options.clone !== false) {
    // A cloned canvas is blank: carry the pixels over as images.
    const sources = Array.from(content.querySelectorAll('canvas'));
    Array.from(copy.querySelectorAll('canvas')).forEach((canvas, i) => {
      try {
        const img = doc.createElement('img');
        img.className = canvas.className;
        img.style.cssText = canvas.style.cssText;
        img.src = sources[i].toDataURL('image/png');
        canvas.replaceWith(img);
      } catch {
        /* a tainted or released canvas: leave it empty */
      }
    });
  }
  const wrap = doc.createElement('div');
  wrap.className = 'fv-print';
  wrap.appendChild(copy);
  doc.body.appendChild(wrap);

  // Slides are sized for the screen: fit each one to a landscape page instead.
  const firstSlide = copy.querySelector<HTMLElement>('.fv-slide-frame');
  const list = copy.querySelector<HTMLElement>('.fv-slides-list');
  if (firstSlide && list) {
    const w = parseFloat(firstSlide.style.width) || 0;
    const h = parseFloat(firstSlide.style.height) || 0;
    if (w > 0 && h > 0) list.style.setProperty('zoom', String(Math.min(1000 / w, 680 / h)));
  }
  // Drawings inside documents are scaled to the width of their box, which is different on paper.
  for (const box of Array.from(copy.querySelectorAll<HTMLElement>('.fv-doc-canvas'))) {
    const stage = box.querySelector<HTMLElement>('.fv-doc-canvas-stage');
    const natural = stage ? parseFloat(stage.style.width) : 0;
    if (stage && natural > 0 && box.clientWidth > 0) {
      const k = box.clientWidth / natural;
      stage.style.transform = Math.abs(k - 1) > 0.005 ? `scale(${k})` : '';
    }
  }

  const images = Array.from(doc.images).filter((img) => !img.complete);
  if (images.length) {
    await Promise.race([
      Promise.all(images.map((img) => new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      }))),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  run(frame);
}

/** A printable copy of what the image renderer shows: the picture alone, at paper width. */
export function imageForPrint(host: HTMLElement): HTMLElement | null {
  const node = host.querySelector<HTMLImageElement | HTMLCanvasElement>('img.fv-image, canvas.fv-image');
  if (!node) return null;
  const img = document.createElement('img');
  img.className = 'fv-print-image';
  try {
    img.src = node instanceof HTMLCanvasElement ? node.toDataURL('image/png') : node.src;
  } catch {
    return null;
  }
  return img;
}
