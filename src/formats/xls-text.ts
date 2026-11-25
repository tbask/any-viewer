/**
 * "Excel" files that are really text: XML Spreadsheet 2003 and an HTML table with the .xls extension.
 * Many accounting and banking systems export reports this way; Excel opens them as regular workbooks.
 */
import { createLocale, builtinFormat, formatValue, type NumFmtLocale } from '../core/numfmt';
import { attr, childrenOf, child, localName, parseXml, textContent, type XmlNode } from '../core/xml';
import { SheetBuilder, StyleTable, type CellStyle, type SheetModel, type Workbook, type WorkbookOptions } from '../core/workbook';
import { parseHtmlTree } from './html';

/** Named XML Spreadsheet formats → Excel format codes. */
const NAMED_FORMATS: Record<string, string | undefined> = {
  'General': undefined,
  'General Number': undefined,
  'General Date': 'm/d/yyyy h:mm',
  'Long Date': 'd mmmm yyyy',
  'Medium Date': 'd-mmm-yy',
  'Short Date': builtinFormat(14),
  'Long Time': 'h:mm:ss',
  'Medium Time': 'h:mm AM/PM',
  'Short Time': 'h:mm',
  'Currency': '#,##0.00',
  'Euro Currency': '#,##0.00 [$€]',
  'Fixed': '0.00',
  'Standard': '#,##0.00',
  'Percent': '0.00%',
  'Scientific': '0.00E+00',
};

const color = (value: string | undefined) => (value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined);
const serial = (iso: string): number | undefined => {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d(?:\.\d+)?))?/.exec(iso);
  if (!m) return undefined;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 + 25569;
  return day + (Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) / 86400;
};

export function openSpreadsheetXml(text: string, options: WorkbookOptions): Workbook {
  const root = parseXml(text);
  const book = root.children.find((c) => localName(c.name) === 'Workbook') ?? root;
  const locale = createLocale(options.lang);
  const styles = new StyleTable();
  const cellStyles = new Map<string, { id: number; right: number; format?: string }>();
  for (const style of childrenOf(child(book, 'Styles'), 'Style')) {
    const font = child(style, 'Font');
    const align = attr(child(style, 'Alignment'), 'Horizontal');
    const interior = child(style, 'Interior');
    const sides = childrenOf(child(style, 'Borders'), 'Border').map((b) => (attr(b, 'Position') ?? '')[0]?.toLowerCase()).filter((s) => 'trbl'.includes(s ?? '-'));
    const cs: CellStyle = {};
    if (attr(font, 'Bold') === '1') cs.bold = true;
    if (attr(font, 'Italic') === '1') cs.italic = true;
    const fg = color(attr(font, 'Color'));
    if (fg && fg !== '#000000') cs.color = fg;
    if (attr(interior, 'Pattern') === 'Solid') cs.fill = color(attr(interior, 'Color'));
    if (align === 'Center' || align === 'Left' || align === 'Right') cs.align = align.toLowerCase() as CellStyle['align'];
    if (sides.length) cs.border = ['t', 'r', 'b', 'l'].filter((s) => sides.includes(s)).join('');
    const raw = attr(child(style, 'NumberFormat'), 'Format');
    const format = raw === undefined ? undefined : raw in NAMED_FORMATS ? NAMED_FORMATS[raw] : raw;
    cellStyles.set(attr(style, 'ID') ?? '', { id: styles.add(cs), right: styles.add({ ...cs, align: cs.align ?? 'right' }), format });
  }
  const rightOnly = styles.add({ align: 'right' });

  const sheets: { name: string; model: SheetModel }[] = [];
  for (const sheet of childrenOf(book, 'Worksheet')) {
    const visible = textContent(child(child(sheet, 'WorksheetOptions'), 'Visible'));
    if (visible === 'SheetHidden' || visible === 'SheetVeryHidden') continue;
    const builder = new SheetBuilder(options.maxRows);
    const table = child(sheet, 'Table');
    let c = 0;
    for (const column of childrenOf(table, 'Column')) {
      const index = Number(attr(column, 'Index'));
      if (index > 0) c = index - 1;
      const span = Math.min(Number(attr(column, 'Span')) || 0, 16384);
      const width = Number(attr(column, 'Width'));
      for (let i = 0; i <= span; i++) {
        if (attr(column, 'Hidden') === '1') builder.hideCol(c + i);
        // The width is in points; a default font character is about 5.6 points.
        else if (width > 0) builder.setWidth(c + i, width / 5.6);
      }
      c += span + 1;
    }
    let r = 0;
    for (const row of childrenOf(table, 'Row')) {
      const index = Number(attr(row, 'Index'));
      if (index > 0) r = index - 1;
      if (attr(row, 'Hidden') === '1') builder.hideRow(r);
      let col = 0;
      for (const cell of childrenOf(row, 'Cell')) {
        const ci = Number(attr(cell, 'Index'));
        if (ci > 0) col = ci - 1;
        const style = cellStyles.get(attr(cell, 'StyleID') ?? attr(row, 'StyleID') ?? '');
        const data = child(cell, 'Data');
        const type = attr(data, 'Type');
        const raw = textContent(data);
        let value = raw;
        let numeric = false;
        if (type === 'Number' && raw !== '' && Number.isFinite(Number(raw))) {
          value = formatValue(Number(raw), style?.format, locale);
          numeric = true;
        } else if (type === 'DateTime') {
          const s = serial(raw);
          if (s !== undefined) {
            value = formatValue(s, style?.format ?? builtinFormat(14), locale);
            numeric = true;
          }
        } else if (type === 'Boolean') value = raw === '1' ? locale.trueText : locale.falseText;
        builder.set(r, col, value, numeric ? (style?.right ?? rightOnly) : (style?.id ?? 0));
        const across = Number(attr(cell, 'MergeAcross')) || 0;
        const down = Number(attr(cell, 'MergeDown')) || 0;
        if (across || down) builder.addMerge({ r0: r, c0: col, r1: r + down, c1: col + across });
        col += across + 1;
      }
      r += (Number(attr(row, 'Span')) || 0) + 1;
    }
    sheets.push({ name: attr(sheet, 'Name') ?? `Sheet ${sheets.length + 1}`, model: builder.build(styles.list) });
  }
  if (!sheets.length) throw new Error('The workbook has no sheets with data');
  return { sheets: sheets.map((s) => s.name), openSheet: (i) => Promise.resolve(sheets[i].model) };
}

/** Number format from the cell style: mso-number-format:'\#\,\#\#0\.00'. */
function msoFormat(style: string | undefined): string | undefined {
  const m = /mso-number-format\s*:\s*(?:'([^']*)'|"([^"]*)"|([^;]+))/i.exec(style ?? '');
  if (!m) return undefined;
  const code = (m[1] ?? m[2] ?? m[3]).trim().replace(/\\(.)/g, '$1');
  return code in NAMED_FORMATS ? NAMED_FORMATS[code] : code;
}

function cellText(node: XmlNode): string {
  let out = '';
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === '#text') out += c.text.replace(/\s+/g, ' ');
      else if (c.name === 'br') out += '\n';
      else {
        const block = c.name === 'p' || c.name === 'div';
        if (block && out && !out.endsWith('\n')) out += '\n';
        walk(c);
      }
    }
  };
  walk(node);
  return out.trim();
}

export function openHtmlTable(text: string, options: WorkbookOptions, locale: NumFmtLocale = createLocale(options.lang)): Workbook {
  const tree = parseHtmlTree(text);
  const styles = new StyleTable();
  const builder = new SheetBuilder(options.maxRows);
  const occupied = new Set<string>();
  let r = 0;
  const tableRows = (table: XmlNode, out: XmlNode[] = []): XmlNode[] => {
    for (const c of table.children) {
      if (c.name === 'tr') out.push(c);
      else if (c.name === 'thead' || c.name === 'tbody' || c.name === 'tfoot') tableRows(c, out);
    }
    return out;
  };
  const visit = (node: XmlNode): void => {
    for (const c of node.children) {
      if (c.name !== 'table') {
        visit(c);
        continue;
      }
      if (r > 0) r++; // empty row between tables
      for (const tr of tableRows(c)) {
        let col = 0;
        for (const cell of tr.children) {
          if (cell.name !== 'td' && cell.name !== 'th') continue;
          while (occupied.has(`${r}:${col}`)) col++;
          const colSpan = Math.min(Math.max(Number(cell.attrs.colspan) || 1, 1), 500);
          const rowSpan = Math.min(Math.max(Number(cell.attrs.rowspan) || 1, 1), 5000);
          if (colSpan > 1 || rowSpan > 1) {
            builder.addMerge({ r0: r, c0: col, r1: r + rowSpan - 1, c1: col + colSpan - 1 });
            for (let i = 0; i < rowSpan; i++) for (let j = 0; j < colSpan; j++) if (i || j) occupied.add(`${r + i}:${col + j}`);
          }
          let value = cellText(cell);
          const css = cell.attrs.style ?? '';
          const format = msoFormat(css);
          const style: CellStyle = { border: 'trbl' };
          if (cell.name === 'th' || /font-weight\s*:\s*(bold|[6-9]00)/i.test(css)) style.bold = true;
          const align = /text-align\s*:\s*(left|center|right)/i.exec(css)?.[1] ?? cell.attrs.align;
          if (align === 'left' || align === 'center' || align === 'right') style.align = align;
          // Like Excel, numbers are recognised by their look; the "text" format (@) cancels that.
          const numeric = format !== '@' && /^-?\d+(\.\d+)?$/.test(value) && !/^-?0\d/.test(value);
          if (numeric) {
            if (format) value = formatValue(Number(value), format, locale);
            style.align ??= 'right';
          }
          builder.set(r, col, value, styles.add(style));
          col += colSpan;
        }
        r++;
      }
    }
  };
  visit(tree);
  if (r === 0) throw new Error('The file has no table');
  const name = /<x:Name>([^<]*)<\/x:Name>/i.exec(text)?.[1] ?? '';
  const model = builder.build(styles.list);
  return { sheets: [name], openSheet: () => Promise.resolve(model) };
}
