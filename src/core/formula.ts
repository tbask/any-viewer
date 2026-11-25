/**
 * A small Excel formula evaluator, for formula-based conditional formatting.
 * Supported: numbers, strings, references to cells and ranges of the same sheet, arithmetic, comparisons,
 * string concatenation and common functions. A formula that cannot be parsed counts as not satisfied.
 */
export type FormulaValue = number | string | boolean | null;

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; row: number; col: number; absRow: boolean; absCol: boolean }
  | { t: 'range'; a: Extract<Node, { t: 'ref' }>; b: Extract<Node, { t: 'ref' }> }
  | { t: 'un'; op: string; x: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'call'; name: string; args: Node[] };

export interface FormulaContext {
  /** Value of a sheet cell (zero-based row and column); null for an empty one. */
  cell(row: number, col: number): FormulaValue;
  /** Shift of relative references: the formula is written for the top-left cell of the rule range. */
  dRow: number;
  dCol: number;
  /** The cell the formula is evaluated for. */
  row: number;
  col: number;
}

class FormulaError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  const re = /\s*("(?:[^"]|"")*"|\$?[A-Za-z]{1,3}\$?\d+(?![\w.(])|[A-Za-z_][\w.]*|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|<>|<=|>=|[-+*/^&=<>(),;:%!'])/y;
  let pos = 0;
  while (pos < source.length) {
    re.lastIndex = pos;
    const m = re.exec(source);
    if (!m) {
      if (!source.slice(pos).trim()) break;
      throw new FormulaError('token');
    }
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

/** Parses formula text (with or without the leading "="). null: the formula is beyond the evaluator. */
export function parseFormula(source: string): Node | null {
  try {
    const tokens = tokenize(source.replace(/^\s*=/, ''));
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    const cellRef = (text: string): Extract<Node, { t: 'ref' }> | undefined => {
      const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
      if (!m) return undefined;
      const col = [...m[2].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      return { t: 'ref', row: Number(m[4]) - 1, col, absRow: m[3] === '$', absCol: m[1] === '$' };
    };
    const primary = (): Node => {
      const tok = next();
      if (tok === undefined) throw new FormulaError('end');
      if (tok === '(') {
        const inner = compare();
        if (next() !== ')') throw new FormulaError(')');
        return inner;
      }
      if (tok[0] === '"') return { t: 'str', v: tok.slice(1, -1).replace(/""/g, '"') };
      if (/^[\d.]/.test(tok)) return { t: 'num', v: Number(tok) };
      const ref = cellRef(tok);
      if (ref) {
        if (peek() === ':') {
          next();
          const second = cellRef(next() ?? '');
          if (!second) throw new FormulaError('range');
          return { t: 'range', a: ref, b: second };
        }
        return ref;
      }
      if (/^[A-Za-z_]/.test(tok)) {
        const name = tok.toUpperCase();
        if (peek() === '(') {
          next();
          const args: Node[] = [];
          if (peek() === ')') next();
          else {
            for (;;) {
              args.push(compare());
              const sep = next();
              if (sep === ')') break;
              if (sep !== ',' && sep !== ';') throw new FormulaError('args');
            }
          }
          return { t: 'call', name, args };
        }
        if (name === 'TRUE' || name === 'ИСТИНА') return { t: 'bool', v: true };
        if (name === 'FALSE' || name === 'ЛОЖЬ') return { t: 'bool', v: false };
      }
      // References to other sheets, range names and the like cannot be evaluated.
      throw new FormulaError('unsupported');
    };
    const postfix = (): Node => {
      let x = primary();
      while (peek() === '%') {
        next();
        x = { t: 'bin', op: '/', l: x, r: { t: 'num', v: 100 } };
      }
      return x;
    };
    const unary = (): Node => (peek() === '-' || peek() === '+' ? { t: 'un', op: next()!, x: unary() } : postfix());
    const level = (ops: string[], lower: () => Node) => (): Node => {
      let l = lower();
      while (ops.includes(peek())) l = { t: 'bin', op: next()!, l, r: lower() };
      return l;
    };
    const power = level(['^'], unary);
    const product = level(['*', '/'], power);
    const sum = level(['+', '-'], product);
    const concat = level(['&'], sum);
    const compare = level(['=', '<>', '<', '>', '<=', '>='], concat);
    const tree = compare();
    return i === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

const toNumber = (v: FormulaValue | FormulaValue[]): number => {
  if (Array.isArray(v)) return toNumber(v[0] ?? null);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new FormulaError('#VALUE!');
  return n;
};
const toText = (v: FormulaValue | FormulaValue[]): string => {
  if (Array.isArray(v)) return toText(v[0] ?? null);
  return v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
};
const toBool = (v: FormulaValue | FormulaValue[]): boolean => {
  if (Array.isArray(v)) return toBool(v[0] ?? null);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  throw new FormulaError('#VALUE!');
};
const compareValues = (a: FormulaValue, b: FormulaValue): number => {
  // An empty cell equals zero and the empty string; text is compared case-insensitively.
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const rank = (v: FormulaValue) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'string') return a.toLowerCase() < (b as string).toLowerCase() ? -1 : a.toLowerCase() > (b as string).toLowerCase() ? 1 : 0;
  return Number(a) - Number(b);
};
/** Criterion of COUNTIF-like functions: ">5", "<>text", "appl*". */
const criterion = (raw: FormulaValue): ((v: FormulaValue) => boolean) => {
  const text = toText(raw);
  const m = /^(<>|<=|>=|=|<|>)(.*)$/.exec(text);
  const op = m ? m[1] : '=';
  const rest = m ? m[2] : text;
  const num = rest !== '' && Number.isFinite(Number(rest)) ? Number(rest) : undefined;
  if (num !== undefined && typeof raw !== 'boolean') {
    return (v) => {
      if (typeof v !== 'number') return op === '<>';
      return op === '=' ? v === num : op === '<>' ? v !== num : op === '<' ? v < num : op === '>' ? v > num : op === '<=' ? v <= num : v >= num;
    };
  }
  const pattern = new RegExp(`^${rest.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (v) => (op === '<>' ? !pattern.test(toText(v)) : op === '=' ? pattern.test(toText(v)) : false);
};
/** Excel date serial number → date. */
const fromSerial = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
const todaySerial = () => {
  const d = new Date();
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
};

/** Evaluates the formula for a cell. An evaluation error is returned as null. */
export function evaluateFormula(node: Node, ctx: FormulaContext): FormulaValue {
  let budget = 20_000;
  const place = (ref: Extract<Node, { t: 'ref' }>): [number, number] => [ref.absRow ? ref.row : ref.row + ctx.dRow, ref.absCol ? ref.col : ref.col + ctx.dCol];
  const range = (n: Extract<Node, { t: 'range' }>): FormulaValue[] => {
    const [r0, c0] = place(n.a);
    const [r1, c1] = place(n.b);
    const out: FormulaValue[] = [];
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        if (--budget < 0) throw new FormulaError('big');
        out.push(ctx.cell(r, c));
      }
    }
    return out;
  };
  const many = (args: Node[]): FormulaValue[] => args.flatMap((a) => (a.t === 'range' ? range(a) : [scalar(a)]));
  const numbers = (args: Node[]): number[] => {
    const out: number[] = [];
    for (const a of args) {
      if (a.t === 'range') for (const v of range(a)) { if (typeof v === 'number') out.push(v); }
      else {
        const v = scalar(a);
        if (v !== null && v !== '') out.push(toNumber(v));
      }
    }
    return out;
  };
  const scalar = (n: Node): FormulaValue => {
    const v = run(n);
    return Array.isArray(v) ? v[0] ?? null : v;
  };
  const run = (n: Node): FormulaValue | FormulaValue[] => {
    if (--budget < 0) throw new FormulaError('big');
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'ref': { const [r, c] = place(n); return r < 0 || c < 0 ? null : ctx.cell(r, c); }
      case 'range': return range(n);
      case 'un': return n.op === '-' ? -toNumber(scalar(n.x)) : toNumber(scalar(n.x));
      case 'bin': {
        const l = scalar(n.l);
        const r = scalar(n.r);
        switch (n.op) {
          case '+': return toNumber(l) + toNumber(r);
          case '-': return toNumber(l) - toNumber(r);
          case '*': return toNumber(l) * toNumber(r);
          case '/': { const d = toNumber(r); if (d === 0) throw new FormulaError('#DIV/0!'); return toNumber(l) / d; }
          case '^': return toNumber(l) ** toNumber(r);
          case '&': return toText(l) + toText(r);
          case '=': return compareValues(l, r) === 0;
          case '<>': return compareValues(l, r) !== 0;
          case '<': return compareValues(l, r) < 0;
          case '>': return compareValues(l, r) > 0;
          case '<=': return compareValues(l, r) <= 0;
          default: return compareValues(l, r) >= 0;
        }
      }
      case 'call': return call(n.name, n.args);
    }
  };
  const call = (name: string, args: Node[]): FormulaValue => {
    const arg = (i: number) => (args[i] ? scalar(args[i]) : null);
    const num = (i: number, fallback?: number) => (args[i] ? toNumber(scalar(args[i])) : fallback ?? 0);
    switch (name) {
      case 'AND': return many(args).filter((v) => v !== null).every((v) => toBool(v));
      case 'OR': return many(args).filter((v) => v !== null).some((v) => toBool(v));
      case 'NOT': return !toBool(arg(0));
      case 'IF': return toBool(arg(0)) ? (args[1] ? arg(1) : true) : args[2] ? arg(2) : false;
      case 'IFERROR': try { return arg(0); } catch { return arg(1); }
      case 'ISERROR': try { arg(0); return false; } catch { return true; }
      case 'MOD': { const d = num(1); if (d === 0) throw new FormulaError('#DIV/0!'); const a = num(0); return a - d * Math.floor(a / d); }
      case 'ROW': return (args[0]?.t === 'ref' ? place(args[0])[0] : ctx.row) + 1;
      case 'COLUMN': return (args[0]?.t === 'ref' ? place(args[0])[1] : ctx.col) + 1;
      case 'ISBLANK': return arg(0) === null || arg(0) === '';
      case 'ISNUMBER': return typeof arg(0) === 'number';
      case 'ISTEXT': return typeof arg(0) === 'string' && arg(0) !== '';
      case 'ISEVEN': return Math.floor(Math.abs(num(0))) % 2 === 0;
      case 'ISODD': return Math.floor(Math.abs(num(0))) % 2 === 1;
      case 'ABS': return Math.abs(num(0));
      case 'INT': return Math.floor(num(0));
      case 'ROUND': { const k = 10 ** num(1); return Math.round(num(0) * k) / k; }
      case 'SUM': return numbers(args).reduce((a, b) => a + b, 0);
      case 'AVERAGE': { const v = numbers(args); if (!v.length) throw new FormulaError('#DIV/0!'); return v.reduce((a, b) => a + b, 0) / v.length; }
      case 'MIN': { const v = numbers(args); return v.length ? Math.min(...v) : 0; }
      case 'MAX': { const v = numbers(args); return v.length ? Math.max(...v) : 0; }
      case 'COUNT': return numbers(args).length;
      case 'COUNTA': return many(args).filter((v) => v !== null && v !== '').length;
      case 'COUNTBLANK': return many(args).filter((v) => v === null || v === '').length;
      case 'COUNTIF': { if (args[0]?.t !== 'range' && args[0]?.t !== 'ref') throw new FormulaError('range'); const test = criterion(arg(1)); return many([args[0]]).filter(test).length; }
      case 'SUMIF': {
        const test = criterion(arg(1));
        const keys = many([args[0]]);
        const values = args[2] ? many([args[2]]) : keys;
        return keys.reduce<number>((total, key, i) => (test(key) && typeof values[i] === 'number' ? total + (values[i] as number) : total), 0);
      }
      case 'LEN': return toText(arg(0)).length;
      case 'LEFT': return toText(arg(0)).slice(0, Math.max(0, num(1, 1)));
      case 'RIGHT': { const t = toText(arg(0)); const k = Math.max(0, num(1, 1)); return k ? t.slice(-k) : ''; }
      case 'MID': return toText(arg(0)).substr(Math.max(0, num(1) - 1), Math.max(0, num(2)));
      case 'UPPER': return toText(arg(0)).toUpperCase();
      case 'LOWER': return toText(arg(0)).toLowerCase();
      case 'TRIM': return toText(arg(0)).trim().replace(/ +/g, ' ');
      case 'EXACT': return toText(arg(0)) === toText(arg(1));
      case 'VALUE': return toNumber(arg(0));
      case 'SEARCH': case 'FIND': {
        const hay = toText(arg(1));
        const needle = toText(arg(0));
        const at = name === 'SEARCH' ? hay.toLowerCase().indexOf(needle.toLowerCase(), num(2, 1) - 1) : hay.indexOf(needle, num(2, 1) - 1);
        if (at < 0) throw new FormulaError('#VALUE!');
        return at + 1;
      }
      case 'TODAY': return todaySerial();
      case 'NOW': return todaySerial() + (Date.now() % 86400000) / 86400000;
      case 'YEAR': return fromSerial(num(0)).getUTCFullYear();
      case 'MONTH': return fromSerial(num(0)).getUTCMonth() + 1;
      case 'DAY': return fromSerial(num(0)).getUTCDate();
      case 'WEEKDAY': { const day = fromSerial(num(0)).getUTCDay(); const kind = num(1, 1); return kind === 2 ? ((day + 6) % 7) + 1 : kind === 3 ? (day + 6) % 7 : day + 1; }
      case 'DATE': return Math.floor((Date.UTC(num(0), num(1) - 1, num(2)) - Date.UTC(1899, 11, 30)) / 86400000);
      default: throw new FormulaError(`fn ${name}`);
    }
  };
  try {
    return scalar(node);
  } catch {
    return null;
  }
}

/** The condition holds: the formula result is "true" or a non-zero number. */
export function formulaIsTrue(node: Node, ctx: FormulaContext): boolean {
  const v = evaluateFormula(node, ctx);
  return v === true || (typeof v === 'number' && v !== 0);
}
