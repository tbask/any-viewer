/**
 * Safe HTML display: markup becomes a document model (headings, paragraphs, lists, emphasis,
 * links), while scripts, styles, forms, frames and external resources are dropped. HTML from a file is never
 * handed to the browser, so the page cannot run code or reach the network.
 */
import type { DocModel } from '../core/docmodel';
import { decodeText } from '../core/encoding';
import { decodeEntities, type XmlNode } from '../core/xml';
import { xhtmlToBlocks } from './epub';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);
/** Opening any of these tags closes an unclosed paragraph. */
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'li', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'hr', 'dl', 'dt', 'dd', 'tr', 'td', 'th']);
const NAMED: Record<string, string> = { nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©', reg: '®', trade: '™', shy: '', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', euro: '€', times: '×' };

const decode = (s: string) => decodeEntities(s.replace(/&([a-zA-Z]+);/g, (whole, name: string) => NAMED[name] ?? whole));

/** Lenient HTML parse into a tree: unclosed and mis-nested tags are not errors. */
export function parseHtmlTree(html: string): XmlNode {
  const root: XmlNode = { name: 'html-root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1];
  const addText = (t: string) => {
    if (t) top().children.push({ name: '#text', attrs: {}, children: [], text: decode(t) });
  };
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s>/]*)[^>]*>|<([a-zA-Z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const attrRe = /([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let last = 0;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    addText(html.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[1]) {
      // End tag: climb to the matching open one; a stray one is ignored.
      const name = m[1].toLowerCase();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(attrRe)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      if (CLOSES_P.has(name)) {
        const p = stack.map((n) => n.name).lastIndexOf('p');
        if (p > 0) stack.length = p;
      }
      if (name === 'li') {
        const li = stack.map((n) => n.name).lastIndexOf('li');
        const list = Math.max(stack.map((n) => n.name).lastIndexOf('ul'), stack.map((n) => n.name).lastIndexOf('ol'));
        if (li > list && li > 0) stack.length = li;
      }
      if (name === 'td' || name === 'th' || name === 'tr') {
        // Table cells and rows are often left unclosed: a new one closes the previous within its table.
        const names = stack.map((n) => n.name);
        const table = names.lastIndexOf('table');
        const open = name === 'tr' ? names.lastIndexOf('tr') : Math.max(names.lastIndexOf('td'), names.lastIndexOf('th'));
        if (open > table && open > 0) stack.length = open;
      }
      const node: XmlNode = { name, attrs, children: [], text: '' };
      top().children.push(node);
      if (RAW_TEXT.has(name)) {
        // The content of such elements is not markup: skip to the end tag.
        const close = html.toLowerCase().indexOf(`</${name}`, last);
        const end = close < 0 ? html.length : html.indexOf('>', close) + 1 || html.length;
        if (name === 'title') node.children.push({ name: '#text', attrs: {}, children: [], text: decode(html.slice(last, close < 0 ? html.length : close)) });
        last = end;
        tagRe.lastIndex = end;
      } else if (!VOID.has(name) && !m[3].trimEnd().endsWith('/') && stack.length < 200) {
        stack.push(node);
      }
    }
  }
  addText(html.slice(last));
  return root;
}

/** Decodes HTML honouring the encoding declared in <meta charset>. */
export function decodeHtml(bytes: Uint8Array, fallback?: string): string {
  const head = String.fromCharCode(...bytes.subarray(0, 2048));
  const declared = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      new TextDecoder(declared);
      return decodeText(bytes, declared).text;
    } catch {
      /* unknown encoding: detect it ourselves */
    }
  }
  return decodeText(bytes, fallback).text;
}

export function parseHtml(html: string): DocModel {
  const tree = parseHtmlTree(html);
  const model: DocModel = { blocks: [], images: {} };
  // Pictures are not loaded: external addresses mean network access, which viewing a file must not do.
  xhtmlToBlocks(tree, '', new Set<string>(), model.blocks);
  return model;
}
