/// <reference lib="webworker" />
/** Worker for documents and presentations: parses the file and returns the finished model. */
import type { DocModel } from '../core/docmodel';
import type { SlidesModel } from '../core/slidemodel';
import { isSlidesFormat, parseDocument, parseSlides, type DocFormat, type DocOptions, type SlidesFormat } from '../formats/documents';

export interface DocRequest {
  format: DocFormat | SlidesFormat;
  blob: Blob;
  options: DocOptions;
}

export type DocResponse = { ok: true; model: DocModel | SlidesModel } | { ok: false; error: string; errorName?: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<DocRequest>) => {
  const { format, blob, options } = event.data;
  try {
    const model = isSlidesFormat(format) ? await parseSlides(format, blob, options) : await parseDocument(format, blob, options);
    // Image data is transferred without copying.
    const transfer = Object.values(model.images).map((img) => img.data);
    ctx.postMessage({ ok: true, model } satisfies DocResponse, transfer);
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err), errorName: err instanceof Error ? err.name : undefined } satisfies DocResponse);
  }
};
