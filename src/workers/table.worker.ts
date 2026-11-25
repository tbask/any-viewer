/// <reference lib="webworker" />
/**
 * Worker for tabular data: parses the file, keeps the sheets and returns rows on request.
 * Only the visible window goes to the main thread, so the interface stays responsive even on large files.
 */
import type { TableRequest, TableResponse } from '../core/table-source';
import type { SheetModel, Workbook } from '../core/workbook';
import { openWorkbook } from '../formats/tables';

let workbook: Workbook | null = null;
let sheet: SheetModel | null = null;
const ctx = self as unknown as DedicatedWorkerGlobalScope;

async function handle(msg: TableRequest): Promise<TableResponse> {
  if (msg.type === 'open') {
    workbook = await openWorkbook(msg.format, msg.blob, msg.options);
    sheet = await workbook.openSheet(0);
    return { id: msg.id, ok: true, sheets: workbook.sheets, meta: sheet.meta };
  }
  if (!workbook || !sheet) throw new Error('No table is open');
  if (msg.type === 'sheet') {
    sheet = await workbook.openSheet(msg.index);
    return { id: msg.id, ok: true, meta: sheet.meta };
  }
  return { id: msg.id, ok: true, block: sheet.getRows(msg.start, msg.end) };
}

// Messages are handled strictly in order: a sheet switch must not overtake a row request.
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (event: MessageEvent<TableRequest>) => {
  const msg = event.data;
  queue = queue.then(async () => {
    let response: TableResponse;
    try {
      response = await handle(msg);
    } catch (err) {
      response = { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err), errorName: err instanceof Error ? err.name : undefined };
    }
    ctx.postMessage(response);
  });
};
