/**
 * Reader of ods (OpenDocument Spreadsheet).
 * All sheets lie in one content.xml, and cells store already formatted text,
 * so number format codes are not needed here. The file is read as a stream in one pass.
 */
import { loadImage } from '../core/images';
import { SheetBuilder, StyleTable, type CellStyle, type SheetModel, type SheetObject, type Workbook, type WorkbookOptions } from '../core/workbook';
import { decodeXmlBytes, parseXml, parseXmlSax } from '../core/xml';
import { parseOdfChart } from './odf-draw';
import { applyConditional, type Conditional } from './xlsx-extras';
import type { Merge } from '../core/workbook';
import type { XmlNode } from '../core/xml';
import { ZipReader } from '../core/zip';

const MAX_REPEAT_FILL = 1024; // how many repeats a non-empty cell or row is expanded to

/** A length like "2.258cm" → width in characters. */
export function lengthToChars(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^([\d.]+)(cm|mm|in|pt|px)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const px = m[2] === 'cm' ? n * 37.8 : m[2] === 'mm' ? n * 3.78 : m[2] === 'in' ? n * 96 : m[2] === 'pt' ? n * 1.333 : n;
  return px / 7.2;
}

function normalizeColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
}

export async function openOds(blob: Blob, options: WorkbookOptions): Promise<Workbook> {
  const zip = await ZipReader.open(blob);
  if (!zip.has('content.xml')) throw new Error('The file has no content (content.xml)');
  const xml = decodeXmlBytes(await zip.read('content.xml'));

  const styles = new StyleTable();
  const cellStyles = new Map<string, number>();
  const columnStyles = new Map<string, number>();
  const rowStyles = new Map<string, number>();
  let noteText = '';
  let inNotePara = false;
  const sheets: { name: string; model: SheetModel }[] = [];
  // Sheets are finished after their objects (pictures and charts) are loaded.
  const builders: { name: string; builder: SheetBuilder }[] = [];

  // Conditional styling like "value greater than 50 → style cf1": rules are written right in the cell style.
  const styleMaps = new Map<string, { test: (v: number) => boolean; apply: string }[]>();
  const conditionalStyles = new Map<string, CellStyle>();
  const mapped = new Map<string, number>();
  const hasRules = xml.includes('<calcext:conditional-format ');
  if (xml.includes('<style:map') || hasRules) {
    const sources = [xml];
    if (zip.has('styles.xml')) sources.push(decodeXmlBytes(await zip.read('styles.xml')));
    for (const source of sources) {
      for (const m of source.matchAll(/<style:style\b([^>]*style:family="table-cell"[^>]*)>([\s\S]*?)<\/style:style>/g)) {
        const name = /style:name="([^"]*)"/.exec(m[1])?.[1];
        if (!name || conditionalStyles.has(name)) continue;
        const look: CellStyle = {};
        const fill = normalizeColor(/fo:background-color="([^"]*)"/.exec(m[2])?.[1]);
        const color = normalizeColor(/fo:color="([^"]*)"/.exec(m[2])?.[1]);
        if (fill) look.fill = fill;
        if (color) look.color = color;
        if (/fo:font-weight="bold"/.test(m[2])) look.bold = true;
        if (/fo:font-style="italic"/.test(m[2])) look.italic = true;
        conditionalStyles.set(name, look);
        // A style reference may carry its display name (in the name itself characters like "_" are escaped).
        const display = /style:display-name="([^"]*)"/.exec(m[1])?.[1];
        if (display && !conditionalStyles.has(display)) conditionalStyles.set(display, look);
      }
    }
  }
  const parseCondition = (text: string): ((v: number) => boolean) | undefined => {
    const t = text.replace(/^of:/, '').replace(/\s+/g, '');
    let m = /^cell-content\(\)(>=|<=|!=|<>|>|<|=)(-?[\d.]+)$/.exec(t);
    if (m) {
      const n = Number(m[2]);
      const op = m[1];
      return (v) => (op === '>' ? v > n : op === '<' ? v < n : op === '>=' ? v >= n : op === '<=' ? v <= n : op === '=' ? v === n : v !== n);
    }
    m = /^cell-content-is-(not-)?between\((-?[\d.]+),(-?[\d.]+)\)$/.exec(t);
    if (m) {
      const lo = Number(m[2]);
      const hi = Number(m[3]);
      const negate = !!m[1];
      return (v) => (v >= lo && v <= hi) !== negate;
    }
    return undefined;
  };

  // LibreOffice conditional formatting: rules follow the sheet rows and are collected in the same form as in xlsx.
  const mk = (name: string, attrs: Record<string, string> = {}, children: XmlNode[] = [], text = ''): XmlNode => ({ name, attrs, children: text ? [{ name: '#text', attrs: {}, children: [], text }, ...children] : children, text: '' });
  const ENTRY_TYPES: Record<string, string> = { minimum: 'min', maximum: 'max', 'auto-minimum': 'min', 'auto-maximum': 'max', number: 'num', percent: 'percent', percentile: 'percentile', formula: 'formula' };
  let sheetRules: Conditional[] = [];
  let ruleSet: Conditional | null = null;
  let ruleKind = '';
  let ruleParts: XmlNode[] = [];
  let ruleAttrs: Record<string, string> = {};
  let rulePriority = 1;
  const rangeOf = (address: string): Merge | undefined => {
    const cells = [...address.matchAll(/\.\$?([A-Z]{1,3})\$?(\d+)/g)];
    if (!cells.length) return undefined;
    const col = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const a = cells[0];
    const b = cells[1] ?? a;
    return { r0: Number(a[2]) - 1, c0: col(a[1]), r1: Number(b[2]) - 1, c1: col(b[1]) };
  };
  /** A condition like ">50", "between(1,5)", "formula-is(…)" → a rule in xlsx notation. */
  const conditionRule = (value: string): { type: string; node: XmlNode } | undefined => {
    const v = value.trim();
    let m = /^(>=|<=|!=|<>|>|<|=)(.+)$/.exec(v);
    if (m) {
      const operator = { '>': 'greaterThan', '<': 'lessThan', '>=': 'greaterThanOrEqual', '<=': 'lessThanOrEqual', '=': 'equal', '!=': 'notEqual', '<>': 'notEqual' }[m[1]]!;
      return { type: 'cellIs', node: mk('cfRule', { operator }, [mk('formula', {}, [], m[2].trim())]) };
    }
    m = /^(not-)?between\((.+?),(.+)\)$/.exec(v);
    if (m) return { type: 'cellIs', node: mk('cfRule', { operator: m[1] ? 'notBetween' : 'between' }, [mk('formula', {}, [], m[2].trim()), mk('formula', {}, [], m[3].trim())]) };
    m = /^formula-is\(([\s\S]*)\)$/.exec(v);
    if (m) {
      // References are written as [.$C2] and [.$A$2:.$A$11]; references to other sheets stay as is and the rule is skipped.
      const formula = m[1].replace(/\[\.([^\]:.]+)(?::\.([^\]]+))?\]/g, (_, a: string, b?: string) => (b ? `${a}:${b}` : a));
      return { type: 'expression', node: mk('cfRule', {}, [mk('formula', {}, [], formula)]) };
    }
    if (v === 'duplicate') return { type: 'duplicateValues', node: mk('cfRule') };
    if (v === 'unique') return { type: 'uniqueValues', node: mk('cfRule') };
    m = /^(above|below)(-equal)?-average$/.exec(v);
    if (m) return { type: 'aboveAverage', node: mk('cfRule', { ...(m[1] === 'below' ? { aboveAverage: '0' } : {}), ...(m[2] ? { equalAverage: '1' } : {}) }) };
    m = /^(top|bottom)-(elements|percent)\((\d+)\)$/.exec(v);
    if (m) return { type: 'top10', node: mk('cfRule', { rank: m[3], ...(m[1] === 'bottom' ? { bottom: '1' } : {}), ...(m[2] === 'percent' ? { percent: '1' } : {}) }) };
    m = /^(contains-text|not-contains-text|begins-with|ends-with)\("?(.*?)"?\)$/.exec(v);
    if (m) return { type: { 'contains-text': 'containsText', 'not-contains-text': 'notContainsText', 'begins-with': 'beginsWith', 'ends-with': 'endsWith' }[m[1]]!, node: mk('cfRule', { text: m[2] }) };
    return undefined;
  };

  // Parsing of style descriptions.
  let styleName = '';
  let styleFamily = '';
  let pendingStyle: CellStyle | null = null;

  // Table parsing state.
  let builder: SheetBuilder | null = null;
  let sheetName = '';
  let sheetHidden = false;
  let rowHidden = false;
  const hiddenTables = new Set<string>();
  let row = 0;
  let col = 0;
  let colDef = 0;
  let rowRepeat = 1;
  let rowCells: { col: number; text: string; style: number; repeat: number }[] = [];
  let cellText = '';
  let cellStyle = 0;
  let cellRepeat = 1;
  let inCell = false;
  let paragraphs = 0;
  let inParagraph = 0;
  let skip = 0; // nesting of elements whose text does not belong to the cell (comments, shapes)
  // Objects above the cells: pictures, charts, shapes. Their content is loaded after the sheets are parsed.
  interface Drawing { row: number; col: number; x: number; y: number; w: number; h: number; image?: string; object?: string; text?: string; style?: string; ellipse?: boolean }
  const graphicStyles = new Map<string, { fill?: string; stroke?: string }>();
  // Cell numbers (unformatted) are the data source for charts; a limited amount is kept.
  const rawBySheet = new Map<string, Map<number, number | string>>();
  let tableRaw = new Map<number, number | string>();
  let rawCount = 0;
  let pendingRaw: number | undefined;
  let cellMaps: { test: (v: number) => boolean; apply: string }[] | undefined;
  let drawing: Drawing | null = null;
  let drawDepth = 0;
  let tableDrawings: Drawing[] = [];
  const sheetDrawings: Drawing[][] = [];
  const toPx = (value: string | undefined): number => {
    const m = /^(-?[\d.]+)(in|cm|mm|pt|px)?$/.exec(value ?? '');
    if (!m) return 0;
    const n = Number(m[1]);
    return m[2] === 'cm' ? (n / 2.54) * 96 : m[2] === 'mm' ? (n / 25.4) * 96 : m[2] === 'pt' ? n / 0.75 : m[2] === 'px' ? n : n * 96;
  };
  let tableDepth = 0;

  parseXmlSax(xml, {
    open(name, a) {
      switch (name) {
        case 'style:style':
          styleName = a['style:name'] ?? '';
          styleFamily = a['style:family'] ?? '';
          pendingStyle = styleFamily === 'table-cell' ? {} : null;
          break;
        case 'style:graphic-properties':
          if (styleFamily === 'graphic' && styleName) {
            graphicStyles.set(styleName, {
              fill: a['draw:fill'] === 'none' ? undefined : normalizeColor(a['draw:fill-color']),
              stroke: a['draw:stroke'] === 'none' ? undefined : normalizeColor(a['svg:stroke-color']),
            });
          }
          break;
        case 'draw:frame':
        case 'draw:custom-shape':
        case 'draw:rect':
        case 'draw:ellipse':
          if (tableDepth !== 1 || !builder) break;
          if (drawDepth++ === 0) {
            drawing = { row, col, x: toPx(a['svg:x']), y: toPx(a['svg:y']), w: toPx(a['svg:width']), h: toPx(a['svg:height']), style: a['draw:style-name'], ellipse: name === 'draw:ellipse' };
            skip++;
            noteText = '';
          }
          break;
        case 'draw:image':
          if (drawing && !drawing.image && a['xlink:href'] && !/^[a-z]+:/i.test(a['xlink:href'])) drawing.image = a['xlink:href'].replace(/^\.\//, '');
          break;
        case 'draw:object':
          if (drawing && a['xlink:href']) drawing.object = a['xlink:href'].replace(/^\.\//, '').replace(/\/$/, '');
          break;
        case 'calcext:conditional-format': {
          const ranges = (a['calcext:target-range-address'] ?? '').split(/\s+/).map(rangeOf).filter((r): r is Merge => !!r);
          ruleSet = tableDepth === 1 && ranges.length ? { ranges, rules: [] } : null;
          break;
        }
        case 'calcext:color-scale':
        case 'calcext:data-bar':
        case 'calcext:icon-set':
          ruleKind = name;
          ruleParts = [];
          ruleAttrs = { ...a };
          break;
        case 'calcext:color-scale-entry':
        case 'calcext:formatting-entry': {
          if (!ruleKind) break;
          const type = ENTRY_TYPES[a['calcext:type'] ?? ''] ?? 'num';
          ruleParts.push(mk('cfvo', type === 'min' || type === 'max' ? { type } : { type, val: a['calcext:value'] ?? '0' }));
          const entryColor = normalizeColor(a['calcext:color']);
          if (name === 'calcext:color-scale-entry') ruleParts.push(mk('color', entryColor ? { rgb: `ff${entryColor.slice(1)}` } : {}));
          break;
        }
        case 'calcext:condition': {
          const parsed = ruleSet ? conditionRule(a['calcext:value'] ?? '') : undefined;
          const look = conditionalStyles.get(a['calcext:apply-style-name'] ?? '');
          if (parsed && look && ruleSet) ruleSet.rules.push({ type: parsed.type, priority: rulePriority++, node: parsed.node, style: look });
          break;
        }
        case 'style:map': {
          const test = styleFamily === 'table-cell' && a['style:condition'] ? parseCondition(a['style:condition']) : undefined;
          if (test && styleName && a['style:apply-style-name']) styleMaps.set(styleName, [...(styleMaps.get(styleName) ?? []), { test, apply: a['style:apply-style-name'] }]);
          break;
        }
        case 'style:table-properties':
          if (styleFamily === 'table' && a['table:display'] === 'false') hiddenTables.add(styleName);
          break;
        case 'style:table-column-properties': {
          const w = lengthToChars(a['style:column-width']);
          if (styleFamily === 'table-column' && w) columnStyles.set(styleName, w);
          break;
        }
        case 'style:table-row-properties': {
          const h = /^([\d.]+)(pt|cm|mm|in)$/.exec(a['style:row-height'] ?? '');
          if (styleFamily === 'table-row' && h) rowStyles.set(styleName, Number(h[1]) * ({ pt: 1, cm: 28.35, mm: 2.835, in: 72 }[h[2]] ?? 1));
          break;
        }
        case 'style:text-properties':
          if (pendingStyle) {
            const size = /^([\d.]+)pt$/.exec(a['fo:font-size'] ?? '');
            if (size && Math.abs(Number(size[1]) - 11) >= 0.5) pendingStyle.size = Number(size[1]);
            if (a['style:text-underline-style'] && a['style:text-underline-style'] !== 'none') pendingStyle.underline = true;
            if (a['style:text-line-through-style'] && a['style:text-line-through-style'] !== 'none') pendingStyle.strike = true;
            if (a['fo:font-weight'] === 'bold') pendingStyle.bold = true;
            if (a['fo:font-style'] === 'italic') pendingStyle.italic = true;
            const color = normalizeColor(a['fo:color']);
            if (color && color !== '#000000') pendingStyle.color = color;
          }
          break;
        case 'style:table-cell-properties':
          if (pendingStyle) {
            const fill = normalizeColor(a['fo:background-color']);
            if (fill) pendingStyle.fill = fill;
            if (a['fo:wrap-option'] === 'wrap') pendingStyle.wrap = true;
            if (a['style:vertical-align'] === 'top') pendingStyle.valign = 'top';
            else if (a['style:vertical-align'] === 'middle') pendingStyle.valign = 'middle';
            const has = (side: string) => {
              const v = a[`fo:border-${side}`] ?? a['fo:border'];
              return v !== undefined && v !== 'none';
            };
            const border = (has('top') ? 't' : '') + (has('right') ? 'r' : '') + (has('bottom') ? 'b' : '') + (has('left') ? 'l' : '');
            if (border) pendingStyle.border = border;
          }
          break;
        case 'style:paragraph-properties':
          if (pendingStyle) {
            const align = a['fo:text-align'];
            if (align === 'center') pendingStyle.align = 'center';
            else if (align === 'end' || align === 'right') pendingStyle.align = 'right';
            else if (align === 'start' || align === 'left') pendingStyle.align = 'left';
          }
          break;
        case 'table:table':
          tableDepth++;
          if (tableDepth === 1) {
            builder = new SheetBuilder(options.maxRows);
            sheetName = a['table:name'] ?? `Sheet ${sheets.length + 1}`;
            sheetHidden = hiddenTables.has(a['table:style-name'] ?? '');
            row = 0;
            colDef = 0;
          }
          break;
        case 'table:table-column': {
          if (tableDepth !== 1 || !builder) break;
          const repeat = Number(a['table:number-columns-repeated'] ?? 1) || 1;
          const width = columnStyles.get(a['table:style-name'] ?? '');
          const colVisibility = a['table:visibility'];
          if (colVisibility === 'collapse' || colVisibility === 'filter') for (let c = 0; c < Math.min(repeat, 16384); c++) builder.hideCol(colDef + c);
          else if (width) for (let c = 0; c < Math.min(repeat, MAX_REPEAT_FILL); c++) builder.setWidth(colDef + c, width);
          colDef += repeat;
          break;
        }
        case 'table:table-row':
          if (tableDepth !== 1) break;
          rowRepeat = Number(a['table:number-rows-repeated'] ?? 1) || 1;
          rowHidden = a['table:visibility'] === 'collapse' || a['table:visibility'] === 'filter';
          {
            const h = rowStyles.get(a['table:style-name'] ?? '');
            if (h && builder) for (let k = 0; k < Math.min(rowRepeat, 2000); k++) builder.setHeight(row + k, h);
          }
          col = 0;
          rowCells = [];
          break;
        case 'table:table-cell':
        case 'table:covered-table-cell': {
          if (tableDepth !== 1 || !builder) break;
          inCell = true;
          cellText = '';
          pendingRaw = undefined;
          if (a['office:value'] !== undefined && rawCount < 200_000) {
            const value = Number(a['office:value']);
            if (Number.isFinite(value)) pendingRaw = value;
          }
          paragraphs = 0;
          cellRepeat = Number(a['table:number-columns-repeated'] ?? 1) || 1;
          cellStyle = cellStyles.get(a['table:style-name'] ?? '') ?? 0;
          cellMaps = styleMaps.get(a['table:style-name'] ?? '');
          {
            // Numbers, dates and percentages without explicit alignment are right-aligned.
            const type = a['office:value-type'];
            if (type && type !== 'string' && type !== 'boolean') {
              const base = styles.list[cellStyle];
              if (!base.align) cellStyle = styles.add({ ...base, align: 'right' });
            }
          }
          const spanC = Number(a['table:number-columns-spanned'] ?? 1) || 1;
          const spanR = Number(a['table:number-rows-spanned'] ?? 1) || 1;
          if (spanC > 1 || spanR > 1) builder.addMerge({ r0: row, c0: col, r1: row + spanR - 1, c1: col + spanC - 1 });
          break;
        }
        case 'office:annotation':
          skip++;
          noteText = '';
          break;
        case 'text:p':
        case 'text:h':
          if (skip > 0) {
            if (noteText) noteText += '\n';
            inNotePara = true;
          }
          if (inCell && skip === 0) {
            if (inParagraph === 0 && paragraphs++ > 0) cellText += '\n';
            inParagraph++;
          }
          break;
        case 'text:s':
          if (inParagraph && skip === 0) cellText += ' '.repeat(Math.min(Number(a['text:c'] ?? 1) || 1, 1000));
          else if (skip > 0 && inNotePara) noteText += ' ';
          break;
        case 'text:tab':
          if (inParagraph && skip === 0) cellText += '\t';
          break;
        case 'text:line-break':
          if (inParagraph && skip === 0) cellText += '\n';
          break;
      }
    },
    close(name) {
      switch (name) {
        case 'style:style':
          if (pendingStyle && styleName) cellStyles.set(styleName, styles.add(pendingStyle));
          pendingStyle = null;
          styleFamily = '';
          break;
        case 'text:p':
        case 'text:h':
          if (inCell && skip === 0 && inParagraph > 0) inParagraph--;
          inNotePara = false;
          break;
        case 'draw:frame':
        case 'draw:custom-shape':
        case 'draw:rect':
        case 'draw:ellipse':
          if (drawDepth > 0 && --drawDepth === 0 && drawing) {
            skip--;
            drawing.text = noteText.trim() || undefined;
            if (drawing.w > 2 && drawing.h > 2 && tableDrawings.length < 300) tableDrawings.push(drawing);
            drawing = null;
          }
          break;
        case 'calcext:color-scale':
        case 'calcext:data-bar':
        case 'calcext:icon-set': {
          if (ruleSet && ruleKind === name && ruleParts.length) {
            let body: XmlNode;
            let type: string;
            if (name === 'calcext:color-scale') {
              // In xlsx notation all thresholds come first, then all colours.
              body = mk('colorScale', {}, [...ruleParts.filter((n) => n.name === 'cfvo'), ...ruleParts.filter((n) => n.name === 'color')]);
              type = 'colorScale';
            } else if (name === 'calcext:data-bar') {
              const barColor = normalizeColor(ruleAttrs['calcext:positive-color']) ?? '#638ec6';
              body = mk('dataBar', {}, [...ruleParts, mk('color', { rgb: `ff${barColor.slice(1)}` })]);
              type = 'dataBar';
            } else {
              body = mk('iconSet', { iconSet: ruleAttrs['calcext:icon-set-type'] ?? '3TrafficLights1' }, ruleParts);
              type = 'iconSet';
            }
            ruleSet.rules.push({ type, priority: rulePriority++, node: mk('cfRule', { type }, [body]), style: undefined });
          }
          ruleKind = '';
          break;
        }
        case 'calcext:conditional-format':
          if (ruleSet?.rules.length && sheetRules.length < 200) sheetRules.push(ruleSet);
          ruleSet = null;
          break;
        case 'office:annotation':
          skip--;
          if (skip === 0 && builder && tableDepth === 1 && noteText.trim()) builder.addNote(row, col, noteText.trim());
          break;
        case 'table:table-cell':
        case 'table:covered-table-cell':
          if (tableDepth !== 1) break;
          if (cellText !== '' || cellStyle !== 0) rowCells.push({ col, text: cellText, style: cellStyle, repeat: cellRepeat });
          if (pendingRaw !== undefined && cellMaps) {
            // The first rule that holds adds its formatting to the cell style.
            const hit = cellMaps.find((rule) => rule.test(pendingRaw!));
            const look = hit ? conditionalStyles.get(hit.apply) : undefined;
            const last = rowCells[rowCells.length - 1];
            if (hit && look && last && last.col === col) {
              const key = `${last.style}|${hit.apply}`;
              let id = mapped.get(key);
              if (id === undefined) {
                id = styles.add({ ...styles.list[last.style], ...look });
                mapped.set(key, id);
              }
              last.style = id;
            }
          }
          {
            // Equal neighbouring cells are written as one cell with a repeat count.
            // Text values are needed by "contains text" and "duplicates" rules and by formulas.
            const rawValue = pendingRaw ?? (hasRules && cellText !== '' ? cellText : undefined);
            if (rawValue !== undefined && rawCount < 200_000) {
              for (let k = 0; k < Math.min(cellRepeat, 256) && col + k < 16384; k++, rawCount++) tableRaw.set(row * 16384 + col + k, rawValue);
            }
          }
          col += cellRepeat;
          inCell = false;
          inParagraph = 0;
          break;
        case 'table:table-row': {
          if (tableDepth !== 1 || !builder) break;
          // Cells without text but with a style count only next to data: otherwise the sheet would swell
          // to thousands of empty "formatted" columns.
          const hasText = rowCells.some((c) => c.text !== '');
          if (hasText) {
            let lastTextCol = 0;
            for (const c of rowCells) if (c.text !== '') lastTextCol = Math.max(lastTextCol, c.col + Math.min(c.repeat, MAX_REPEAT_FILL) - 1);
            const copies = Math.min(rowRepeat, MAX_REPEAT_FILL);
            for (let k = 0; k < copies; k++) {
              for (const c of rowCells) {
                const n = Math.min(c.repeat, MAX_REPEAT_FILL);
                for (let i = 0; i < n; i++) {
                  if (c.text === '' && c.col + i > lastTextCol) break;
                  builder.set(row + k, c.col + i, c.text, c.style);
                }
              }
            }
          }
          if (rowHidden) for (let k = 0; k < Math.min(rowRepeat, 100_000); k++) builder.hideRow(row + k);
          row += rowRepeat;
          break;
        }
        case 'table:table':
          if (tableDepth === 1 && builder && sheetRules.length) {
            try {
              applyConditional(sheetRules, tableRaw, builder, styles, (n) => (n?.attrs.rgb ? `#${n.attrs.rgb.slice(-6).toLowerCase()}` : undefined));
            } catch {
              // A failure in conditional formatting must not prevent showing the data.
            }
          }
          if (tableDepth === 1) sheetRules = [];
          if (tableDepth === 1 && builder && !sheetHidden) {
            builders.push({ name: sheetName, builder });
            sheetDrawings.push(tableDrawings);
          }
          if (tableDepth === 1) {
            rawBySheet.set(sheetName, tableRaw);
            tableRaw = new Map();
            tableDrawings = [];
          }
          tableDepth--;
          break;
      }
    },
    text(t) {
      if (inCell && inParagraph > 0 && skip === 0) cellText += t;
      else if (skip > 0 && inNotePara) noteText += t;
    },
  });

  if (builders.length === 0) throw new Error('The document has no tables');

  // Object content: a chart from the embedded document, else a picture, else a shape with text.
  const cellValues = (sheet: string, r0: number, c0: number, r1: number, c1: number): (string | number | null)[] => {
    const raw = rawBySheet.get(sheet);
    const source = builders.find((s) => s.name === sheet)?.builder;
    const out: (string | number | null)[] = [];
    if (r1 - r0 > 5000 || c1 - c0 > 500) return out;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(raw?.get(r * 16384 + c) ?? (source?.textAt(r, c) || null));
    return out;
  };
  for (let i = 0; i < builders.length; i++) {
    const objects: SheetObject[] = [];
    for (const d of sheetDrawings[i] ?? []) {
      // The bottom-right corner is a rough estimate: the sheet is extended by it so that the object fits.
      const object: SheetObject = { r0: d.row, c0: d.col, r1: d.row + Math.ceil((d.y + d.h) / 20), c1: d.col + Math.ceil((d.x + d.w) / 64), ox: d.x, oy: d.y, w: d.w, h: d.h };
      try {
        const chartEntry = d.object ? zip.get(`${d.object}/content.xml`) : undefined;
        const chart = chartEntry ? parseOdfChart(parseXml(decodeXmlBytes(await zip.read(chartEntry))), cellValues) : undefined;
        const imageEntry = !chart && d.image ? zip.get(d.image) : undefined;
        const image = imageEntry ? loadImage(d.image!, await zip.read(imageEntry)) : undefined;
        if (chart) object.chart = chart;
        else if (image) object.image = image;
        else if (!d.object && !d.image) {
          const look = graphicStyles.get(d.style ?? '');
          if (!d.text && !look?.fill && !look?.stroke) continue;
          object.text = d.text;
          object.fill = look?.fill;
          object.stroke = look?.stroke;
          if (d.ellipse) object.shape = 'ellipse';
        } else continue;
        objects.push(object);
      } catch {
        // The object was not read: the sheet is shown without it.
      }
    }
    for (const object of objects) builders[i].builder.addObject(object);
    sheets.push({ name: builders[i].name, model: builders[i].builder.build(styles.list) });
  }
  return {
    sheets: sheets.map((s) => s.name),
    openSheet: (i) => Promise.resolve(sheets[i].model),
  };
}
