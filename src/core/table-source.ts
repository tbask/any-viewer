/**
 * Tabular data source for the grid and the worker message protocol.
 * The grid requests only visible rows; where the data lives (in a worker or on the main thread) does not matter to it.
 */
import { decodeText } from './encoding';
import { indexCsv, parseCsvRow } from './csv';
import { MAX_COL_CHARS, MIN_COL_CHARS, type RowBlock, type TableMeta, type Workbook, type WorkbookOptions } from './workbook';

export type { CellStyle, Merge, RowBlock, TableMeta, Workbook, WorkbookOptions } from './workbook';

export type TableFormat = 'csv' | 'xlsx' | 'ods' | 'xls';

export interface TableSource {
  /** Sheet names. A csv has one unnamed sheet. */
  readonly sheets: string[];
  /** Description of the active sheet. */
  readonly meta: TableMeta;
  selectSheet(index: number): Promise<TableMeta>;
  getRows(start: number, end: number): Promise<RowBlock>;
  dispose(): void;
}

/** CSV as a single-sheet workbook: a row index plus cell parsing on demand. */
export function openCsv(bytes: Uint8Array, options: WorkbookOptions): Workbook {
  const { text } = decodeText(bytes, options.fallbackEncoding);
  // Index one row beyond the limit to learn whether there is more.
  const index = indexCsv(text, undefined, options.maxRows + 1);
  const truncated = index.rowCount > options.maxRows;
  const rowCount = Math.min(index.rowCount, options.maxRows);
  const row = (r: number) => parseCsvRow(index.text, index.rowStarts[r], index.rowEnds[r], index.delimiter);

  const widths = new Array<number>(index.columnCount).fill(MIN_COL_CHARS);
  const sample = Math.min(rowCount, 200);
  for (let r = 0; r < sample; r++) {
    const cells = row(r);
    for (let c = 0; c < cells.length && c < widths.length; c++) {
      // A multi-line cell is measured by its longest line.
      let len = 0;
      for (const line of cells[c].split('\n')) if (line.length > len) len = line.length;
      if (len > widths[c]) widths[c] = Math.min(len, MAX_COL_CHARS);
    }
  }
  const meta: TableMeta = { rowCount, columnCount: index.columnCount, columnWidths: widths, truncated };
  return {
    sheets: [''],
    openSheet: () =>
      Promise.resolve({
        meta,
        getRows(start, end) {
          const rows: string[][] = [];
          for (let r = Math.max(0, start); r < Math.min(rowCount, end); r++) rows.push(row(r));
          return { rows };
        },
      }),
  };
}

// ----- worker message protocol -----

export type TableRequest =
  | { id: number; type: 'open'; format: TableFormat; blob: Blob; options: WorkbookOptions }
  | { id: number; type: 'sheet'; index: number }
  | { id: number; type: 'rows'; start: number; end: number };

export type TableResponse =
  | { id: number; ok: true; sheets?: string[]; meta?: TableMeta; block?: RowBlock }
  | { id: number; ok: false; error: string; errorName?: string };
