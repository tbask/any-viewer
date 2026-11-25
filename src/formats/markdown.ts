/**
 * Markdown parser into a document model: headings, paragraphs, lists, code blocks, quotes, tables,
 * bold, italic, strikethrough, inline code and links. HTML inside Markdown is shown as text.
 */
import type { Block, DocModel, Inline, RunStyle, TableRow } from '../core/docmodel';

const INLINE = /(\*\*|__)(.+?)\1|(\*|_)(?=\S)(.+?)\3|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;

export function parseInline(text: string, base: RunStyle = {}): Inline[] {
  const out: Inline[] = [];
  const push = (t: string, s: RunStyle, href?: string) => {
    if (!t) return;
    const style = Object.keys(s).length ? s : undefined;
    out.push(href ? { k: 'text', text: t, s: style, href } : { k: 'text', text: t, s: style });
  };
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    push(text.slice(last, m.index), base);
    if (m[2] !== undefined) out.push(...parseInline(m[2], { ...base, b: 1 }));
    else if (m[4] !== undefined) out.push(...parseInline(m[4], { ...base, i: 1 }));
    else if (m[5] !== undefined) out.push(...parseInline(m[5], { ...base, s: 1 }));
    else if (m[6] !== undefined) push(m[6], { ...base, mono: 1, bg: '#f1f3f5' });
    else push(m[7], { ...base, color: '#1d4ed8', u: 1 }, m[8]);
    last = m.index! + m[0].length;
  }
  push(text.slice(last), base);
  return out;
}

export function parseMarkdown(text: string): DocModel {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ k: 'p', runs: parseInline(paragraph.join(' ')), s: { mb: 8 } });
    paragraph = [];
  };
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      const runs: Inline[] = [];
      code.forEach((c, k) => {
        if (k) runs.push({ k: 'br' });
        runs.push({ k: 'text', text: c || ' ', s: { mono: 1, size: 10 } });
      });
      blocks.push({ k: 'p', runs, s: { bg: '#f1f3f5', mb: 8, ml: 6 } });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ k: 'p', runs: parseInline(heading[2], { b: 1 }), s: { heading: heading[1].length } });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ k: 'pagebreak' });
      continue;
    }
    // Table: a row with "|" and a separator of hyphens below it.
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const rows: TableRow[] = [{ cells: cells(line).map((c) => ({ blocks: [{ k: 'p', runs: parseInline(c, { b: 1 }) }] })) }];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
        rows.push({ cells: cells(lines[i]).map((c) => ({ blocks: [{ k: 'p', runs: parseInline(c) }] })) });
      }
      i--;
      blocks.push({ k: 'table', rows });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      blocks.push({ k: 'p', runs: parseInline(item[3]), marker: ordered ? item[2].replace(')', '.') : '•', level: Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 6) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ k: 'p', runs: parseInline(quote[1], { i: 1, color: '#6b7280' }), s: { ml: 18 } });
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return { blocks, images: {} };
}
