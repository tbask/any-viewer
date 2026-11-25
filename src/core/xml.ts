/**
 * An own XML parser.
 *
 * Why our own: DOMParser is unavailable in a Web Worker, and office formats have to be parsed
 * right there so as not to block the interface.
 *
 * Two modes: streaming (SAX) for large files such as xlsx sheets,
 * and a tree for small documents. DTDs and external entities are not processed,
 * so "billion laughs" and XXE attacks are impossible by construction.
 */

export class XmlError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} (position ${position})`);
    this.name = 'XmlError';
  }
}

export type XmlAttrs = Record<string, string>;

export interface XmlHandlers {
  open?(name: string, attrs: XmlAttrs, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const code = body.charCodeAt(1) === 120 /* x */ ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Streaming XML parse: calls handlers while reading. */
export function parseXmlSax(xml: string, handlers: XmlHandlers): void {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const { open, close, text } = handlers;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (text) text(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i && text) text(decodeEntities(xml.slice(i, lt)));
    const c1 = xml.charCodeAt(lt + 1);

    if (c1 === 33 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end < 0) throw new XmlError('Unclosed comment', lt);
        i = end + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (end < 0) throw new XmlError('Unclosed CDATA section', lt);
        if (text) text(xml.slice(lt + 9, end));
        i = end + 3;
      } else {
        // <!DOCTYPE ...> is skipped as a whole, including the internal subset [...].
        let depth = 0;
        let j = lt + 2;
        for (; j < n; j++) {
          const c = xml.charCodeAt(j);
          if (c === 91 /* [ */) depth++;
          else if (c === 93 /* ] */) depth--;
          else if (c === 62 /* > */ && depth <= 0) break;
        }
        if (j >= n) throw new XmlError('Unclosed declaration', lt);
        i = j + 1;
      }
      continue;
    }

    if (c1 === 63 /* ? */) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('Unclosed processing instruction', lt);
      i = end + 2;
      continue;
    }

    if (c1 === 47 /* / */) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) throw new XmlError('Unclosed end tag', lt);
      if (close) {
        let end = gt;
        while (end > lt + 2 && isSpace(xml.charCodeAt(end - 1))) end--;
        close(xml.slice(lt + 2, end));
      }
      i = gt + 1;
      continue;
    }

    // Start tag: name, then attributes.
    let j = lt + 1;
    while (j < n) {
      const c = xml.charCodeAt(j);
      if (isSpace(c) || c === 47 || c === 62) break;
      j++;
    }
    if (j >= n) throw new XmlError('Unclosed tag', lt);
    if (j === lt + 1) throw new XmlError('Empty tag name', lt);
    const name = xml.slice(lt + 1, j);
    const attrs: XmlAttrs = {};
    let selfClosing = false;

    for (;;) {
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (j >= n) throw new XmlError('Unclosed tag', lt);
      const c = xml.charCodeAt(j);
      if (c === 62 /* > */) {
        j++;
        break;
      }
      if (c === 47 /* / */) {
        if (xml.charCodeAt(j + 1) !== 62) throw new XmlError('Expected ">"', j);
        selfClosing = true;
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < n) {
        const cc = xml.charCodeAt(j);
        if (cc === 61 /* = */ || isSpace(cc) || cc === 62 || cc === 47) break;
        j++;
      }
      const attrName = xml.slice(nameStart, j);
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (xml.charCodeAt(j) !== 61) throw new XmlError(`Attribute "${attrName}" has no value`, j);
      j++;
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      const quote = xml.charCodeAt(j);
      if (quote !== 34 && quote !== 39) throw new XmlError('An attribute value must be quoted', j);
      const valueEnd = xml.indexOf(quote === 34 ? '"' : "'", j + 1);
      if (valueEnd < 0) throw new XmlError('Unclosed attribute value', j);
      attrs[attrName] = decodeEntities(xml.slice(j + 1, valueEnd));
      j = valueEnd + 1;
    }

    if (open) open(name, attrs, selfClosing);
    if (selfClosing && close) close(name);
    i = j;
  }
}

/** Tree node. Text nodes have name === '#text' and the text field filled. */
export interface XmlNode {
  name: string;
  attrs: XmlAttrs;
  children: XmlNode[];
  text: string;
}

const EMPTY_ATTRS: XmlAttrs = Object.freeze({}) as XmlAttrs;

/** Parses XML into a tree and returns the root element. */
export function parseXml(xml: string): XmlNode {
  const doc: XmlNode = { name: '#document', attrs: EMPTY_ATTRS, children: [], text: '' };
  const stack: XmlNode[] = [doc];
  parseXmlSax(xml, {
    open(name, attrs) {
      const node: XmlNode = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    },
    close(name) {
      const top = stack[stack.length - 1];
      if (stack.length < 2 || top.name !== name) {
        throw new XmlError(`End tag "${name}" does not match the open tag "${top.name}"`, 0);
      }
      stack.pop();
    },
    text(t) {
      if (stack.length < 2) return; // whitespace outside the root element
      stack[stack.length - 1].children.push({ name: '#text', attrs: EMPTY_ATTRS, children: [], text: t });
    },
  });
  if (stack.length !== 1) throw new XmlError(`Tag "${stack[stack.length - 1].name}" is not closed`, xml.length);
  const root = doc.children.find((c) => c.name !== '#text');
  if (!root) throw new XmlError('The document has no root element', 0);
  return root;
}

/** Name without the namespace prefix: 'w:p' → 'p'. */
export function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i < 0 ? qname : qname.slice(i + 1);
}

/** The first child element with the given local name. */
export function child(node: XmlNode | undefined, local: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) if (c.name !== '#text' && localName(c.name) === local) return c;
  return undefined;
}

/** All child elements with the given local name. */
export function childrenOf(node: XmlNode | undefined, local?: string): XmlNode[] {
  if (!node) return [];
  return node.children.filter((c) => c.name !== '#text' && (local === undefined || localName(c.name) === local));
}

/** Attribute value by local name (the prefix is ignored). */
export function attr(node: XmlNode | undefined, local: string): string | undefined {
  if (!node) return undefined;
  if (local in node.attrs) return node.attrs[local];
  for (const key in node.attrs) if (localName(key) === local) return node.attrs[key];
  return undefined;
}

/** All text inside the node, nested elements included. */
export function textContent(node: XmlNode | undefined): string {
  if (!node) return '';
  if (node.name === '#text') return node.text;
  let out = '';
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === '#text') out += c.text;
      else walk(c);
    }
  };
  walk(node);
  return out;
}

/** Decodes the bytes of an XML file into a string, honouring the BOM and the encoding declaration. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  }
  let encoding = 'utf-8';
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 200)));
  const m = /^(?:\xef\xbb\xbf)?<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
  if (m) encoding = m[1];
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
