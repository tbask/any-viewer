/** Reads the tar archive directory and unpacks gzip, for showing the file list. */

export interface ArchiveEntry {
  name: string;
  size: number;
  directory: boolean;
  /** File content; absent if it cannot be extracted (a directory, unsupported compression, encryption). */
  read?: () => Uint8Array | Promise<Uint8Array>;
}

const utf8 = new TextDecoder('utf-8');

function field(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end++;
  return utf8.decode(block.subarray(offset, end));
}

/** Lists tar entries. File data is not read, only the 512-byte headers. */
export function listTar(data: Uint8Array, maxEntries = 10_000): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  let longName = '';
  while (pos + 512 <= data.length && entries.length < maxEntries) {
    const block = data.subarray(pos, pos + 512);
    if (block.every((b) => b === 0)) break; // two zero blocks end the archive
    const size = parseInt(field(block, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(block[156] || 48);
    const prefix = field(block, 345, 155);
    let name = field(block, 0, 100);
    if (prefix && field(block, 257, 5) === 'ustar') name = `${prefix}/${name}`;
    const dataStart = pos + 512;
    if (type === 'L') {
      // GNU extension: the long name of the next entry lies in the data of this one.
      longName = field(data.subarray(dataStart, dataStart + size), 0, size);
    } else if (type === 'x') {
      // PAX extension: records of the form "length key=value"; only the path is needed.
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(utf8.decode(data.subarray(dataStart, dataStart + size)));
      if (m) longName = m[1];
    } else if (type !== 'g') {
      const directory = type === '5' || name.endsWith('/');
      const entry: ArchiveEntry = { name: longName || name, size: directory ? 0 : size, directory };
      if (!directory && (type === '0' || type === '7') && dataStart + size <= data.length) entry.read = () => data.subarray(dataStart, dataStart + size);
      entries.push(entry);
      longName = '';
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Unpacks gzip with browser facilities; maxSize guards against bombs. */
export async function gunzip(blob: Blob, maxSize: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('The browser does not support gzip decompression');
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxSize) {
      await reader.cancel();
      throw new Error('The unpacked data exceeds the size limit');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Name of the original file from the gzip header, if recorded there. */
export function gzipOriginalName(head: Uint8Array): string | undefined {
  if (head.length < 10 || head[0] !== 0x1f || head[1] !== 0x8b || !(head[3] & 0x08)) return undefined;
  let p = 10;
  if (head[3] & 0x04) p += 2 + (head[p] | (head[p + 1] << 8));
  let end = p;
  while (end < head.length && head[end] !== 0) end++;
  return end > p && end < head.length ? new TextDecoder('latin1').decode(head.subarray(p, end)) : undefined;
}
