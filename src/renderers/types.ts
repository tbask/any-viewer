import type { FileFormat, Labels, ViewerLimits, ViewerOptions } from '../types';

export interface RenderContext {
  /** The element the renderer puts content into. */
  host: HTMLElement;
  /** File content. null if the file is opened directly by URL (PDF with ranged loading). */
  blob: Blob | null;
  url: string | null;
  name: string;
  format: FileFormat;
  labels: Labels;
  limits: ViewerLimits;
  options: ViewerOptions;
  /** Password entered by the user or passed to open(). */
  password?: string;
  /** Fires when the file is closed or another one is opened. */
  signal: AbortSignal;
  setNotice(text: string | null): void;
  setPageInfo(text: string | null): void;
  setZoomLabel(text: string | null): void;
  /** Open a nested file (from an archive) in the same viewer; the "back" button returns. */
  openEntry?(blob: Blob, name: string): void;
}

export interface RendererHandle {
  destroy(): void;
  zoomIn?(): void;
  zoomOut?(): void;
  zoomReset?(): void;
  /** Change the zoom by the given factor (pinch). */
  zoomBy?(factor: number): void;
}

export type RendererFactory = (ctx: RenderContext) => Promise<RendererHandle>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
