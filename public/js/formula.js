// A tiny, safe spreadsheet-formula evaluator (no eval) so a table cell like
// "=SUM(D2:D4)" shows a real number in PDF/Word and in the editor, while
// Excel still gets the live formula. References are relative to the table:
// header row = row 1, first data row = row 2, columns A, B, C… in order.
// Supports numbers, cell refs, ranges, + - * / ^, unary minus, parentheses,
// SUM, AVERAGE/AVG, MIN, MAX, COUNT, ROUND, ABS.

export function isFormula(value) {
  const s = String(value ?? '').trim();
  return s.length > 1 && s.startsWith('=');
}

// "1,200.50", "$1 200", "15%" → numbers. Returns NaN for real text.
export function parseNumber(value) {
  if (typeof value === 'number') return value;
  let s = String(value ?? '').trim();
  if (!s) return NaN;
  const percent = s.endsWith('%');
  s = s.replace(/%$/, '').replace(/[\s ,]/g, '').replace(/^[^\d\-+.]+|[^\d.]+$/g, '');
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return NaN;
  const n = Number(s);
  return percent ? n / 100 : n;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?|(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|([A-Za-z]+)\s*\(|([-+*/^(),;]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m[0].length === 0) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error('bad token');
    }
    pos = re.lastIndex;
    if (m[1] && m[2]) tokens.push({ t: 'range', a: m[1], b: m[2] });
    else if (m[1]) tokens.push({ t: 'ref', a: m[1] });
    else if (m[3]) tokens.push({ t: 'num', v: Number(m[3]) });
    else if (m[4]) tokens.push({ t: 'fn', v: m[4].toUpperCase() });
    else tokens.push({ t: 'op', v: m[5] === ';' ? ',' : m[5] });
  }
  return tokens;
}

function parseRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  return { col: colIndex(m[1]), row: Number(m[2]) };
}

const FUNCS = {
  SUM: args => args.flat().reduce((a, b) => a + b, 0),
  AVERAGE: args => { const v = args.flat(); if (!v.length) throw new Error('div0'); return v.reduce((a, b) => a + b, 0) / v.length; },
  MIN: args => Math.min(...args.flat()),
  MAX: args => Math.max(...args.flat()),
  COUNT: args => args.flat().length,
  ROUND: args => { const [x, d = 0] = args.map(a => (Array.isArray(a) ? a[0] : a)); const f = 10 ** d; return Math.round(x * f) / f; },
  ABS: args => Math.abs(Array.isArray(args[0]) ? args[0][0] : args[0])
};
FUNCS.AVG = FUNCS.AVERAGE;

// table: { headers, rows }. Returns a number, or throws.
export function evaluate(formula, table, depth = 0) {
  if (depth > 20) throw new Error('circular');
  const tokens = tokenize(String(formula).trim().replace(/^=/, ''));
  let i = 0;

  const cellValue = (row, col) => {
    // row 1 is the header row; data rows start at 2
    const raw = row === 1 ? table.headers[col] : table.rows[row - 2]?.[col];
    if (raw === undefined) return NaN;
    if (isFormula(raw)) return evaluate(raw, table, depth + 1);
    return parseNumber(raw);
  };

  const rangeValues = (a, b) => {
    const p = parseRef(a), q = parseRef(b);
    const out = [];
    for (let r = Math.min(p.row, q.row); r <= Math.max(p.row, q.row); r++) {
      for (let c = Math.min(p.col, q.col); c <= Math.max(p.col, q.col); c++) {
        const v = cellValue(r, c);
        if (!Number.isNaN(v)) out.push(v); // like Excel: text in a range is skipped
      }
    }
    return out;
  };

  const peek = () => tokens[i];
  const take = () => tokens[i++];

  function primary() {
    const tok = take();
    if (!tok) throw new Error('unexpected end');
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'ref') {
      const { row, col } = parseRef(tok.a);
      const v = cellValue(row, col);
      if (Number.isNaN(v)) throw new Error('not a number');
      return v;
    }
    if (tok.t === 'range') return rangeValues(tok.a, tok.b);
    if (tok.t === 'fn') {
      const fn = FUNCS[tok.v];
      if (!fn) throw new Error('unknown function');
      const args = [];
      if (!(peek()?.t === 'op' && peek().v === ')')) {
        while (true) {
          args.push(expr());
          if (peek()?.t === 'op' && peek().v === ',') { take(); continue; }
          break;
        }
      }
      const close = take();
      if (!close || close.v !== ')') throw new Error('missing )');
      return fn(args.map(a => (Array.isArray(a) ? a : [a])));
    }
    if (tok.t === 'op' && tok.v === '(') {
      const v = expr();
      const close = take();
      if (!close || close.v !== ')') throw new Error('missing )');
      return v;
    }
    if (tok.t === 'op' && tok.v === '-') return -scalar(unary());
    if (tok.t === 'op' && tok.v === '+') return scalar(unary());
    throw new Error('unexpected token');
  }

  const scalar = v => (Array.isArray(v) ? (v.length === 1 ? v[0] : NaN) : v);
  function unary() { return primary(); }
  function power() {
    let v = unary();
    while (peek()?.t === 'op' && peek().v === '^') { take(); v = scalar(v) ** scalar(unary()); }
    return v;
  }
  function term() {
    let v = power();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = take().v;
      const rhs = scalar(power());
      v = op === '*' ? scalar(v) * rhs : scalar(v) / rhs;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = take().v;
      const rhs = scalar(term());
      v = op === '+' ? scalar(v) + rhs : scalar(v) - rhs;
    }
    return v;
  }

  const result = scalar(expr());
  if (i < tokens.length) throw new Error('trailing input');
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('not finite');
  return result;
}

export function formatNumber(n) {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// What a cell should display in PDF/Word/preview: computed value for
// formulas (or the raw text if it can't be computed), raw text otherwise.
export function displayValue(raw, table) {
  if (!isFormula(raw)) return String(raw ?? '');
  try {
    return formatNumber(evaluate(raw, table));
  } catch {
    return String(raw);
  }
}

// Moves every relative reference in a formula down by `rowOffset` rows, so
// a table that starts at sheet row N keeps working in Excel. Absolute rows
// ($A$1) and function names like LOG10 are left alone.
export function rebaseFormula(formula, rowOffset) {
  if (!rowOffset) return formula;
  return String(formula).replace(
    /(?<![A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g,
    (m, colAbs, col, rowAbs, row) => (rowAbs ? m : `${colAbs}${col}${Number(row) + rowOffset}`)
  );
}

// Plain numbers like "4500000" read better as "4,500,000" in PDF/Word and on
// screen, matching how formula results are shown. Excel keeps the raw value.
// Columns holding identifiers (years, IDs, phone numbers…) are left as-is.
const ID_HEADER = /(#|\b(year|yil|год|id|no|nr|code|kod|phone|tel|telefon|inn|stir|zip|postal|account|iban|swift)\b)/i;
export function displayCell(raw, table, col) {
  if (isFormula(raw)) return displayValue(raw, table);
  const s = String(raw ?? '');
  if (/^-?[1-9]\d{3,}(\.\d+)?$/.test(s.trim()) && !ID_HEADER.test(table?.headers?.[col] || '')) {
    return formatNumber(Number(s));
  }
  return s;
}
