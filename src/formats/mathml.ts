/**
 * MathML (the format of LibreOffice Math objects embedded in odt, odp and ods) → equation tree.
 * Presentation markup only; the StarMath annotation next to it is ignored.
 */
import type { MathNode } from '../core/docmodel';
import { childrenOf, decodeXmlBytes, localName, parseXml, textContent, type XmlNode } from '../core/xml';
import type { ZipReader } from '../core/zip';

const NARY = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '∮', '⋃', '⋂', '⋁', '⋀']);
const row = (items: MathNode[]): MathNode => (items.length === 1 ? items[0] : { t: 'row', items });

function convert(node: XmlNode): MathNode | undefined {
  const name = localName(node.name);
  const kids = () => childrenOf(node).map(convert).filter((n): n is MathNode => n !== undefined);
  const text = () => textContent(node).replace(/\s+/g, ' ').trim();
  switch (name) {
    case 'annotation':
    case 'annotation-xml':
    case 'none':
    case 'mprescripts':
      return undefined;
    case 'semantics': {
      const first = childrenOf(node)[0];
      return first ? convert(first) : undefined;
    }
    case 'mi': {
      const v = text();
      return v ? { t: 'text', v, upright: v.length > 1 || node.attrs.mathvariant === 'normal' } : undefined;
    }
    case 'mn':
    case 'mtext':
    case 'ms': {
      const v = text();
      return v ? { t: 'text', v, upright: true } : undefined;
    }
    case 'mo': {
      const v = text();
      if (!v) return undefined;
      // Thin spaces around relations and binary operators, as in a typeset formula.
      return { t: 'text', v: /^[=+\-−±×·÷<>≤≥≠≈→⇒∈]$/.test(v) && node.attrs.stretchy !== 'true' ? ` ${v === '-' ? '−' : v} ` : v, upright: true };
    }
    case 'mfrac': {
      const [num, den] = kids();
      return num && den ? { t: 'frac', num, den } : num;
    }
    case 'msup':
    case 'msub':
    case 'msubsup': {
      const [base, a, b] = kids();
      if (!base) return undefined;
      return name === 'msup' ? { t: 'script', base, sup: a } : name === 'msub' ? { t: 'script', base, sub: a } : { t: 'script', base, sub: a, sup: b };
    }
    case 'msqrt':
      return { t: 'rad', e: row(kids()) };
    case 'mroot': {
      const [e, deg] = kids();
      return e ? { t: 'rad', e, deg } : undefined;
    }
    case 'munder':
    case 'mover':
    case 'munderover': {
      const [base, a, b] = kids();
      if (!base) return undefined;
      const sign = base.t === 'text' ? base.v.trim() : '';
      if (NARY.has(sign)) return { t: 'nary', chr: sign, sub: name === 'mover' ? undefined : a, sup: name === 'mover' ? a : b, e: { t: 'row', items: [] } };
      if (name === 'mover') return a && a.t === 'text' && a.v.trim().length === 1 ? { t: 'over', e: base, mark: a.v.trim() } : a ? { t: 'lim', e: base, lim: a, upper: true } : base;
      if (name === 'munder') return a ? { t: 'lim', e: base, lim: a } : base;
      return { t: 'script', base, sub: a, sup: b };
    }
    case 'mfenced':
      return { t: 'delim', open: node.attrs.open ?? '(', close: node.attrs.close ?? ')', sep: (node.attrs.separators ?? ',').trim().slice(0, 1) || ',', items: kids() };
    case 'mtable':
      return {
        t: 'matrix',
        rows: childrenOf(node)
          .filter((r) => /^m(labeled)?tr$/.test(localName(r.name)))
          .map((r) => childrenOf(r).map((c) => convert(c) ?? ({ t: 'row', items: [] } as MathNode))),
      };
    case 'mspace':
      return { t: 'text', v: ' ', upright: true };
    default: {
      // math, mrow, mstyle, mtd, mpadded, mphantom, merror and anything unknown: a row of the children.
      const items = kids();
      return items.length ? row(items) : undefined;
    }
  }
}

/** Parses a MathML document. Returns undefined if the root is not `math` or the formula is empty. */
export function parseMathMl(root: XmlNode | undefined): MathNode | undefined {
  if (!root || localName(root.name) !== 'math') return undefined;
  return convert(root);
}

/** Embedded formula objects of an OpenDocument file: address from draw:object → equation tree. */
export async function loadOdfMath(zip: ZipReader, root: XmlNode | undefined): Promise<Map<string, MathNode>> {
  const hrefs = new Set<string>();
  const walk = (node: XmlNode | undefined, depth: number) => {
    if (!node || depth > 60) return;
    for (const c of node.children) {
      if (c.name === 'draw:object' && c.attrs['xlink:href']) hrefs.add(c.attrs['xlink:href']);
      else walk(c, depth + 1);
    }
  };
  walk(root, 0);
  const out = new Map<string, MathNode>();
  for (const href of [...hrefs].slice(0, 200)) {
    const entry = zip.get(`${href.replace(/^\.\//, '').replace(/\/$/, '')}/content.xml`);
    if (!entry || entry.size > 2_000_000) continue;
    try {
      const math = parseMathMl(parseXml(decodeXmlBytes(await zip.read(entry))));
      if (math) out.set(href, math);
    } catch {
      // Not a formula or damaged: the replacement picture stays.
    }
  }
  return out;
}
