/**
 * PDF view on the PDF.js engine (Mozilla, Apache 2.0) bundled with the package.
 *
 * What is ours here: page virtualization (only visible and neighbouring canvases are in memory),
 * a canvas size limit for mobile devices, zoom by buttons, wheel and pinch.
 * PDF parsing runs in a worker; a file by URL is fetched in ranges (HTTP Range).
 */
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { ViewerError } from '../types';
import { clamp, el, type RenderContext, type RendererHandle } from './types';

const PAGE_GAP = 12;
const MAX_FIT_SCALE = 2;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;

interface PageSlot {
  num: number;
  box: HTMLDivElement;
  /** Page size in PDF points at scale 1. */
  width: number;
  height: number;
  sized: boolean;
  canvas: HTMLCanvasElement | null;
  renderedScale: number;
  task: RenderTask | null;
  page: PDFPageProxy | null;
  wanted: boolean;
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export async function createPdfRenderer(ctx: RenderContext): Promise<RendererHandle> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfOptions = ctx.options.pdf ?? {};

  let port: Worker;
  if (pdfOptions.workerSrc) {
    port = new Worker(pdfOptions.workerSrc, { type: 'module' });
  } else {
    const { default: PdfWorker } = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline');
    port = new PdfWorker();
  }
  const worker = new pdfjs.PDFWorker({ port: port as never });

  const params: Record<string, unknown> = {
    worker,
    enableXfa: false,
    // Do not fetch the whole file in the background: take only the parts needed for visible pages.
    disableAutoFetch: true,
    disableStream: true,
    canvasMaxAreaInBytes: ctx.limits.maxCanvasPixels * 4,
  };
  if (pdfOptions.assetsUrl) {
    const base = withSlash(pdfOptions.assetsUrl);
    params.cMapUrl = `${base}cmaps/`;
    params.cMapPacked = true;
    params.standardFontDataUrl = `${base}standard_fonts/`;
    params.wasmUrl = `${base}wasm/`;
    params.iccUrl = `${base}iccs/`;
  }
  if (ctx.blob) {
    params.data = new Uint8Array(await ctx.blob.arrayBuffer());
  } else {
    params.url = ctx.url;
    if (pdfOptions.httpHeaders) params.httpHeaders = pdfOptions.httpHeaders;
    if (pdfOptions.withCredentials) params.withCredentials = true;
  }

  if (ctx.password !== undefined) params.password = ctx.password;
  const loadingTask = pdfjs.getDocument(params);
  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    void loadingTask.destroy().catch(() => {});
    worker.destroy();
    const name = (err as { name?: string } | null)?.name;
    if (name === 'PasswordException') {
      // Code 2: a password was given but did not fit; otherwise the password has not been asked yet.
      const wrong = (err as { code?: number }).code === 2 && ctx.password !== undefined;
      const cause = new Error(wrong ? 'Wrong password' : 'The file is password protected');
      cause.name = wrong ? 'WrongPasswordError' : 'PasswordRequiredError';
      throw new ViewerError('password', ctx.labels.passwordProtected, 'pdf', cause);
    }
    if (name === 'InvalidPDFException') throw new ViewerError('corrupt', ctx.labels.loadFailed, 'pdf', err);
    throw new ViewerError('load-failed', ctx.labels.loadFailed, 'pdf', err);
  }

  let destroyed = false;
  const cleanup = () => {
    destroyed = true;
    void loadingTask.destroy().catch(() => {});
    worker.destroy();
  };
  if (ctx.signal.aborted) {
    cleanup();
    return { destroy() {} };
  }

  const scroller = el('div', 'fv-pdf');
  scroller.tabIndex = 0;
  const inner = el('div', 'fv-pdf-pages');
  scroller.appendChild(inner);
  ctx.host.appendChild(scroller);

  const first = await doc.getPage(1);
  const firstViewport = first.getViewport({ scale: 1 });
  const slots: PageSlot[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const box = el('div', 'fv-pdf-page');
    box.dataset.page = String(n);
    inner.appendChild(box);
    slots.push({
      num: n,
      box,
      // Until a page is loaded, assume it has the size of the first one.
      width: firstViewport.width,
      height: firstViewport.height,
      sized: n === 1,
      canvas: null,
      renderedScale: 0,
      task: null,
      page: n === 1 ? first : null,
      wanted: false,
    });
  }

  let zoom = 1;
  let fitScale = 1;
  let busy = false;
  let currentPage = 1;

  const displayScale = () => fitScale * zoom;

  const computeFit = () => {
    const available = Math.max(100, scroller.clientWidth - 2 * PAGE_GAP);
    fitScale = Math.min(available / firstViewport.width, MAX_FIT_SCALE);
  };

  const sizeSlot = (slot: PageSlot) => {
    const s = displayScale();
    const w = Math.floor(slot.width * s);
    const h = Math.floor(slot.height * s);
    slot.box.style.width = `${w}px`;
    slot.box.style.height = `${h}px`;
    if (slot.canvas) {
      // Until re-rendered, the old canvas is stretched; sharpness returns after rendering.
      slot.canvas.style.width = `${w}px`;
      slot.canvas.style.height = `${h}px`;
    }
  };

  const updatePageInfo = () => {
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let page = 1;
    for (const slot of slots) {
      if (slot.box.offsetTop <= middle) page = slot.num;
      else break;
    }
    currentPage = page;
    ctx.setPageInfo(`${ctx.labels.page} ${page} ${ctx.labels.of} ${slots.length}`);
  };

  const release = (slot: PageSlot) => {
    slot.task?.cancel();
    slot.task = null;
    if (slot.canvas) {
      // Zeroing the dimensions frees the canvas memory at once (matters on iOS).
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.canvas.remove();
      slot.canvas = null;
    }
    slot.renderedScale = 0;
    if (slot.page && slot.num !== 1) {
      slot.page.cleanup();
    }
  };

  const renderSlot = async (slot: PageSlot) => {
    const scale = displayScale();
    const page = slot.page ?? (slot.page = await doc.getPage(slot.num));
    if (destroyed || !slot.wanted) return;
    if (!slot.sized) {
      const vp = page.getViewport({ scale: 1 });
      slot.width = vp.width;
      slot.height = vp.height;
      slot.sized = true;
      sizeSlot(slot);
    }
    const viewport = page.getViewport({ scale });
    let ratio = Math.min(window.devicePixelRatio || 1, ctx.limits.maxPixelRatio);
    const area = viewport.width * viewport.height * ratio * ratio;
    if (area > ctx.limits.maxCanvasPixels) ratio *= Math.sqrt(ctx.limits.maxCanvasPixels / area);

    const canvas = el('canvas', 'fv-pdf-canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const task = page.render({
      canvas,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    slot.task = task;
    try {
      await task.promise;
    } catch (err) {
      canvas.width = 0;
      canvas.height = 0;
      if ((err as { name?: string } | null)?.name === 'RenderingCancelledException') return;
      throw err;
    } finally {
      if (slot.task === task) slot.task = null;
    }
    if (destroyed || !slot.wanted) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    // Swap the canvas only when the new one is ready: no flicker when zooming.
    const old = slot.canvas;
    slot.canvas = canvas;
    slot.renderedScale = scale;
    slot.box.replaceChildren(canvas);
    if (old) {
      old.width = 0;
      old.height = 0;
    }
  };

  /** Renders the wanted pages one by one, starting with the one closest to the current page. */
  const pump = async () => {
    if (busy || destroyed) return;
    busy = true;
    try {
      for (;;) {
        const scale = displayScale();
        let next: PageSlot | null = null;
        for (const slot of slots) {
          if (!slot.wanted || slot.task || Math.abs(slot.renderedScale - scale) < 1e-6) continue;
          if (!next || Math.abs(slot.num - currentPage) < Math.abs(next.num - currentPage)) next = slot;
        }
        if (!next || destroyed) break;
        try {
          await renderSlot(next);
        } catch {
          // A failure of one page must not stop the others; mark it as rendered.
          next.renderedScale = scale;
          if (!next.canvas) next.box.replaceChildren(el('div', 'fv-pdf-page-error', '⚠'));
        }
      }
    } finally {
      busy = false;
    }
  };

  // Pages within one screen above and below the viewport are kept ready, the rest are released.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = slots[Number((entry.target as HTMLElement).dataset.page) - 1];
        slot.wanted = entry.isIntersecting;
        if (!entry.isIntersecting) release(slot);
      }
      void pump();
    },
    { root: scroller, rootMargin: '100% 0px' },
  );

  const setZoom = (next: number, anchorX?: number, anchorY?: number) => {
    next = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const k = next / zoom;
    if (Math.abs(k - 1) < 1e-6) return;
    const ax = anchorX ?? scroller.clientWidth / 2;
    const ay = anchorY ?? scroller.clientHeight / 2;
    const left = scroller.scrollLeft;
    const top = scroller.scrollTop;
    zoom = next;
    for (const slot of slots) sizeSlot(slot);
    // The point under the anchor stays in place.
    scroller.scrollLeft = (left + ax) * k - ax;
    scroller.scrollTop = (top + ay) * k - ay;
    ctx.setZoomLabel(`${Math.round(zoom * 100)}%`);
    updatePageInfo();
    void pump();
  };

  computeFit();
  for (const slot of slots) {
    sizeSlot(slot);
    observer.observe(slot.box);
  }
  ctx.setZoomLabel('100%');
  updatePageInfo();

  let scrollFrame = 0;
  const onScroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updatePageInfo();
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  let lastWidth = scroller.clientWidth;
  const resizeObserver = new ResizeObserver(() => {
    if (scroller.clientWidth === lastWidth) return;
    lastWidth = scroller.clientWidth;
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    computeFit();
    for (const slot of slots) sizeSlot(slot);
    scroller.scrollTop = ratio * scroller.scrollHeight;
    updatePageInfo();
    void pump();
  });
  resizeObserver.observe(scroller);

  // Ctrl + wheel zooms (a trackpad pinch behaves the same way).
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  };
  scroller.addEventListener('wheel', onWheel, { passive: false });

  // Two-finger pinch: a fast CSS preview during the gesture, a re-render when it ends.
  // Touch events are used: only they allow cancelling the system gesture for two fingers
  // while leaving regular one-finger scrolling to the browser.
  let pinchStart = 0;
  let pinchRatio = 1;
  let pinchMid = { x: 0, y: 0 };
  const touchDist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const finishPinch = () => {
    if (pinchStart === 0) return;
    pinchStart = 0;
    inner.style.transform = '';
    inner.style.transformOrigin = '';
    setZoom(zoom * pinchRatio, pinchMid.x, pinchMid.y);
  };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    pinchStart = touchDist(e);
    pinchRatio = 1;
    pinchMid = {
      x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
      y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top,
    };
    inner.style.transformOrigin = `${pinchMid.x + scroller.scrollLeft}px ${pinchMid.y + scroller.scrollTop}px`;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (pinchStart === 0 || e.touches.length !== 2) return;
    e.preventDefault();
    pinchRatio = clamp(touchDist(e) / pinchStart, MIN_ZOOM / zoom, MAX_ZOOM / zoom);
    inner.style.transform = `scale(${pinchRatio})`;
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) finishPinch();
  };
  scroller.addEventListener('touchstart', onTouchStart, { passive: false });
  scroller.addEventListener('touchmove', onTouchMove, { passive: false });
  scroller.addEventListener('touchend', onTouchEnd);
  scroller.addEventListener('touchcancel', onTouchEnd);

  const zoomSteps = (factor: number) => setZoom(zoom * factor);

  return {
    zoomIn: () => zoomSteps(1.25),
    zoomOut: () => zoomSteps(0.8),
    zoomReset: () => setZoom(1),
    destroy() {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      observer.disconnect();
      resizeObserver.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd);
      scroller.removeEventListener('touchcancel', onTouchEnd);
      for (const slot of slots) {
        slot.wanted = false;
        release(slot);
      }
      scroller.remove();
      cleanup();
    },
  };
}
