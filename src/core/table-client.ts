/**
 * Client side of the table worker.
 * If a worker cannot be created (forbidden by CSP, say), parsing runs on the main thread.
 */
import TableWorker from '../workers/table.worker?worker&inline';
import type { RowBlock, TableFormat, TableMeta, TableRequest, TableResponse, TableSource, WorkbookOptions } from './table-source';
import type { SheetModel, Workbook } from './workbook';

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** A file parsing error (as opposed to a failure of the worker itself): retrying on the main thread is pointless. */
export class TableParseError extends Error {
  constructor(message: string, readonly errorName?: string) {
    super(message);
    this.name = 'TableParseError';
  }
}

class WorkerTableSource implements TableSource {
  sheets: string[] = [];
  meta!: TableMeta;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: TableResponse) => void; reject: (e: Error) => void }>();
  private disposed = false;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent<TableResponse>) => {
      const p = this.pending.get(event.data.id);
      if (!p) return;
      this.pending.delete(event.data.id);
      p.resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      const err = new Error(event.message || 'Worker error');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private async call(message: DistributiveOmit<TableRequest, 'id'>): Promise<TableResponse & { ok: true }> {
    if (this.disposed) throw new Error('The source is closed');
    const id = this.nextId++;
    const res = await new Promise<TableResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
    if (!res.ok) throw new TableParseError(res.error, res.errorName);
    return res;
  }

  async open(format: TableFormat, blob: Blob, options: WorkbookOptions): Promise<void> {
    const res = await this.call({ type: 'open', format, blob, options });
    this.sheets = res.sheets ?? [''];
    this.meta = res.meta!;
  }

  async selectSheet(index: number): Promise<TableMeta> {
    this.meta = (await this.call({ type: 'sheet', index })).meta!;
    return this.meta;
  }

  async getRows(start: number, end: number): Promise<RowBlock> {
    return (await this.call({ type: 'rows', start, end })).block ?? { rows: [] };
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    const err = new Error('The source is closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

class LocalTableSource implements TableSource {
  sheets: string[];
  meta: TableMeta;
  constructor(private readonly workbook: Workbook, private sheet: SheetModel) {
    this.sheets = workbook.sheets;
    this.meta = sheet.meta;
  }
  async selectSheet(index: number): Promise<TableMeta> {
    this.sheet = await this.workbook.openSheet(index);
    this.meta = this.sheet.meta;
    return this.meta;
  }
  getRows(start: number, end: number): Promise<RowBlock> {
    return Promise.resolve(this.sheet.getRows(start, end));
  }
  dispose(): void {}
}

export async function createTableSource(format: TableFormat, blob: Blob, options: WorkbookOptions, useWorker: boolean): Promise<TableSource> {
  if (useWorker && typeof Worker !== 'undefined') {
    let source: WorkerTableSource | null = null;
    try {
      source = new WorkerTableSource(new TableWorker());
      await source.open(format, blob, options);
      return source;
    } catch (err) {
      source?.dispose();
      if (err instanceof TableParseError) throw err;
      // The worker itself failed: try on the main thread.
    }
  }
  const { openWorkbook } = await import('../formats/tables');
  const workbook = await openWorkbook(format, blob, options);
  return new LocalTableSource(workbook, await workbook.openSheet(0));
}
