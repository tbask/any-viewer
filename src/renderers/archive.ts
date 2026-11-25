/**
 * Archive view (zip, tar, gz, rar, 7z and containers based on them): a list of files with sizes.
 * A file opens when its row is clicked: it is extracted into memory and shown in the same viewer.
 * Entries that cannot be extracted (unsupported method, encryption) are listed but not clickable.
 * Of RAR archives only the list is read: a click on a compressed file ends with a notice.
 */
import { gunzip, gzipOriginalName, listTar, type ArchiveEntry } from '../core/tar';
import { ZipReader } from '../core/zip';
import { ViewerError } from '../types';
import { el, type RenderContext, type RendererHandle } from './types';

const MAX_ROWS = 5000;

/** Formats a size with the given unit names (bytes, kilobytes, megabytes, gigabytes) and decimal separator. */
export function formatSize(bytes: number, units: readonly string[] = ['B', 'KB', 'MB', 'GB'], decimal = '.'): string {
  const fixed = (value: number, digits: number) => value.toFixed(digits).replace('.', decimal);
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1024 * 1024) return `${fixed(bytes / 1024, 1)} ${units[1]}`;
  if (bytes < 1024 ** 3) return `${fixed(bytes / 1024 / 1024, 1)} ${units[2]}`;
  return `${fixed(bytes / 1024 ** 3, 2)} ${units[3]}`;
}

async function listEntries(ctx: RenderContext): Promise<ArchiveEntry[]> {
  const blob = ctx.blob!;
  if (ctx.format === 'zip') {
    const zip = await ZipReader.open(blob);
    return zip.entries.map((e) => ({ name: e.name, size: e.size, directory: e.isDirectory, read: e.isDirectory ? undefined : () => zip.read(e) }));
  }
  if (ctx.format === 'tar') return listTar(new Uint8Array(await blob.arrayBuffer()));
  if (ctx.format === 'rar') return (await import('../core/rar')).listRar(new Uint8Array(await blob.arrayBuffer()));
  if (ctx.format === '7z') return (await import('../core/sevenzip')).list7z(new Uint8Array(await blob.arrayBuffer()), 10_000, 64 * 1024 * 1024, ctx.limits.maxFileBytes);
  // gz: one file inside; if it is a tar, its contents are shown.
  const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  const data = await gunzip(blob, ctx.limits.maxFileBytes);
  if (data.length > 262 && String.fromCharCode(...data.subarray(257, 262)) === 'ustar') return listTar(data);
  const name = gzipOriginalName(head) ?? ctx.name.replace(/\.(gz|tgz)$/i, '') ?? '';
  return [{ name: name || '—', size: data.length, directory: false, read: () => data }];
}

export async function createArchiveRenderer(ctx: RenderContext): Promise<RendererHandle> {
  let entries: ArchiveEntry[];
  try {
    entries = await listEntries(ctx);
  } catch (err) {
    if ((err as Error)?.name === 'PasswordError') throw new ViewerError('password', ctx.labels.passwordProtected, ctx.format, err);
    throw new ViewerError('corrupt', ctx.labels.corrupt, ctx.format, err);
  }
  if (ctx.signal.aborted) return { destroy() {} };

  const wrap = el('div', 'fv-archive');
  wrap.tabIndex = 0;
  if (!entries.length) {
    wrap.appendChild(el('div', 'fv-empty', ctx.labels.empty));
  } else {
    const table = el('table', 'fv-archive-table');
    const head = el('tr');
    head.append(el('th', undefined, ctx.labels.fileName), el('th', 'fv-archive-size', ctx.labels.fileSize));
    const thead = el('thead');
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const entry of entries.slice(0, MAX_ROWS)) {
      const tr = el('tr');
      const name = el('td', entry.directory ? 'fv-archive-dir' : undefined, entry.name);
      tr.append(name, el('td', 'fv-archive-size', entry.directory ? '' : formatSize(entry.size, ctx.labels.sizeUnits, ctx.labels.decimalSeparator)));
      const read = entry.read;
      if (read && ctx.openEntry && ctx.options.openArchiveEntries !== false) {
        tr.className = 'fv-archive-open';
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
        const openEntry = () => {
          if (entry.size > ctx.limits.maxFileBytes) return ctx.setNotice(ctx.labels.tooLarge);
          wrap.classList.add('fv-archive-busy');
          // The pause lets the browser show that the click was accepted: unpacking a large file takes time.
          setTimeout(async () => {
            try {
              const bytes = await read();
              if (ctx.signal.aborted) return;
              // A copy: the source bytes belong to the archive, and the viewer may transfer the data to a worker.
              ctx.openEntry!(new Blob([bytes.slice() as BlobPart]), entry.name.replace(/\/+$/, '').split('/').pop() || entry.name);
            } catch {
              wrap.classList.remove('fv-archive-busy');
              ctx.setNotice(ctx.labels.archiveEntryFailed);
            }
          }, 20);
        };
        tr.addEventListener('click', openEntry);
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openEntry();
          }
        });
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    if (entries.length > MAX_ROWS) ctx.setNotice(ctx.labels.truncatedRows);
  }
  ctx.host.appendChild(wrap);
  return { destroy: () => wrap.remove() };
}
