/** Office equations (OMML, the m: namespace) → equation tree. */
import type { MathNode } from '../core/docmodel';
import { attr, child, childrenOf, localName, type XmlNode } from '../core/xml';

const row = (items: MathNode[]): MathNode => (items.length === 1 ? items[0] : { t: 'row', items });
const FUNCTIONS = /^(sin|cos|tan|tg|ctg|cot|sec|csc|arcsin|arccos|arctan|arctg|sinh|cosh|tanh|ln|lg|log|exp|lim|max|min|sup|inf|det|gcd|mod|arg|deg|dim)$/;

function text(node: XmlNode): string {
  return childrenOf(node, 't').map((t) => t.children.map((c) => c.text).join('')).join('');
}

function part(node: XmlNode | undefined, name: string): MathNode {
  return row(convertChildren(child(node, name)));
}
function optional(node: XmlNode, name: string): MathNode | undefined {
  const inner = child(node, name);
  if (!inner) return undefined;
  const items = convertChildren(inner);
  return items.length ? row(items) : undefined;
}

function convert(node: XmlNode): MathNode | undefined {
  switch (localName(node.name)) {
    case 'r': {
      const v = text(node);
      if (!v) return undefined;
      // Plain text inside an equation and function names are set upright, variables in italics.
      const plain = !!child(child(node, 'rPr'), 'nor') || attr(child(child(node, 'rPr'), 'sty'), 'val') === 'p';
      if (plain || FUNCTIONS.test(v.trim())) return { t: 'text', v, upright: true };
      // Variables are set in italics, digits and signs upright; thin spaces surround operator signs.
      const parts = v.match(/[A-Za-zА-Яа-яЁёα-ωΑ-Ω]+|[^A-Za-zА-Яа-яЁёα-ωΑ-Ω]+/g) ?? [v];
      const items: MathNode[] = parts.map((part) =>
        /[A-Za-zА-Яа-яЁёα-ωΑ-Ω]/.test(part) ? { t: 'text', v: part } : { t: 'text', v: part.replace(/\s*([=±+−<>≤≥≠≈×·])\s*/g, '\u2009$1\u2009').replace(/(\S)-(?=\S)/g, '$1\u2009−\u2009').replace(/^-/, '−'), upright: true },
      );
      return row(items);
    }
    case 'f':
      return { t: 'frac', num: part(node, 'num'), den: part(node, 'den') };
    case 'sSup':
      return { t: 'script', base: part(node, 'e'), sup: part(node, 'sup') };
    case 'sSub':
      return { t: 'script', base: part(node, 'e'), sub: part(node, 'sub') };
    case 'sSubSup':
      return { t: 'script', base: part(node, 'e'), sub: part(node, 'sub'), sup: part(node, 'sup') };
    case 'sPre':
      return { t: 'row', items: [{ t: 'script', base: { t: 'text', v: '', upright: true }, sub: part(node, 'sub'), sup: part(node, 'sup') }, part(node, 'e')] };
    case 'rad': {
      const hide = attr(child(child(node, 'radPr'), 'degHide'), 'val');
      const deg = hide === '1' || hide === 'on' || hide === 'true' ? undefined : optional(node, 'deg');
      return { t: 'rad', deg, e: part(node, 'e') };
    }
    case 'nary': {
      const pr = child(node, 'naryPr');
      return { t: 'nary', chr: attr(child(pr, 'chr'), 'val') ?? '∫', sub: optional(node, 'sub'), sup: optional(node, 'sup'), e: part(node, 'e') };
    }
    case 'd': {
      const pr = child(node, 'dPr');
      const open = child(pr, 'begChr');
      const close = child(pr, 'endChr');
      return {
        t: 'delim',
        open: open ? (attr(open, 'val') ?? '') : '(',
        close: close ? (attr(close, 'val') ?? '') : ')',
        sep: attr(child(pr, 'sepChr'), 'val') ?? '|',
        items: childrenOf(node, 'e').map((e) => row(convertChildren(e))),
      };
    }
    case 'func':
      return { t: 'row', items: [part(node, 'fName'), { t: 'text', v: ' ', upright: true }, part(node, 'e')] };
    case 'bar':
      return { t: 'over', e: part(node, 'e'), mark: '¯' };
    case 'acc':
      return { t: 'over', e: part(node, 'e'), mark: attr(child(child(node, 'accPr'), 'chr'), 'val') ?? '^' };
    case 'groupChr':
      return { t: 'over', e: part(node, 'e'), mark: attr(child(child(node, 'groupChrPr'), 'chr'), 'val') ?? '⏟' };
    case 'limLow':
      return { t: 'lim', e: part(node, 'e'), lim: part(node, 'lim') };
    case 'limUpp':
      return { t: 'lim', e: part(node, 'e'), lim: part(node, 'lim'), upper: true };
    case 'm':
      return { t: 'matrix', rows: childrenOf(node, 'mr').map((mr) => childrenOf(mr, 'e').map((e) => row(convertChildren(e)))) };
    case 'eqArr':
      return { t: 'matrix', rows: childrenOf(node, 'e').map((e) => [row(convertChildren(e))]) };
    case 'box':
    case 'borderBox':
    case 'phant':
      return part(node, 'e');
    case 'oMath':
    case 'e':
      return row(convertChildren(node));
    default:
      return undefined;
  }
}

function convertChildren(node: XmlNode | undefined): MathNode[] {
  const out: MathNode[] = [];
  for (const c of node?.children ?? []) {
    if (c.name === '#text') continue;
    const item = convert(c);
    if (item) out.push(item);
  }
  return out;
}

/** Parses an m:oMath element. */
export function parseOmml(node: XmlNode): MathNode | undefined {
  const items = convertChildren(node);
  return items.length ? row(items) : undefined;
}

/** The equation as one line, for text search and comparisons. */
export function mathToText(node: MathNode): string {
  switch (node.t) {
    case 'text': return node.v;
    case 'row': return node.items.map(mathToText).join('');
    case 'frac': return `(${mathToText(node.num)})/(${mathToText(node.den)})`;
    case 'script': return `${mathToText(node.base)}${node.sub ? `_${mathToText(node.sub)}` : ''}${node.sup ? `^${mathToText(node.sup)}` : ''}`;
    case 'rad': return `√(${mathToText(node.e)})`;
    case 'nary': return `${node.chr}${mathToText(node.e)}`;
    case 'delim': return `${node.open}${node.items.map(mathToText).join(node.sep)}${node.close}`;
    case 'over': return mathToText(node.e);
    case 'lim': return `${mathToText(node.e)}_${mathToText(node.lim)}`;
    case 'matrix': return node.rows.map((r) => r.map(mathToText).join(' ')).join('; ');
  }
}
