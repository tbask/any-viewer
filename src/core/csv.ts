/**
 * CSV parser (RFC 4180 with leniency: any line breaks, delimiter auto-detection).
 *
 * The key idea is an index instead of a full parse: one pass remembers only
 * where rows start, and cells are parsed on demand for the visible window of the table.
 * Memory: the source string + 4 bytes per table row.
 */

const CANDIDATES = ['\t', ';', ',', '|'];

/**
 * Detects the delimiter from the first lines.
 * On a tie the earlier one in the list wins: tab, then ";" —
 * in many European csv files the comma is a decimal separator, not a field delimiter.
 */
export function detectDelimiter(text: string, maxLines = 30): string {
  const counts: number[][] = CANDIDATES.map(() => []);
  let inQuotes = false;
  let line = CANDIDATES.map(() => 0);
  let lineHasContent = false;
  let lines = 0;
  const n = Math.min(text.length, 256 * 1024);
  const flush = () => {
    if (lineHasContent) {
      line.forEach((c, k) => counts[k].push(c));
      lines++;
    }
    line = CANDIDATES.map(() => 0);
    lineHasContent = false;
  };
  for (let i = 0; i < n && lines < maxLines; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      lineHasContent = true;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      flush();
    } else {
      lineHasContent = true;
      if (!inQuotes) {
        const k = CANDIDATES.indexOf(ch);
        if (k >= 0) line[k]++;
      }
    }
  }
  if (lines < maxLines) flush();
  if (lines === 0) return ',';

  let best = ',';
  let bestScore = 0;
  CANDIDATES.forEach((cand, k) => {
    const freq = new Map<number, number>();
    for (const c of counts[k]) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0;
    let modeLines = 0;
    for (const [c, f] of freq) {
      if (c > 0 && (f > modeLines || (f === modeLines && c > mode))) {
        mode = c;
        modeLines = f;
      }
    }
    if (mode === 0) return;
    // What decides is the share of lines with the same delimiter count; the count itself is ignored,
    // otherwise in "1,5;2,5;3,5" the comma (3 per line) would beat the real delimiter ";" (2 per line).
    const score = modeLines / counts[k].length;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = cand;
    }
  });
  return best;
}

export interface CsvIndex {
  text: string;
  delimiter: string;
  /** Start position of every table row in the text. */
  rowStarts: Uint32Array;
  /** End positions (without line break characters). */
  rowEnds: Uint32Array;
  rowCount: number;
  /** Maximum column count over all rows. */
  columnCount: number;
}

/** Builds the row index in one pass. Line breaks inside quotes do not split a row. */
export function indexCsv(text: string, delimiter?: string, maxRows = Infinity): CsvIndex {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter ?? detectDelimiter(text);
  const delimCode = delim.charCodeAt(0);
  const n = text.length;
  let starts = new Uint32Array(1024);
  let ends = new Uint32Array(1024);
  let rows = 0;
  let maxCols = 0;
  let cols = 1;
  let inQuotes = false;
  let rowStart = 0;

  const push = (start: number, end: number) => {
    if (rows === starts.length) {
      const ns = new Uint32Array(rows * 2);
      ns.set(starts);
      starts = ns;
      const ne = new Uint32Array(rows * 2);
      ne.set(ends);
      ends = ne;
    }
    starts[rows] = start;
    ends[rows] = end;
    rows++;
    if (cols > maxCols) maxCols = cols;
    cols = 1;
  };

  let i = 0;
  for (; i < n && rows < maxRows; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (c === delimCode) {
        cols++;
      } else if (c === 10 /* \n */) {
        push(rowStart, i);
        rowStart = i + 1;
      } else if (c === 13 /* \r */) {
        push(rowStart, i);
        if (text.charCodeAt(i + 1) === 10) i++;
        rowStart = i + 1;
      }
    }
  }
  // Last row without a trailing line break.
  if (rows < maxRows && rowStart < n) push(rowStart, n);

  return {
    text,
    delimiter: delim,
    rowStarts: starts.subarray(0, rows),
    rowEnds: ends.subarray(0, rows),
    rowCount: rows,
    columnCount: rows === 0 ? 0 : maxCols,
  };
}

/** Parses one table row (the text fragment [start, end)) into cells. */
export function parseCsvRow(text: string, start: number, end: number, delimiter: string): string[] {
  const out: string[] = [];
  const delimCode = delimiter.charCodeAt(0);
  let i = start;
  for (;;) {
    if (i < end && text.charCodeAt(i) === 34) {
      // Quoted field: "" inside means one quote.
      let value = '';
      let j = i + 1;
      let segStart = j;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0 || q >= end) {
          value += text.slice(segStart, end);
          j = end;
          break;
        }
        if (text.charCodeAt(q + 1) === 34 && q + 1 < end) {
          value += text.slice(segStart, q + 1);
          j = q + 2;
          segStart = j;
        } else {
          value += text.slice(segStart, q);
          j = q + 1;
          break;
        }
      }
      // Whatever follows the closing quote up to the delimiter is appended as is.
      let k = j;
      while (k < end && text.charCodeAt(k) !== delimCode) k++;
      if (k > j) value += text.slice(j, k);
      out.push(value);
      i = k;
    } else {
      let k = i;
      while (k < end && text.charCodeAt(k) !== delimCode) k++;
      out.push(text.slice(i, k));
      i = k;
    }
    if (i >= end) break;
    i++; // skip the delimiter
    if (i >= end) {
      out.push(''); // the row ends with a delimiter: the last cell is empty
      break;
    }
  }
  return out;
}

/** Full parse: handy for small files and tests. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const idx = indexCsv(text, delimiter);
  const rows: string[][] = [];
  for (let r = 0; r < idx.rowCount; r++) rows.push(parseCsvRow(idx.text, idx.rowStarts[r], idx.rowEnds[r], idx.delimiter));
  return rows;
}
