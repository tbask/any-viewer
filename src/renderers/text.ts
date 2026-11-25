/**
 * Text file view.
 * The text is cut into blocks; the browser does not render off-screen blocks (content-visibility),
 * so even a file of several megabytes scrolls smoothly.
 */
import { decodeText } from '../core/encoding';
import { clamp, el, type RenderContext, type RendererHandle } from './types';

const LINES_PER_CHUNK = 300;
const MAX_CHUNK_CHARS = 60_000;
const BASE_FONT = 14;

/** Splits text into blocks at line boundaries; overlong lines are cut by force. */
export function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let lines = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const isBreak = text.charCodeAt(i) === 10;
    if (isBreak) lines++;
    const size = i - start + 1;
    if ((isBreak && (lines >= LINES_PER_CHUNK || size >= MAX_CHUNK_CHARS)) || size >= MAX_CHUNK_CHARS * 2) {
      // The line break at the end of a block is not included: blocks already follow one another.
      chunks.push(text.slice(start, isBreak ? i : i + 1));
      start = i + 1;
      lines = 0;
    }
  }
  if (start < n) chunks.push(text.slice(start));
  return chunks;
}

export async function createTextRenderer(ctx: RenderContext): Promise<RendererHandle> {
  const blob = ctx.blob!;
  const limit = ctx.limits.maxTextBytes;
  const truncated = blob.size > limit;
  const bytes = new Uint8Array(await (truncated ? blob.slice(0, limit) : blob).arrayBuffer());
  let { text } = decodeText(bytes, ctx.options.fallbackEncoding);
  text = text.replace(/\r\n?/g, '\n');
  if (ctx.format === 'json' && !truncated) {
    // JSON is shown indented; invalid JSON as is.
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* keep the source text */
    }
  }
  if (truncated) {
    // Drop the last, probably cut off, line.
    const cut = text.lastIndexOf('\n');
    if (cut > 0) text = text.slice(0, cut);
  }

  const view = el('div', 'fv-text');
  view.tabIndex = 0;
  if (text.length === 0) {
    view.appendChild(el('div', 'fv-empty', ctx.labels.empty));
  } else {
    const fragment = document.createDocumentFragment();
    for (const chunk of splitIntoChunks(text)) {
      const block = el('div', 'fv-text-chunk');
      // The browser does not show the trailing line break of a block, so an empty
      // last line (and a completely empty block) has to be marked explicitly.
      block.textContent = chunk.length === 0 || chunk.endsWith('\n') ? chunk + '\n' : chunk;
      fragment.appendChild(block);
    }
    view.appendChild(fragment);
  }
  ctx.host.appendChild(view);
  if (truncated) ctx.setNotice(ctx.labels.truncatedText);

  let zoom = 1;
  const apply = () => {
    view.style.fontSize = `${Math.round(BASE_FONT * zoom * 10) / 10}px`;
    ctx.setZoomLabel(`${Math.round(zoom * 100)}%`);
  };
  apply();

  const setZoom = (next: number) => {
    // Keep the relative scroll position.
    const ratio = view.scrollHeight > 0 ? view.scrollTop / view.scrollHeight : 0;
    zoom = clamp(next, 0.6, 3);
    apply();
    view.scrollTop = ratio * view.scrollHeight;
  };

  return {
    zoomIn: () => setZoom(zoom * 1.15),
    zoomBy: (factor) => setZoom(zoom * factor),
    zoomOut: () => setZoom(zoom / 1.15),
    zoomReset: () => setZoom(1),
    destroy() {
      view.remove();
    },
  };
}
