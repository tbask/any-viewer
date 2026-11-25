/** Runs document parsing in a worker, falling back to the main thread if the worker is unavailable. */
import DocWorker from '../workers/doc.worker?worker&inline';
import type { DocRequest, DocResponse } from '../workers/doc.worker';
import type { DocFormat, DocOptions, SlidesFormat } from '../formats/documents';
import type { SlidesModel } from './slidemodel';
import type { DocModel } from './docmodel';

/** A file parsing error (as opposed to a failure of the worker itself). */
export class DocParseError extends Error {
  constructor(message: string, readonly errorName?: string) {
    super(message);
    this.name = 'DocParseError';
  }
}

export function loadDocModel(format: DocFormat, blob: Blob, options: DocOptions, useWorker: boolean, signal: AbortSignal): Promise<DocModel> {
  return loadModel(format, blob, options, useWorker, signal) as Promise<DocModel>;
}

export function loadSlidesModel(format: SlidesFormat, blob: Blob, options: DocOptions, useWorker: boolean, signal: AbortSignal): Promise<SlidesModel> {
  return loadModel(format, blob, options, useWorker, signal) as Promise<SlidesModel>;
}

async function loadModel(format: DocFormat | SlidesFormat, blob: Blob, options: DocOptions, useWorker: boolean, signal: AbortSignal): Promise<DocModel | SlidesModel> {
  if (useWorker && typeof Worker !== 'undefined') {
    let worker: Worker | null = null;
    try {
      worker = new DocWorker();
      const w = worker;
      const response = await new Promise<DocResponse>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<DocResponse>) => resolve(e.data);
        w.onerror = (e) => {
          e.preventDefault?.();
          reject(new Error(e.message || 'Worker error'));
        };
        signal.addEventListener('abort', () => reject(new DocParseError('aborted', 'AbortError')), { once: true });
        w.postMessage({ format, blob, options } satisfies DocRequest);
      });
      if (!response.ok) throw new DocParseError(response.error, response.errorName);
      return response.model;
    } catch (err) {
      if (err instanceof DocParseError) throw err;
      // The worker itself failed: try on the main thread.
    } finally {
      worker?.terminate();
    }
  }
  const { isSlidesFormat, parseDocument, parseSlides } = await import('../formats/documents');
  try {
    return isSlidesFormat(format) ? await parseSlides(format, blob, options) : await parseDocument(format, blob, options);
  } catch (err) {
    throw new DocParseError(err instanceof Error ? err.message : String(err), err instanceof Error ? err.name : undefined);
  }
}
