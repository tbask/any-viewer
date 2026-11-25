/** Picks the text document parser by format. Shared by the worker and the main-thread fallback. */
import type { DocModel } from '../core/docmodel';
import type { SlidesModel } from '../core/slidemodel';
import { parseEpub } from './epub';
import { decodeHtml, parseHtml } from './html';
import { parseEml, parseIcs, parseMbox, parseMsg } from './mail';
import { parseMarkdown } from './markdown';
import { parseOdp } from './odp';
import { decodeText } from '../core/encoding';
import { parsePpt } from './ppt';
import { parsePptx } from './pptx';
import { parseDoc } from './doc';
import { parseDocx } from './docx';
import { parseOdt } from './odt';
import { parseRtf } from './rtf';

export type DocFormat = 'docx' | 'odt' | 'rtf' | 'doc' | 'md' | 'eml' | 'mbox' | 'ics' | 'msg' | 'epub' | 'html';

export interface DocOptions {
  fallbackEncoding?: string;
  /** Captions for service fields (message headers and the like). */
  labels?: Record<string, string>;
  /** Language for numbers and dates (BCP 47). */
  lang?: string;
  /** Password for an encrypted document. */
  password?: string;
}

export async function parseDocument(format: DocFormat, blob: Blob, options: DocOptions): Promise<DocModel> {
  switch (format) {
    case 'docx':
      return parseDocx(blob, options);
    case 'odt':
      return parseOdt(blob, options);
    case 'rtf':
      return parseRtf(new Uint8Array(await blob.arrayBuffer()), options);
    case 'md':
      return parseMarkdown(decodeText(new Uint8Array(await blob.arrayBuffer()), options.fallbackEncoding).text);
    case 'eml':
      return parseEml(new Uint8Array(await blob.arrayBuffer()), options);
    case 'mbox':
      return parseMbox(new Uint8Array(await blob.arrayBuffer()), options);
    case 'ics':
      return parseIcs(new Uint8Array(await blob.arrayBuffer()), options);
    case 'msg':
      return parseMsg(blob, options);
    case 'epub':
      return parseEpub(blob);
    case 'html':
      return parseHtml(decodeHtml(new Uint8Array(await blob.arrayBuffer()), options.fallbackEncoding));
    default:
      return parseDoc(blob, options);
  }
}

export type SlidesFormat = 'pptx' | 'odp' | 'ppt';

export function isSlidesFormat(format: string): format is SlidesFormat {
  return format === 'pptx' || format === 'odp' || format === 'ppt';
}

export async function parseSlides(format: SlidesFormat, blob: Blob, options: DocOptions = {}): Promise<SlidesModel> {
  if (format === 'pptx') return parsePptx(blob);
  if (format === 'odp') return parseOdp(blob);
  return parsePpt(blob, options);
}
