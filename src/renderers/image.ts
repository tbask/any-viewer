/**
 * Image view: fit to window, zoom by wheel and pinch, panning.
 * Very large images are downscaled while decoding so as not to exhaust device memory.
 */
import { getImageSize } from '../core/image-size';
import { ViewerError } from '../types';
import { clamp, el, type RenderContext, type RendererHandle } from './types';

async function loadElement(ctx: RenderContext): Promise<{ node: HTMLImageElement | HTMLCanvasElement; width: number; height: number; release(): void }> {
  let blob = ctx.blob!;
  if (ctx.format === 'tiff') {
    // Browsers do not show TIFF: decode it here and draw on a canvas.
    let decoded;
    try {
      const { decodeTiff } = await import('../core/tiff');
      decoded = decodeTiff(new Uint8Array(await blob.arrayBuffer()), ctx.limits.maxImagePixels * 2);
    } catch (err) {
      const unsupported = /not supported/.test((err as Error).message);
      throw new ViewerError(unsupported ? 'unsupported' : 'corrupt', unsupported ? `${ctx.labels.imageUnsupported} ${(err as Error).message}.` : ctx.labels.loadFailed, ctx.format, err);
    }
    const canvas = el('canvas', 'fv-image');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    canvas.getContext('2d')!.putImageData(new ImageData(decoded.rgba as Uint8ClampedArray<ArrayBuffer>, decoded.width, decoded.height), 0, 0);
    return {
      node: canvas,
      width: decoded.width,
      height: decoded.height,
      release() {
        canvas.width = 0;
        canvas.height = 0;
      },
    };
  }
  // SVG is shown through <img>: in this mode the browser runs no scripts and loads no external resources.
  if (ctx.format === 'svg') blob = new Blob([blob], { type: 'image/svg+xml' });
  const head = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
  const size = getImageSize(head);

  // The image is too large: decode it downscaled right away.
  if (size && size.width * size.height > ctx.limits.maxImagePixels && typeof createImageBitmap === 'function') {
    const k = Math.sqrt(ctx.limits.maxImagePixels / (size.width * size.height));
    try {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: Math.max(1, Math.floor(size.width * k)),
        resizeHeight: Math.max(1, Math.floor(size.height * k)),
        resizeQuality: 'high',
      });
      const canvas = el('canvas', 'fv-image');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        node: canvas,
        width: canvas.width,
        height: canvas.height,
        release() {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    } catch {
      // That failed: try the regular path below.
    }
  }

  const url = URL.createObjectURL(blob);
  const img = el('img', 'fv-image');
  img.alt = ctx.name;
  img.draggable = false;
  img.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode'));
      img.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    // Only Safari can show HEIC; in other browsers this is missing support, not a damaged file.
    if (ctx.format === 'heic') throw new ViewerError('unsupported', ctx.labels.imageUnsupported, ctx.format, err);
    throw new ViewerError('corrupt', ctx.labels.loadFailed, ctx.format, err);
  }
  // An SVG without explicit dimensions has no intrinsic width; take a sensible default.
  const width = img.naturalWidth || (ctx.format === 'svg' ? 800 : 0);
  const height = img.naturalHeight || (ctx.format === 'svg' ? 600 : 0);
  if (!width || !height) {
    URL.revokeObjectURL(url);
    throw new ViewerError('corrupt', ctx.labels.loadFailed, ctx.format);
  }
  return { node: img, width, height, release: () => URL.revokeObjectURL(url) };
}

export async function createImageRenderer(ctx: RenderContext): Promise<RendererHandle> {
  const { node, width, height, release } = await loadElement(ctx);
  if (ctx.signal.aborted) {
    release();
    return { destroy() {} };
  }

  const view = el('div', 'fv-panzoom');
  view.appendChild(node);
  ctx.host.appendChild(view);
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;

  // scale is the zoom relative to the natural size; tx, ty are the offset of the top-left corner.
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let fitScale = 1;
  let viewW = 0;
  let viewH = 0;

  const maxScale = () => Math.max(4, fitScale * 8);

  const apply = () => {
    const w = width * scale;
    const h = height * scale;
    // A small image is centred, a large one cannot be dragged past the edge.
    tx = w <= viewW ? (viewW - w) / 2 : clamp(tx, viewW - w, 0);
    ty = h <= viewH ? (viewH - h) / 2 : clamp(ty, viewH - h, 0);
    node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    ctx.setZoomLabel(`${Math.round(scale * 100)}%`);
  };

  const fit = () => {
    viewW = view.clientWidth;
    viewH = view.clientHeight;
    fitScale = viewW && viewH ? Math.min(viewW / width, viewH / height, 1) : 1;
  };

  const zoomAt = (next: number, cx: number, cy: number) => {
    next = clamp(next, fitScale, maxScale());
    // The point under the cursor (or between the fingers) stays in place.
    tx = cx - ((cx - tx) / scale) * next;
    ty = cy - ((cy - ty) / scale) * next;
    scale = next;
    apply();
  };

  fit();
  scale = fitScale;
  apply();

  const resizeObserver = new ResizeObserver(() => {
    const wasFit = Math.abs(scale - fitScale) < 1e-6;
    fit();
    if (wasFit) scale = fitScale;
    else scale = clamp(scale, fitScale, maxScale());
    apply();
  });
  resizeObserver.observe(view);

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  let lastTap = 0;
  let moved = false;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    view.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 0) moved = true;
      tx += cur.x - prev.x;
      ty += cur.y - prev.y;
      apply();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && dist > 0) zoomAt(scale * (dist / pinchDist), (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinchDist = dist;
      moved = true;
    }
  };

  const onUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    pinchDist = 0;
    if (pointers.size === 0 && !moved && e.type === 'pointerup') {
      const now = Date.now();
      if (now - lastTap < 300) {
        // Double tap or double click toggles "fit ↔ large".
        const p = local(e);
        const isFit = Math.abs(scale - fitScale) < 1e-6;
        zoomAt(isFit ? Math.max(1, fitScale * 2.5) : fitScale, p.x, p.y);
        lastTap = 0;
      } else {
        lastTap = now;
      }
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(scale * Math.exp(-delta * 0.0015), p.x, p.y);
  };

  view.addEventListener('pointerdown', onDown);
  view.addEventListener('pointermove', onMove);
  view.addEventListener('pointerup', onUp);
  view.addEventListener('pointercancel', onUp);
  view.addEventListener('wheel', onWheel, { passive: false });

  const step = (factor: number) => zoomAt(scale * factor, viewW / 2, viewH / 2);

  return {
    zoomIn: () => step(1.25),
    zoomOut: () => step(0.8),
    zoomReset: () => {
      scale = fitScale;
      apply();
    },
    destroy() {
      resizeObserver.disconnect();
      view.removeEventListener('pointerdown', onDown);
      view.removeEventListener('pointermove', onMove);
      view.removeEventListener('pointerup', onUp);
      view.removeEventListener('pointercancel', onUp);
      view.removeEventListener('wheel', onWheel);
      view.remove();
      release();
    },
  };
}
