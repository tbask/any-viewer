/**
 * Renders presentations (pptx, odp, ppt) from the common model.
 * Every slide is a canvas of the original size scaled as a whole to the screen width,
 * so the relative position of objects is kept on any device.
 */
import { DocParseError, loadSlidesModel } from '../core/doc-client';
import type { SlidesModel } from '../core/slidemodel';
import type { SlidesFormat } from '../formats/documents';
import { ViewerError } from '../types';
import { createShapeRenderer } from './shapes';
import { clamp, el, type RenderContext, type RendererHandle } from './types';

export async function createSlidesRenderer(ctx: RenderContext): Promise<RendererHandle> {
  let model: SlidesModel;
  try {
    model = await loadSlidesModel(ctx.format as SlidesFormat, ctx.blob!, { password: ctx.password, lang: ctx.options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined) }, ctx.options.useWorkers !== false, ctx.signal);
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

  const renderShape = createShapeRenderer({ imageUrl, labels: ctx.labels, lang: ctx.options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined) }).shape;

  const scroller = el('div', 'fv-slides');
  scroller.tabIndex = 0;
  const list = el('div', 'fv-slides-list');
  scroller.appendChild(list);
  const frames: { frame: HTMLDivElement; stage: HTMLDivElement }[] = [];
  for (const slide of model.slides) {
    const frame = el('div', 'fv-slide-frame');
    const stage = el('div', 'fv-slide');
    stage.style.width = `${model.width}px`;
    stage.style.height = `${model.height}px`;
    if (slide.bg) stage.style.backgroundColor = slide.bg;
    if (slide.bgGradient) stage.style.backgroundImage = `linear-gradient(${slide.bgGradient.angle + 90}deg, ${slide.bgGradient.stops.map((s) => `${s.color} ${Math.round(s.at * 100)}%`).join(', ')})`;
    const bgUrl = imageUrl(slide.bgImg);
    if (bgUrl) {
      const bg = el('img', 'fv-slide-bg');
      bg.src = bgUrl;
      bg.alt = '';
      bg.draggable = false;
      stage.appendChild(bg);
    }
    for (const shape of slide.shapes) stage.appendChild(renderShape(shape));
    frame.appendChild(stage);
    list.appendChild(frame);
    frames.push({ frame, stage });
  }
  if (!frames.length) list.appendChild(el('div', 'fv-empty', ctx.labels.empty));
  ctx.host.appendChild(scroller);

  let zoom = 1;
  let scale = 1;
  const layout = () => {
    const available = Math.max(120, scroller.clientWidth - 24);
    scale = Math.min(available / model.width, 2) * zoom;
    for (const { frame, stage } of frames) {
      frame.style.width = `${Math.round(model.width * scale)}px`;
      frame.style.height = `${Math.round(model.height * scale)}px`;
      frame.style.containIntrinsicSize = `${Math.round(model.width * scale)}px ${Math.round(model.height * scale)}px`;
      stage.style.transform = `scale(${scale})`;
    }
  };
  const updateInfo = () => {
    if (!frames.length) return;
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let current = 1;
    frames.forEach(({ frame }, i) => {
      if (frame.offsetTop <= middle) current = i + 1;
    });
    ctx.setPageInfo(`${ctx.labels.slide} ${current} ${ctx.labels.of} ${frames.length}`);
  };
  layout();
  updateInfo();
  ctx.setZoomLabel('100%');

  let raf = 0;
  const onScroll = () => {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateInfo();
      });
    }
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  let lastWidth = scroller.clientWidth;
  const resizeObserver = new ResizeObserver(() => {
    if (scroller.clientWidth === lastWidth) return;
    lastWidth = scroller.clientWidth;
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    layout();
    scroller.scrollTop = ratio * scroller.scrollHeight;
  });
  resizeObserver.observe(scroller);

  const setZoom = (next: number) => {
    const ratio = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    zoom = clamp(next, 0.5, 4);
    layout();
    scroller.scrollTop = ratio * scroller.scrollHeight;
    ctx.setZoomLabel(`${Math.round(zoom * 100)}%`);
    updateInfo();
  };

  return {
    zoomIn: () => setZoom(zoom * 1.25),
    zoomBy: (factor) => setZoom(zoom * factor),
    zoomOut: () => setZoom(zoom * 0.8),
    zoomReset: () => setZoom(1),
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      scroller.remove();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
