import { TableParseError, createTableSource } from '../core/table-client';
import type { TableFormat } from '../core/table-source';
import { ViewerError } from '../types';
import { createGrid } from './grid';
import { el, type RenderContext, type RendererHandle } from './types';

/** View of tabular formats: csv, xlsx, ods, xls. */
export async function createTableRenderer(ctx: RenderContext): Promise<RendererHandle> {
  const blob = ctx.blob!;
  if (blob.size > ctx.limits.maxTableBytes) throw new ViewerError('too-large', ctx.labels.tooLarge, ctx.format);
  const format = ctx.format as TableFormat;

  let source;
  try {
    source = await createTableSource(
      format,
      blob,
      {
        fallbackEncoding: ctx.options.fallbackEncoding,
        maxRows: ctx.limits.maxTableRows,
        password: ctx.password,
        lang: ctx.options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined),
      },
      ctx.options.useWorkers !== false,
    );
  } catch (err) {
    const name = err instanceof TableParseError ? err.errorName : (err as Error | null)?.name;
    if (name === 'XlsPasswordError' || name === 'PasswordRequiredError' || name === 'WrongPasswordError' || name === 'EncryptionUnsupportedError') throw new ViewerError('password', ctx.labels.passwordProtected, ctx.format, err);
    throw new ViewerError('corrupt', ctx.labels.loadFailed, ctx.format, err);
  }
  if (ctx.signal.aborted) {
    source.dispose();
    return { destroy() {} };
  }
  if (format === 'csv' && source.meta.rowCount === 0) {
    source.dispose();
    const empty = el('div', 'fv-empty', ctx.labels.empty);
    ctx.host.appendChild(empty);
    return { destroy: () => empty.remove() };
  }
  // Styled workbooks are shown on light "paper": colours in the file are chosen for a white background.
  return createGrid(ctx, source, { paper: format !== 'csv' });
}
