/** Picks the parser by format. The module is shared by the worker and the main-thread fallback. */
import { openCsv, type TableFormat } from '../core/table-source';
import type { Workbook, WorkbookOptions } from '../core/workbook';
import { openOds } from './ods';
import { openXls } from './xls';
import { openXlsx } from './xlsx';

export async function openWorkbook(format: TableFormat, blob: Blob, options: WorkbookOptions): Promise<Workbook> {
  switch (format) {
    case 'xlsx':
      return openXlsx(blob, options);
    case 'ods':
      return openOds(blob, options);
    case 'xls':
      return openXls(blob, options);
    default:
      return openCsv(new Uint8Array(await blob.arrayBuffer()), options);
  }
}
