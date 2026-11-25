/**
 * Mail and calendars: eml (RFC 5322 + MIME), mbox (several messages in a row), ics (iCalendar), msg (Outlook).
 * Message headers, the body and the list of attachments are shown; attachments are neither opened nor extracted.
 * HTML mail is shown as text without markup: message content is never executed.
 */
import { CfbReader } from '../core/cfb';
import type { Block, DocModel, Inline, TableRow } from '../core/docmodel';
import { isValidUtf8 } from '../core/encoding';
import type { DocOptions } from './documents';

interface Mail {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  body: string;
  attachments: string[];
}

const DEFAULT_LABELS = { from: 'From', to: 'To', cc: 'Cc', subject: 'Subject', date: 'Date', attachments: 'Attachments', location: 'Location' };
type MailLabels = typeof DEFAULT_LABELS;
const labelsOf = (options: DocOptions): MailLabels => ({ ...DEFAULT_LABELS, ...(options.labels as Partial<MailLabels> | undefined) });

/**
 * Bytes → a "one byte, one character" string. TextDecoder('latin1') does not fit:
 * by the standard it works as windows-1252 and changes bytes 0x80–0x9F into other characters.
 */
const latin1 = {
  decode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return out;
  },
};
const toBytes = (binary: string): Uint8Array => Uint8Array.from(binary, (c) => c.charCodeAt(0) & 0xff);

function decodeBytes(bytes: Uint8Array, charset: string | undefined, fallback: string): string {
  const name = charset || (isValidUtf8(bytes) ? 'utf-8' : fallback);
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    return new TextDecoder(isValidUtf8(bytes) ? 'utf-8' : fallback).decode(bytes);
  }
}

function decodeQuotedPrintable(text: string, header = false): string {
  let s = text.replace(/=\r?\n/g, '');
  if (header) s = s.replace(/_/g, ' ');
  return s.replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBase64(text: string): string {
  try {
    return atob(text.replace(/[^A-Za-z0-9+/=]/g, ''));
  } catch {
    return '';
  }
}

/** Message header: raw 8-bit characters plus encoded words of the form =?utf-8?B?...?= */
function decodeHeader(raw: string | undefined, fallback: string): string | undefined {
  if (raw === undefined) return undefined;
  const base = decodeBytes(toBytes(raw), undefined, fallback);
  return base
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, data: string) =>
      decodeBytes(toBytes(enc.toLowerCase() === 'b' ? decodeBase64(data) : decodeQuotedPrintable(data, true)), charset, fallback),
    )
    .trim();
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

const param = (value: string | undefined, name: string): string | undefined => {
  const m = value ? new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value) : null;
  return m ? m[1] ?? m[2] : undefined;
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parses a part of a MIME message; finds the text and attachment names. */
function parsePart(binary: string, fallback: string, out: { plain?: string; html?: string; attachments: string[] }, depth = 0): void {
  const split = /\r?\n\r?\n/.exec(binary);
  const headers = parseHeaders(split ? binary.slice(0, split.index) : binary);
  const body = split ? binary.slice(split.index + split[0].length) : '';
  const type = headers.get('content-type') ?? 'text/plain';
  const boundary = param(type, 'boundary');
  if (/^multipart\//i.test(type) && boundary && depth < 10) {
    const parts = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const part of parts.slice(1)) if (part.trim()) parsePart(part, fallback, out, depth + 1);
    return;
  }
  const disposition = headers.get('content-disposition') ?? '';
  const fileName = param(disposition, 'filename') ?? param(type, 'name');
  if (/attachment/i.test(disposition) || (fileName && !/^text\//i.test(type))) {
    out.attachments.push(decodeHeader(fileName ?? '(unnamed)', fallback)!);
    return;
  }
  if (!/^text\//i.test(type)) return;
  const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  const decoded = encoding === 'base64' ? decodeBase64(body) : encoding === 'quoted-printable' ? decodeQuotedPrintable(body) : body;
  const text = decodeBytes(toBytes(decoded), param(type, 'charset'), fallback);
  if (/^text\/html/i.test(type)) out.html ??= text;
  else out.plain ??= text;
}

function parseMessage(binary: string, fallback: string): Mail {
  const split = /\r?\n\r?\n/.exec(binary);
  const headers = parseHeaders(split ? binary.slice(0, split.index) : binary);
  const content: { plain?: string; html?: string; attachments: string[] } = { attachments: [] };
  parsePart(binary, fallback, content);
  const h = (name: string) => decodeHeader(headers.get(name), fallback);
  return {
    from: h('from'),
    to: h('to'),
    cc: h('cc'),
    subject: h('subject'),
    date: h('date'),
    body: (content.plain ?? (content.html !== undefined ? htmlToText(content.html) : '')).replace(/\r\n?/g, '\n').trim(),
    attachments: content.attachments,
  };
}

const text = (t: string, bold = false): Inline => (bold ? { k: 'text', text: t, s: { b: 1 } } : { k: 'text', text: t });

function fieldTable(rows: [string, string | undefined][]): Block | undefined {
  const present = rows.filter((r): r is [string, string] => !!r[1]);
  if (!present.length) return undefined;
  const tableRows: TableRow[] = present.map(([label, value]) => ({
    cells: [{ blocks: [{ k: 'p', runs: [text(label, true)] }], bg: '#f6f7f9' }, { blocks: [{ k: 'p', runs: [text(value)] }] }],
  }));
  return { k: 'table', rows: tableRows, widths: [1, 4] };
}

function bodyBlocks(body: string): Block[] {
  return body.split('\n').map((line): Block => ({ k: 'p', runs: line ? [text(line)] : [] }));
}

function mailBlocks(mail: Mail, labels: MailLabels): Block[] {
  const blocks: Block[] = [];
  if (mail.subject) blocks.push({ k: 'p', runs: [text(mail.subject, true)], s: { heading: 2 } });
  const table = fieldTable([[labels.from, mail.from], [labels.to, mail.to], [labels.cc, mail.cc], [labels.date, mail.date], [labels.attachments, mail.attachments.join(', ') || undefined]]);
  if (table) blocks.push(table);
  blocks.push({ k: 'p', runs: [] }, ...bodyBlocks(mail.body));
  return blocks;
}

export function parseEml(bytes: Uint8Array, options: DocOptions = {}): DocModel {
  const mail = parseMessage(latin1.decode(bytes), options.fallbackEncoding ?? 'windows-1251');
  return { blocks: mailBlocks(mail, labelsOf(options)), images: {} };
}

export function parseMbox(bytes: Uint8Array, options: DocOptions = {}): DocModel {
  const binary = latin1.decode(bytes);
  // Messages are separated by a "From address date" line at the start of a line.
  const starts: number[] = [];
  const re = /^From .*\r?\n/gm;
  for (let m = re.exec(binary); m; m = re.exec(binary)) starts.push(m.index + m[0].length);
  if (!starts.length) starts.push(0);
  const blocks: Block[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? binary.lastIndexOf('\nFrom ', starts[i + 1]) : binary.length;
    const message = binary.slice(start, end < start ? binary.length : end).replace(/^>(>*From )/gm, '$1');
    if (i > 0) blocks.push({ k: 'pagebreak' });
    blocks.push(...mailBlocks(parseMessage(message, options.fallbackEncoding ?? 'windows-1251'), labelsOf(options)));
  });
  return { blocks, images: {} };
}

/** iCalendar date (20261123T100000Z) → "23.11.2026 10:00 UTC". */
export function formatIcsDate(value: string, tzid?: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return value;
  let out = `${m[3]}.${m[2]}.${m[1]}`;
  if (m[4]) out += ` ${m[4]}:${m[5]}${m[7] ? ' UTC' : tzid ? ` (${tzid})` : ''}`;
  return out;
}

export function parseIcs(bytes: Uint8Array, options: DocOptions = {}): DocModel {
  const labels = labelsOf(options);
  const source = decodeBytes(bytes, undefined, options.fallbackEncoding ?? 'windows-1251').replace(/\r?\n[ \t]/g, '');
  const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  const blocks: Block[] = [];
  let event: Map<string, { value: string; params: string }> | null = null;
  for (const line of source.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    const key = name.toUpperCase();
    const value = line.slice(colon + 1);
    if (key === 'BEGIN' && /^(VEVENT|VTODO)$/i.test(value)) {
      event = new Map();
    } else if (key === 'END' && event && /^(VEVENT|VTODO)$/i.test(value)) {
      const get = (k: string) => event!.get(k);
      const date = (k: string) => {
        const p = get(k);
        return p ? formatIcsDate(p.value, /TZID=([^;]+)/i.exec(p.params)?.[1]) : undefined;
      };
      const start = date('DTSTART');
      const end = date('DTEND') ?? date('DUE');
      if (blocks.length) blocks.push({ k: 'p', runs: [] });
      blocks.push({ k: 'p', runs: [text(unescape(get('SUMMARY')?.value ?? '—'), true)], s: { heading: 2 } });
      const organizer = get('ORGANIZER');
      const table = fieldTable([
        [labels.date, start && end && end !== start ? `${start} — ${end}` : start],
        [labels.location, get('LOCATION') && unescape(get('LOCATION')!.value)],
        [labels.from, organizer && (/CN=([^;:]+)/i.exec(organizer.params)?.[1] ?? organizer.value.replace(/^mailto:/i, ''))],
      ]);
      if (table) blocks.push(table);
      const description = get('DESCRIPTION');
      if (description) blocks.push({ k: 'p', runs: [] }, ...bodyBlocks(unescape(description.value)));
      event = null;
    } else if (event && !event.has(key)) {
      event.set(key, { value, params: params.join(';') });
    }
  }
  if (!blocks.length) throw new Error('The calendar file has no events');
  return { blocks, images: {} };
}

export async function parseMsg(blob: Blob, options: DocOptions = {}): Promise<DocModel> {
  const cfb = await CfbReader.open(blob);
  const fallback = options.fallbackEncoding ?? 'windows-1251';
  // Message properties lie in "__substg1.0_<property code><type>" streams: 001F is Unicode, 001E a code page.
  const read = (entry: { name: string } | undefined): string | undefined => {
    if (!entry) return undefined;
    const data = cfb.read(entry as never);
    return (entry.name.toUpperCase().endsWith('001F') ? new TextDecoder('utf-16le').decode(data) : decodeBytes(data, undefined, fallback)).replace(/\0+$/, '');
  };
  const prop = (id: string) => read(cfb.find(`__substg1.0_${id}001F`, `__substg1.0_${id}001E`));
  const subject = prop('0037');
  const body = prop('1000');
  if (subject === undefined && body === undefined) throw new Error('The file has no Outlook message');
  const sender = [prop('0C1A'), prop('5D01') ?? prop('0C1F')].filter(Boolean);
  const attachments = cfb.entries.filter((e) => /^__substg1\.0_3707001[EF]$/i.test(e.name)).map((e) => read(e) ?? '');
  const mail: Mail = {
    from: sender.length > 1 ? `${sender[0]} <${sender[1]}>` : sender[0],
    to: prop('0E04'),
    cc: prop('0E03'),
    subject,
    body: (body ?? '').replace(/\r\n?/g, '\n').trim(),
    attachments: attachments.filter(Boolean),
  };
  return { blocks: mailBlocks(mail, labelsOf(options)), images: {} };
}
