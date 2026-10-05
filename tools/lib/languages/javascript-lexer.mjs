/**
 * A small, tolerant tokenizer for JavaScript and TypeScript (including JSX text), standard library only.
 * It is not a parser. It exists to find import/export/require statements reliably: comments, strings,
 * template literals and regular expressions are skipped so their contents are never mistaken for code.
 * Malformed input never throws; problems are reported as diagnostics.
 */

const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function isIdStart(ch) {
  return /[A-Za-z_$#]/.test(ch) || ch.charCodeAt(0) > 127;
}
function isIdPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

function regexAllowed(last) {
  if (!last) return true;
  if (last.t === 'num' || last.t === 'str' || last.t === 'tpl' || last.t === 'regex') return false;
  if (last.t === 'id') return REGEX_AFTER_KEYWORD.has(last.v);
  if (last.t === 'punct') return !(last.v === ')' || last.v === ']' || last.v === '}');
  return true;
}

/**
 * @returns {{tokens: object[], diagnostics: object[], structuralError: boolean}}
 * Tokens: {t: 'id'|'str'|'tpl'|'num'|'regex'|'punct', v, d (brace depth), x (template has expression or escape)}
 */
export function tokenize(src, { jsx = false } = {}) {
  const tokens = [];
  const diagnostics = [];
  const n = src.length;
  let i = 0;
  let depth = 0;
  let structuralError = false;
  let unterminatedStrings = 0;
  let firstUnterminatedLine = 0;
  let line = 1;

  function skipLineComment(from) {
    const j = src.indexOf('\n', from);
    return j < 0 ? n : j;
  }

  function scanTemplate(start) {
    let j = start + 1;
    let value = '';
    let hasExpr = false;
    while (j < n) {
      const d = src[j];
      if (d === '\\') {
        value += d + (src[j + 1] ?? '');
        hasExpr = true; // escapes make the value unreliable as a specifier
        j += 2;
        continue;
      }
      if (d === '`') return { end: j + 1, value, hasExpr };
      if (d === '$' && src[j + 1] === '{') {
        hasExpr = true;
        j = skipExpr(j + 2);
        continue;
      }
      value += d;
      j++;
    }
    return { end: n, value, hasExpr, unterminated: true };
  }

  function skipExpr(start) {
    let j = start;
    let bd = 1;
    while (j < n) {
      const d = src[j];
      if (d === '"' || d === "'") {
        j++;
        while (j < n && src[j] !== d && src[j] !== '\n') {
          if (src[j] === '\\') j++;
          j++;
        }
        j++;
        continue;
      }
      if (d === '`') {
        j = scanTemplate(j).end;
        continue;
      }
      if (d === '/' && src[j + 1] === '/') {
        j = skipLineComment(j);
        continue;
      }
      if (d === '/' && src[j + 1] === '*') {
        const e = src.indexOf('*/', j + 2);
        j = e < 0 ? n : e + 2;
        continue;
      }
      if (d === '{') bd++;
      else if (d === '}') {
        bd--;
        if (bd === 0) return j + 1;
      }
      j++;
    }
    return n;
  }

  if (src.startsWith('#!')) i = skipLineComment(0);

  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || /\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i = skipLineComment(i);
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) {
        diagnostics.push({ severity: 'error', code: 'unterminated-comment', message: `unterminated block comment starting at line ${line}` });
        structuralError = true;
        i = n;
      } else {
        for (let k = i; k < e; k++) if (src[k] === '\n') line++;
        i = e + 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (d === ch) {
          closed = true;
          break;
        }
        if (d === '\n') break;
        value += d;
        j++;
      }
      if (!closed) {
        unterminatedStrings++;
        if (!firstUnterminatedLine) firstUnterminatedLine = line;
      }
      tokens.push({ t: 'str', v: value, d: depth, x: false });
      i = closed ? j + 1 : j;
      continue;
    }
    if (ch === '`') {
      const r = scanTemplate(i);
      if (r.unterminated) {
        diagnostics.push({ severity: 'error', code: 'unterminated-template', message: `unterminated template literal starting at line ${line}` });
        structuralError = true;
      }
      for (let k = i; k < r.end; k++) if (src[k] === '\n') line++;
      tokens.push({ t: 'tpl', v: r.value, d: depth, x: r.hasExpr });
      i = r.end;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j), d: depth });
      i = j;
      continue;
    }
    if (isIdStart(ch)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j), d: depth });
      i = j;
      continue;
    }
    if (ch === '/' && regexAllowed(tokens[tokens.length - 1])) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        tokens.push({ t: 'regex', v: '', d: depth });
        i = j;
        continue;
      }
    }
    if (ch === '{') {
      tokens.push({ t: 'punct', v: '{', d: depth });
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) {
        depth = 0;
        structuralError = true;
        diagnostics.push({ severity: 'error', code: 'unbalanced-braces', message: `unexpected closing brace at line ${line}` });
      }
      tokens.push({ t: 'punct', v: '}', d: depth });
    } else {
      tokens.push({ t: 'punct', v: ch, d: depth });
    }
    i++;
  }

  if (depth !== 0) {
    structuralError = true;
    diagnostics.push({ severity: 'error', code: 'unbalanced-braces', message: `${depth} unclosed brace(s) at end of file` });
  }
  if (unterminatedStrings > 0) {
    diagnostics.push({
      severity: jsx ? 'info' : 'warning',
      code: 'unterminated-string',
      message: `${unterminatedStrings} unterminated string literal(s), first at line ${firstUnterminatedLine}${jsx ? ' (apostrophes in JSX text are expected)' : ''}`,
    });
  }
  return { tokens, diagnostics, structuralError };
}

/**
 * First sentence of a leading doc comment, used only as a hint for summaries. Returns null when absent.
 * Skips shebangs, directive strings and license headers.
 */
export function leadingComment(src) {
  let s = src;
  if (s.startsWith('#!')) s = s.slice(s.indexOf('\n') + 1 || s.length);
  let i = 0;
  const n = s.length;
  for (let guard = 0; guard < 6; guard++) {
    while (i < n && /\s/.test(s[i])) i++;
    const m = /^(['"])use [a-z ]+\1;?/.exec(s.slice(i, i + 40));
    if (m) i += m[0].length;
    else break;
  }
  let text = null;
  if (s.startsWith('/*', i)) {
    const e = s.indexOf('*/', i + 2);
    if (e < 0) return null;
    text = s
      .slice(i + 2, e)
      .split('\n')
      .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
      .filter((l) => !l.startsWith('@'))
      .join(' ')
      .trim();
  } else if (s.startsWith('//', i)) {
    const lines = [];
    let j = i;
    while (s.startsWith('//', j)) {
      const e = s.indexOf('\n', j);
      lines.push(s.slice(j + 2, e < 0 ? n : e).trim());
      if (e < 0) break;
      j = e + 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
    }
    text = lines.join(' ').trim();
  }
  if (!text) return null;
  if (/copyright|license|spdx|all rights reserved/i.test(text)) return null;
  const sentence = /^(.{3,200}?[.!?])(\s|$)/.exec(text);
  const out = sentence ? sentence[1] : text.slice(0, 200);
  return out.length > 0 ? out : null;
}
