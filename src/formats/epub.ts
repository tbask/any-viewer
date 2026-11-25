/**
 * Reader of epub: a zip archive with XHTML chapters. Chapters are output one after another in reading order.
 * Headings, paragraphs, lists, emphasis, links and pictures are supported; the book's CSS is not applied.
 */
import { imageMime, type Block, type DocModel, type Inline, type RunStyle, type TableRow } from '../core/docmodel';
import { attr, child, childrenOf, decodeXmlBytes, localName, parseXml, textContent, type XmlNode } from '../core/xml';
import { ZipReader } from '../core/zip';
import { htmlToText } from './mail';

const ENTITIES: Record<string, string> = { nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©', reg: '®', trade: '™', shy: '', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'dd', 'figcaption', 'td', 'th']);
const SKIP_TAGS = new Set(['head', 'style', 'script', 'nav', 'svg', 'math', 'iframe', 'object']);

function resolvePath(base: string, target: string): string {
  const parts = base.split('/');
  parts.pop();
  for (const seg of decodeURIComponent(target.split('#')[0]).split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Turns an XHTML tree into document blocks. */
export function xhtmlToBlocks(root: XmlNode, basePath: string, images: Set<string>, out: Block[]): void {
  let runs: Inline[] = [];
  let preDepth = 0;
  let pending: { heading?: number; marker?: string; level?: number; quote?: boolean } = {};
  const flush = () => {
    const hasContent = runs.some((r) => r.k !== 'text' || r.text.trim());
    if (hasContent) {
      const block: Block = { k: 'p', runs, s: pending.heading ? { heading: pending.heading } : pending.quote ? { ml: 18, mb: 6 } : { mb: 6 } };
      if (pending.marker !== undefined) {
        block.marker = pending.marker;
        block.level = pending.level;
      }
      out.push(block);
    }
    runs = [];
    pending = {};
  };
  const walk = (node: XmlNode, style: RunStyle, href: string | undefined, listDepth: number, counter: { n: number } | null): void => {
    for (const c of node.children) {
      if (c.name === '#text' && preDepth > 0) {
        // Inside <pre> line breaks and indentation matter.
        c.text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
          if (i) runs.push({ k: 'br' });
          if (line) runs.push({ k: 'text', text: line.replace(/ /g, '\u00a0').replace(/\t/g, '\u00a0\u00a0\u00a0\u00a0'), s: style });
        });
        continue;
      }
      if (c.name === '#text') {
        const t = c.text.replace(/\s+/g, ' ');
        if (t && (t !== ' ' || runs.length)) runs.push(href ? { k: 'text', text: t, s: Object.keys(style).length ? style : undefined, href } : { k: 'text', text: t, s: Object.keys(style).length ? style : undefined });
        continue;
      }
      const tag = localName(c.name).toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'br') runs.push({ k: 'br' });
      else if (tag === 'img' || tag === 'image') {
        const src = attr(c, 'src') ?? attr(c, 'href');
        if (src && !/^[a-z]+:/i.test(src)) {
          const path = resolvePath(basePath, src);
          images.add(path);
          runs.push({ k: 'img', id: path });
        }
      } else if (tag === 'ul' || tag === 'ol') {
        flush();
        walk(c, style, href, listDepth + 1, tag === 'ol' ? { n: 0 } : null);
        flush();
      } else if (tag === 'table') {
        flush();
        const rows: TableRow[] = [];
        const collect = (n: XmlNode): void => {
          for (const r of n.children) {
            const name = localName(r.name).toLowerCase();
            if (name === 'thead' || name === 'tbody' || name === 'tfoot') collect(r);
            else if (name === 'tr') {
              const cells: TableRow['cells'] = [];
              for (const cell of r.children) {
                const cellTag = localName(cell.name).toLowerCase();
                if (cellTag !== 'td' && cellTag !== 'th') continue;
                const blocks: Block[] = [];
                // A cell is parsed as an independent fragment: it may hold paragraphs, lists and nested tables.
                xhtmlToBlocks({ name: 'cell', attrs: {}, children: cellTag === 'th' ? [{ name: 'b', attrs: {}, children: cell.children, text: '' }] : cell.children, text: '' }, basePath, images, blocks);
                const colSpan = Math.min(Number(attr(cell, "colspan")) || 1, 50);
                const rowSpan = Math.min(Number(attr(cell, 'rowspan')) || 1, 500);
                cells.push({ blocks, ...(colSpan > 1 ? { colSpan } : {}), ...(rowSpan > 1 ? { rowSpan } : {}), ...(cellTag === 'th' ? { bg: '#f1f3f5' } : {}) });
              }
              if (cells.length) rows.push({ cells });
            }
          }
        };
        collect(c);
        if (rows.length) out.push({ k: 'table', rows });
      } else if (tag === 'hr') {
        flush();
      } else if (BLOCK_TAGS.has(tag)) {
        flush();
        if (/^h[1-6]$/.test(tag)) pending.heading = Number(tag[1]);
        if (tag === 'blockquote') pending.quote = true;
        if (tag === 'li') {
          pending.marker = counter ? `${++counter.n}.` : '•';
          pending.level = Math.max(0, listDepth - 1);
        }
        const blockStyle: RunStyle = /^h[1-6]$/.test(tag) || tag === 'th' ? { ...style, b: 1 } : tag === 'pre' ? { ...style, mono: 1 } : style;
        if (tag === 'pre') preDepth++;
        walk(c, blockStyle, href, listDepth, counter);
        if (tag === 'pre') preDepth--;
        flush();
      } else {
        let next = style;
        if (tag === 'b' || tag === 'strong') next = { ...style, b: 1 };
        else if (tag === 'i' || tag === 'em' || tag === 'cite') next = { ...style, i: 1 };
        else if (tag === 'u') next = { ...style, u: 1 };
        else if (tag === 's' || tag === 'del' || tag === 'strike') next = { ...style, s: 1 };
        else if (tag === 'sup') next = { ...style, va: 'sup' };
        else if (tag === 'sub') next = { ...style, va: 'sub' };
        else if (tag === 'code' || tag === 'tt' || tag === 'kbd') next = { ...style, mono: 1 };
        const link = tag === 'a' ? attr(c, 'href') : undefined;
        walk(c, next, link && /^(https?:|mailto:)/i.test(link) ? link : href, listDepth, counter);
      }
    }
  };
  walk(root, {}, undefined, 0, null);
  flush();
}

export async function parseEpub(blob: Blob): Promise<DocModel> {
  const zip = await ZipReader.open(blob);
  const readXml = async (path: string) => parseXml(decodeXmlBytes(await zip.read(path)));
  let opfPath = 'content.opf';
  if (zip.has('META-INF/container.xml')) {
    const rootfile = childrenOf(child(await readXml('META-INF/container.xml'), 'rootfiles'), 'rootfile')[0];
    opfPath = attr(rootfile, 'full-path') ?? opfPath;
  }
  if (!zip.has(opfPath)) throw new Error('The file has no package document (OPF)');
  const opf = await readXml(opfPath);
  const items = new Map<string, string>();
  for (const item of childrenOf(child(opf, 'manifest'), 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (id && href) items.set(id, resolvePath(opfPath, href));
  }
  const model: DocModel = { blocks: [], images: {} };
  const title = textContent(child(child(opf, 'metadata'), 'title')).trim();
  if (title) model.blocks.push({ k: 'p', runs: [{ k: 'text', text: title, s: { b: 1 } }], s: { heading: 1, align: 'center' } });
  const images = new Set<string>();

  for (const ref of childrenOf(child(opf, 'spine'), 'itemref')) {
    const path = items.get(attr(ref, 'idref') ?? '');
    if (!path || !zip.has(path)) continue;
    const source = decodeXmlBytes(await zip.read(path)).replace(/&([a-zA-Z]+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
    if (model.blocks.length > 1) model.blocks.push({ k: 'pagebreak' });
    try {
      const html = parseXml(source);
      xhtmlToBlocks(child(html, 'body') ?? html, path, images, model.blocks);
    } catch {
      // A chapter with invalid markup: show at least its text.
      for (const line of htmlToText(source).split('\n')) model.blocks.push({ k: 'p', runs: line ? [{ k: 'text', text: line }] : [] });
    }
  }
  if (model.blocks.length <= (title ? 1 : 0)) throw new Error('The book has no chapters');

  for (const path of images) {
    const mime = imageMime(path);
    const entry = zip.get(path);
    if (!mime || !entry) continue;
    try {
      const data = await zip.read(entry);
      model.images[path] = { mime, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer };
    } catch {
      // A damaged picture must not prevent showing the text.
    }
  }
  return model;
}
