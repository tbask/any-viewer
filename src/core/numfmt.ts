/**
 * Number and date formatting by spreadsheet format codes ("#,##0.00", "dd.mm.yyyy", "0%", …).
 * xlsx/xls files store a raw number and a format code; what the user sees is produced here.
 *
 * Common cases are covered: grouping and decimals, percent, exponent, the sections
 * "positive;negative;zero", currency symbols, dates and times, durations [h]:mm.
 * Also: fractions ("# ?/?", "# ?/8"), conditional sections ([>=1000]) and the month-name language from the format code ([$-419]).
 */

export interface NumFmtLocale {
  decimal: string;
  group: string;
  months: string[];
  monthsShort: string[];
  days: string[];
  daysShort: string[];
  trueText: string;
  falseText: string;
  /** Short date in the form customary for the locale (built-in format 14). */
  shortDate: string;
}

const EN: NumFmtLocale = {
  decimal: '.',
  group: ',',
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  trueText: 'TRUE',
  falseText: 'FALSE',
  shortDate: 'm/d/yyyy',
};

/** Collects locale parameters from Intl; on any error returns English ones. */
export function createLocale(lang?: string): NumFmtLocale {
  try {
    const tag = lang || (typeof navigator !== 'undefined' ? navigator.language : 'en');
    const parts = new Intl.NumberFormat(tag).formatToParts(1234567.5);
    const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
    const group = parts.find((p) => p.type === 'group')?.value ?? ',';
    const month = (style: 'long' | 'short') => {
      const f = new Intl.DateTimeFormat(tag, { month: style, timeZone: 'UTC' });
      return Array.from({ length: 12 }, (_, m) => f.format(new Date(Date.UTC(2021, m, 15))).replace(/\.$/, ''));
    };
    const day = (style: 'long' | 'short') => {
      const f = new Intl.DateTimeFormat(tag, { weekday: style, timeZone: 'UTC' });
      // 3 January 2021 is a Sunday.
      return Array.from({ length: 7 }, (_, d) => f.format(new Date(Date.UTC(2021, 0, 3 + d))));
    };
    // The order of short-date parts comes from the locale; the parts themselves are always numeric.
    const dateParts = new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2021, 10, 25)));
    const shortDate = dateParts
      .map((p) => (p.type === 'year' ? 'yyyy' : p.type === 'month' ? 'mm' : p.type === 'day' ? 'dd' : p.type === 'literal' ? `"${p.value}"` : ''))
      .join('');
    const ru = /^(ru|kk|be|uk)\b/i.test(tag);
    return {
      decimal,
      group,
      months: month('long'),
      monthsShort: month('short'),
      days: day('long'),
      daysShort: day('short'),
      trueText: ru ? 'ИСТИНА' : 'TRUE',
      falseText: ru ? 'ЛОЖЬ' : 'FALSE',
      shortDate: shortDate || EN.shortDate,
    };
  } catch {
    return EN;
  }
}

const BUILTIN: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '#,##0;-#,##0', 6: '#,##0;-#,##0', 7: '#,##0.00;-#,##0.00', 8: '#,##0.00;-#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: '\u0001', // short date of the locale
  15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: '\u0001 h:mm',
  37: '#,##0_);(#,##0)', 38: '#,##0_);(#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);(#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};

export function builtinFormat(id: number): string | undefined {
  return BUILTIN[id];
}

type Token =
  | { t: 'lit'; v: string }
  | { t: 'num'; v: string }
  | { t: 'date'; c: string; n: number }
  | { t: 'elapsed'; c: string; n: number }
  | { t: 'ampm'; v: string }
  | { t: 'exp'; digits: number; plus: boolean }
  | { t: 'pct' }
  | { t: 'text' }
  | { t: 'general' };

interface Section {
  tokens: Token[];
  isDate: boolean;
  hasNum: boolean;
  isGeneral: boolean;
  isFraction: boolean;
  /** Section condition: [>=1000]. */
  cond?: { op: string; value: number };
  /** Language of month and day names given in the format code: [$-419] is Russian. */
  lcid?: number;
}

interface Compiled {
  sections: Section[];
  isDate: boolean;
}

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      cur += ch;
      if (ch === '"') quote = false;
    } else if (bracket) {
      cur += ch;
      if (ch === ']') bracket = false;
    } else if (ch === '"') {
      quote = true;
      cur += ch;
    } else if (ch === '[') {
      bracket = true;
      cur += ch;
    } else if (ch === '\\' && i + 1 < code.length) {
      cur += ch + code[++i];
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function tokenize(src: string): Section {
  const tokens: Token[] = [];
  const lit = (v: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.t === 'lit') last.v += v;
    else tokens.push({ t: 'lit', v });
  };
  let i = 0;
  const n = src.length;
  let isFraction = false;
  let cond: Section['cond'];
  let lcid: number | undefined;
  while (i < n) {
    const ch = src[i];
    const lower = ch.toLowerCase();
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      lit(src.slice(i + 1, end < 0 ? n : end));
      i = end < 0 ? n : end + 1;
    } else if (ch === '\\') {
      lit(src[i + 1] ?? '');
      i += 2;
    } else if (ch === '_') {
      lit(' ');
      i += 2;
    } else if (ch === '*') {
      i += 2;
    } else if (ch === '[') {
      const end = src.indexOf(']', i);
      const body = src.slice(i + 1, end < 0 ? n : end);
      const m = /^(h+|m+|s+)$/i.exec(body);
      if (m) tokens.push({ t: 'elapsed', c: body[0].toLowerCase(), n: body.length });
      else if (body[0] === '$') {
        const dash = body.indexOf('-');
        lit(body.slice(1, dash < 0 ? undefined : dash));
        if (dash >= 0) {
          const id = parseInt(body.slice(dash + 1), 16) & 0xffff;
          if (id) lcid = id;
        }
      } else {
        const c = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(body);
        if (c) cond = { op: c[1], value: Number(c[2]) };
      }
      i = end < 0 ? n : end + 1;
    } else if (/^general/i.test(src.slice(i, i + 7))) {
      tokens.push({ t: 'general' });
      i += 7;
    } else if (/^am\/pm/i.test(src.slice(i, i + 5))) {
      tokens.push({ t: 'ampm', v: src.slice(i, i + 5) });
      i += 5;
    } else if (/^a\/p/i.test(src.slice(i, i + 3))) {
      tokens.push({ t: 'ampm', v: src.slice(i, i + 3) });
      i += 3;
    } else if (lower === 'y' || lower === 'm' || lower === 'd' || lower === 'h' || lower === 's') {
      let j = i;
      while (j < n && src[j].toLowerCase() === lower) j++;
      tokens.push({ t: 'date', c: lower, n: j - i });
      i = j;
    } else if (ch === '0' || ch === '#' || ch === '?' || ch === '.' || ch === ',') {
      let j = i;
      while (j < n && '0#?.,'.includes(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j) });
      i = j;
    } else if ((ch === 'E' || ch === 'e') && (src[i + 1] === '+' || src[i + 1] === '-')) {
      let j = i + 2;
      while (j < n && (src[j] === '0' || src[j] === '#' || src[j] === '?')) j++;
      tokens.push({ t: 'exp', digits: j - i - 2, plus: src[i + 1] === '+' });
      i = j;
    } else if (ch === '%') {
      tokens.push({ t: 'pct' });
      i++;
    } else if (ch === '@') {
      tokens.push({ t: 'text' });
      i++;
    } else {
      if (ch === '/' && tokens.length && tokens[tokens.length - 1].t === 'num') isFraction = true;
      lit(ch);
      i++;
    }
  }
  const hasNum = tokens.some((t) => t.t === 'num');
  const isDate = tokens.some((t) => t.t === 'date' || t.t === 'elapsed' || t.t === 'ampm');
  return { tokens, isDate, hasNum, isGeneral: tokens.some((t) => t.t === 'general'), isFraction: isFraction && !isDate, cond, lcid };
}

const cache = new Map<string, Compiled>();

function compile(code: string): Compiled {
  let c = cache.get(code);
  if (!c) {
    const sections = splitSections(code).map(tokenize);
    c = { sections, isDate: sections[0].isDate };
    if (cache.size > 2000) cache.clear();
    cache.set(code, c);
  }
  return c;
}

/** Whether the format is a date or time format. */
export function isDateFormat(code: string): boolean {
  if (!code || code === 'General' || code === '@') return false;
  if (code.includes('\u0001')) return true; // built-in short date of the locale
  return compile(code).isDate;
}

/** General format: up to 11 significant digits, as Excel shows. */
export function formatGeneral(value: number, locale: NumFmtLocale): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  let s = String(parseFloat(value.toPrecision(11)));
  if (s.includes('e')) {
    const [mant, exp] = s.split('e');
    const e = Number(exp);
    s = `${mant}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  return locale.decimal === '.' ? s : s.replace('.', locale.decimal);
}

function groupDigits(int: string, sep: string): string {
  if (int.length <= 3) return int;
  let out = '';
  const first = int.length % 3;
  if (first) out = int.slice(0, first);
  for (let i = first; i < int.length; i += 3) out += (out ? sep : '') + int.slice(i, i + 3);
  return out;
}

/**
 * Rounding "as spreadsheets do": 1.005 → 1.01. A plain toFixed would give 1.00,
 * because 1.005 in binary is slightly less than its decimal representation.
 */
function roundFixed(abs: number, decimals: number): string {
  if (abs >= 1e15 || !Number.isFinite(abs)) return abs < 1e21 ? abs.toFixed(decimals) : String(abs);
  const shifted = Number(`${abs.toPrecision(15)}e${decimals}`);
  if (!Number.isFinite(shifted)) return abs.toFixed(decimals);
  return Number(`${Math.round(shifted)}e-${decimals}`).toFixed(decimals);
}

function formatNumberPattern(value: number, pattern: string, locale: NumFmtLocale): string {
  // Commas at the very end of the pattern are a scale (division by 1000 for each).
  let scaled = value;
  let p = pattern;
  while (p.endsWith(',')) {
    scaled /= 1000;
    p = p.slice(0, -1);
  }
  const dot = p.indexOf('.');
  const intPat = dot < 0 ? p : p.slice(0, dot);
  const fracPat = dot < 0 ? '' : p.slice(dot + 1).replace(/[.,]/g, '');
  const grouping = intPat.includes(',');
  const minInt = (intPat.match(/0/g) || []).length;
  const maxDec = fracPat.length;
  const minDec = (fracPat.match(/0/g) || []).length;

  let fixed = roundFixed(Math.abs(scaled), Math.min(maxDec, 20));
  let [int, frac = ''] = fixed.split('.');
  while (frac.length > minDec && frac.endsWith('0')) frac = frac.slice(0, -1);
  if (int.length < minInt) int = int.padStart(minInt, '0');
  if (minInt === 0 && int === '0' && (frac.length > 0 || intPat.replace(/,/g, '').length === 0)) int = '';
  if (grouping) int = groupDigits(int, locale.group);
  // "?" is a digit placeholder: without a digit a space remains (this aligns the dash in the accounting format).
  if ((int === '' || /^0+$/.test(int)) && frac === '' && dot < 0 && /^[?,]+$/.test(intPat)) return ' '.repeat(intPat.replace(/,/g, '').length);
  if (int === '' && frac === '') int = '0';
  fixed = frac.length ? `${int}${locale.decimal}${frac}` : int;
  return fixed;
}

function formatExponent(value: number, mantPattern: string, exp: { digits: number; plus: boolean }, locale: NumFmtLocale): string {
  const dot = mantPattern.indexOf('.');
  const decimals = dot < 0 ? 0 : mantPattern.length - dot - 1;
  const [mant, e] = Math.abs(value).toExponential(decimals).split('e');
  const en = Number(e);
  const sign = en < 0 ? '-' : exp.plus ? '+' : '';
  return `${locale.decimal === '.' ? mant : mant.replace('.', locale.decimal)}E${sign}${String(Math.abs(en)).padStart(Math.max(1, exp.digits), '0')}`;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Languages from Excel format codes (low word of the LCID) → BCP 47 tags. */
const LCID: Record<number, string> = {
  0x409: 'en-US', 0x809: 'en-GB', 0x419: 'ru-RU', 0x43f: 'kk-KZ', 0x422: 'uk-UA', 0x423: 'be-BY', 0x407: 'de-DE', 0x40c: 'fr-FR',
  0x410: 'it-IT', 0x40a: 'es-ES', 0xc0a: 'es-ES', 0x416: 'pt-BR', 0x816: 'pt-PT', 0x415: 'pl-PL', 0x41f: 'tr-TR', 0x443: 'uz-UZ',
  0x440: 'ky-KG', 0x42c: 'az-AZ', 0x804: 'zh-CN', 0x411: 'ja-JP', 0x412: 'ko-KR', 0x405: 'cs-CZ', 0x413: 'nl-NL',
};
const lcidLocales = new Map<number, NumFmtLocale | null>();
/** Month and day names in the language given in the format code; Excel capitalises them. */
function localeForLcid(lcid: number | undefined, fallback: NumFmtLocale): NumFmtLocale {
  if (!lcid || !LCID[lcid]) return fallback;
  let found = lcidLocales.get(lcid);
  if (found === undefined) {
    const made = createLocale(LCID[lcid]);
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    found = made === EN && lcid !== 0x409 && lcid !== 0x809 ? null : { ...made, months: made.months.map(cap), monthsShort: made.monthsShort.map(cap), days: made.days.map(cap), daysShort: made.daysShort.map(cap) };
    lcidLocales.set(lcid, found);
  }
  return found ? { ...fallback, months: found.months, monthsShort: found.monthsShort, days: found.days, daysShort: found.daysShort } : fallback;
}

/** Fraction: "# ?/?" → "1 3/4". The denominator is fitted within the digit count of the pattern or given as a number. */
function formatFraction(value: number, section: Section): string | undefined {
  const { tokens } = section;
  const slash = tokens.findIndex((t) => t.t === 'lit' && t.v.startsWith('/'));
  if (slash < 1) return undefined;
  const numIdx = slash - 1;
  const slashTok = tokens[slash] as { t: 'lit'; v: string };
  const fixed = /^\/(\d+)/.exec(slashTok.v);
  const denTok = tokens[slash + 1];
  if (tokens[numIdx].t !== 'num' || (!fixed && denTok?.t !== 'num')) return undefined;
  const intIdx = tokens.findIndex((t, k) => t.t === 'num' && k < numIdx);
  const abs = Math.abs(value);
  let whole = intIdx >= 0 ? Math.floor(abs) : 0;
  const frac = abs - whole;
  let num = 0;
  let den = 1;
  if (fixed) {
    den = Number(fixed[1]) || 1;
    num = Math.round(frac * den);
  } else {
    const maxDen = Math.min(10 ** (denTok as { v: string }).v.length - 1, 9999);
    let best = Infinity;
    for (let d = 1; d <= maxDen; d++) {
      const nn = Math.round(frac * d);
      const err = Math.abs(frac - nn / d);
      if (err < best - 1e-12) {
        best = err;
        num = nn;
        den = d;
        if (err < 1e-12) break;
      }
    }
  }
  if (intIdx >= 0 && num === den) {
    whole += 1;
    num = 0;
  }
  let out = '';
  tokens.forEach((t, k) => {
    if (k === intIdx) out += whole === 0 && num !== 0 && !(t as { v: string }).v.includes('0') ? '' : String(whole);
    else if (num === 0 && intIdx >= 0 && k >= numIdx && k <= slash + (fixed ? 0 : 1)) return;
    else if (k === numIdx) out += String(num);
    else if (k === slash) out += fixed ? slashTok.v : '/';
    else if (k === slash + 1 && !fixed) out += String(den);
    else if (t.t === 'lit') out += t.v;
    else if (t.t === 'pct') out += '%';
  });
  out = out.replace(/\s+/g, ' ').trim();
  return value < 0 && /[1-9]/.test(out) ? `-${out}` : out;
}

function formatDate(serial: number, section: Section, baseLocale: NumFmtLocale, date1904: boolean): string {
  const locale = localeForLcid(section.lcid, baseLocale);
  let days = Math.floor(serial);
  // Fractions of a second: "ss.0", "ss.000". Single dots and commas in dates ("dd.mm.yyyy") are just separators.
  const hasFraction = section.tokens.some((t) => t.t === 'num' && /^\.[0#?]+$/.test(t.v));
  let seconds = (serial - days) * 86400;
  let ms = 0;
  if (hasFraction) {
    ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    seconds = Math.floor(seconds);
  } else {
    seconds = Math.round(seconds);
  }
  if (seconds >= 86400) {
    seconds -= 86400;
    days += 1;
  }
  // In the 1900 system Excel treats 1900 as a leap year; before 1 March 1900 the serial number is off by a day.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const adjust = !date1904 && serial < 60 && serial >= 1 ? 1 : 0;
  const d = new Date(epoch + (days + adjust) * 86400000);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const W = d.getUTCDay();
  const hh = Math.floor(seconds / 3600);
  const mi = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  const ampm = section.tokens.some((t) => t.t === 'ampm');
  const { tokens } = section;

  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'lit') {
      out += t.v;
    } else if (t.t === 'num') {
      if (/^\.[0#?]+$/.test(t.v)) out += locale.decimal + String(ms).padStart(3, '0').slice(0, t.v.length - 1);
      else out += t.v.replace(/[0#?]/g, '');
    } else if (t.t === 'elapsed') {
      const total = serial * 86400;
      const v = t.c === 'h' ? Math.floor(total / 3600 + 1e-9) : t.c === 'm' ? Math.floor(total / 60 + 1e-9) : Math.round(total);
      out += String(v).padStart(t.n, '0');
    } else if (t.t === 'ampm') {
      const pm = hh >= 12;
      out += t.v.length === 3 ? (pm ? 'P' : 'A') : pm ? 'PM' : 'AM';
    } else if (t.t === 'date') {
      if (t.c === 'y') {
        out += t.n <= 2 ? pad2(Y % 100) : String(Y);
      } else if (t.c === 'd') {
        out += t.n === 1 ? String(D) : t.n === 2 ? pad2(D) : t.n === 3 ? locale.daysShort[W] : locale.days[W];
      } else if (t.c === 'h') {
        const h = ampm ? hh % 12 || 12 : hh;
        out += t.n === 1 ? String(h) : pad2(h);
      } else if (t.c === 's') {
        out += t.n === 1 ? String(ss) : pad2(ss);
      } else {
        // "m" is minutes if hours are nearby (left) or seconds (right); otherwise it is the month.
        let prev: Token | undefined;
        for (let k = i - 1; k >= 0; k--) {
          if (tokens[k].t === 'date' || tokens[k].t === 'elapsed') {
            prev = tokens[k];
            break;
          }
        }
        let next: Token | undefined;
        for (let k = i + 1; k < tokens.length; k++) {
          if (tokens[k].t === 'date' || tokens[k].t === 'elapsed') {
            next = tokens[k];
            break;
          }
        }
        const isMinute = (prev && (prev.t === 'date' || prev.t === 'elapsed') && prev.c === 'h') || (next && next.t === 'date' && next.c === 's');
        if (isMinute) out += t.n === 1 ? String(mi) : pad2(mi);
        else if (t.n === 1) out += String(M + 1);
        else if (t.n === 2) out += pad2(M + 1);
        else if (t.n === 3) out += locale.monthsShort[M];
        else if (t.n === 4) out += locale.months[M];
        else out += locale.months[M][0];
      }
    }
  }
  return out;
}

/**
 * Formats a number by a format code.
 * @param date1904 the workbook uses the 1904 date system (old Mac files)
 */
export function formatValue(value: number, code: string | undefined, locale: NumFmtLocale, date1904 = false): string {
  if (!code || code === 'General' || code === '@') return formatGeneral(value, locale);
  if (code.includes('\u0001')) code = code.replace('\u0001', locale.shortDate);
  const { sections } = compile(code);

  // Section choice: "positive; negative; zero; text".
  let section = sections[0];
  let useAbs = false;
  if (sections.some((s) => s.cond)) {
    // Sections with conditions are checked in order; a section without a condition always fits. The fourth is for text.
    const test = (c: NonNullable<Section['cond']>) =>
      c.op === '<' ? value < c.value : c.op === '<=' ? value <= c.value : c.op === '>' ? value > c.value : c.op === '>=' ? value >= c.value : c.op === '=' ? value === c.value : value !== c.value;
    section = sections.slice(0, 3).find((s) => !s.cond || test(s.cond)) ?? sections[0];
    // A negative number that lands in the second section is output without a sign, as in Excel.
    useAbs = value < 0 && section === sections[1];
  } else if (sections.length >= 2 && value < 0) {
    section = sections[1];
    useAbs = true;
  } else if (sections.length >= 3 && value === 0) {
    section = sections[2];
  }
  if (section.tokens.length === 0) return '';

  if (section.isDate) {
    if (value < 0) return formatGeneral(value, locale);
    return formatDate(value, section, locale, date1904);
  }
  if (section.isFraction) {
    const fraction = formatFraction(useAbs ? Math.abs(value) : value, section);
    if (fraction !== undefined) return fraction;
  }
  if (section.isGeneral || section.isFraction) {
    let out = '';
    for (const t of section.tokens) {
      if (t.t === 'lit') out += t.v;
      else if (t.t === 'general') out += formatGeneral(useAbs ? Math.abs(value) : value, locale);
    }
    return section.isFraction ? formatGeneral(value, locale) : out;
  }
  if (!section.hasNum) {
    // A section without digit placeholders: only the text is output.
    return section.tokens.map((t) => (t.t === 'lit' ? t.v : t.t === 'pct' ? '%' : '')).join('');
  }

  let v = value;
  if (section.tokens.some((t) => t.t === 'pct')) v *= 100;
  const negative = v < 0 && !useAbs;
  const expIdx = section.tokens.findIndex((t) => t.t === 'exp');
  const numTokens = section.tokens.filter((t) => t.t === 'num') as { t: 'num'; v: string }[];

  let out = '';
  if (expIdx >= 0) {
    const exp = section.tokens[expIdx] as { t: 'exp'; digits: number; plus: boolean };
    let done = false;
    for (const t of section.tokens) {
      if (t.t === 'lit') out += t.v;
      else if (t.t === 'pct') out += '%';
      else if (t.t === 'num' && !done) {
        out += formatExponent(v, t.v, exp, locale);
        done = true;
      }
    }
  } else if (numTokens.length > 1 && !numTokens.some((t) => t.v.includes('.'))) {
    // Patterns like 000-00-00: digits are distributed over the groups right to left.
    const total = numTokens.reduce((s, t) => s + t.v.replace(/,/g, '').length, 0);
    let digits = String(Math.round(Math.abs(v))).padStart(total, '0');
    const parts: string[] = [];
    for (let k = numTokens.length - 1; k >= 0; k--) {
      const len = numTokens[k].v.replace(/,/g, '').length;
      parts[k] = k === 0 ? digits : digits.slice(-len);
      digits = digits.slice(0, -len);
    }
    let k = 0;
    for (const t of section.tokens) {
      if (t.t === 'lit') out += t.v;
      else if (t.t === 'pct') out += '%';
      else if (t.t === 'num') out += parts[k++];
    }
  } else {
    let done = false;
    for (const t of section.tokens) {
      if (t.t === 'lit') out += t.v;
      else if (t.t === 'pct') out += '%';
      else if (t.t === 'num' && !done) {
        out += formatNumberPattern(v, t.v, locale);
        done = true;
      }
    }
  }
  // No minus is put before a zero produced by rounding ("-0.00").
  if (negative && /[1-9]/.test(out)) out = `-${out}`;
  return out;
}
