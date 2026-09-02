/**
 * A YAML subset parser, scoped to the files this tool ships: hooks/hooks.yaml,
 * config/default.yaml, agent.yaml.
 *
 * Why not a dependency: the file this parses is a security control. A parser
 * that silently mis-reads a guardrail produces a guardrail that is quietly off,
 * so the property that matters most here is failing loudly on anything it does
 * not understand — which is exactly what a general parser will not do, because
 * it will happily accept constructs whose semantics we would then have to
 * reason about anyway. Zero runtime dependencies is also a claim on the README
 * next to "no telemetry"; a transitive tree undercuts the audit-it-yourself
 * pitch more than it saves.
 *
 * Why not more regexes in config.js: section-scoped regex reads flat scalars.
 * hooks.yaml is lists of maps containing lists of maps. Regex cannot address
 * pre_edit[3].deny[2], and stretching it to try is how it half-works.
 *
 * Supported: block maps, block sequences, flow sequences of scalars, block
 * scalars (| > with - + chomping), comments, quoted and bare scalars,
 * null/~/empty, booleans, integers and floats.
 *
 * Not supported, and throws rather than guesses: anchors, aliases, merge keys,
 * flow mappings, multiple documents, complex keys, tabs used as indentation.
 * If hooks.yaml ever legitimately needs one of those, that is the point where a
 * real YAML dependency has earned its place — take the throw as the signal.
 */

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.\-]*):(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR_RE = /^([|>])([-+]?)$/;

// YAML 1.1 booleans. `overridable: no` must read as false, not as the truthy
// string "no" — in a guardrail file that particular misread disables a hook.
const TRUE = new Set(['true', 'yes', 'on']);
const FALSE = new Set(['false', 'no', 'off']);

class YamlError extends Error {}

export function parseYaml(text, source = 'YAML') {
  const st = { lines: String(text).replace(/\r\n?/g, '\n').split('\n'), i: 0, source };
  const at = seek(st);
  if (at === -1) return null;
  st.i = at;
  const value = parseBlock(st, indentOf(st, st.i));
  if (seek(st) !== -1) fail(st, st.i, 'unexpected content after the top-level block');
  return value;
}

function fail(st, line, msg) {
  throw new YamlError(`${st.source}:${line + 1}: ${msg}`);
}

const isIgnorable = (line) => /^[ \t]*(#.*)?$/.test(line);

/** Index of the next significant line, or -1. Advances st.i past ignorable lines. */
function seek(st) {
  while (st.i < st.lines.length && isIgnorable(st.lines[st.i])) st.i++;
  return st.i < st.lines.length ? st.i : -1;
}

function indentOf(st, i) {
  const line = st.lines[i];
  const ws = line.match(/^[ \t]*/)[0];
  if (ws.includes('\t')) fail(st, i, 'tab used as indentation; use spaces');
  return ws.length;
}

/** Strip a trailing `# comment`, respecting quotes. */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function parseBlock(st, indent) {
  const at = seek(st);
  if (at === -1) return null;
  const body = st.lines[at].slice(indent);
  return /^-([ \t]|$)/.test(body) ? parseSeq(st, indent) : parseMap(st, indent);
}

function parseSeq(st, indent) {
  const out = [];
  while (seek(st) !== -1) {
    const i = st.i;
    if (indentOf(st, i) !== indent) break;
    const body = st.lines[i].slice(indent);
    if (!/^-([ \t]|$)/.test(body)) break;

    const rest = stripComment(body.slice(1)).trim();
    st.i = i + 1;

    if (rest === '') {
      // `-` alone: the item is a nested block on the following lines.
      const nested = seek(st);
      if (nested !== -1 && indentOf(st, nested) > indent) out.push(parseBlock(st, indentOf(st, nested)));
      else out.push(null);
      continue;
    }

    const key = rest.match(KEY_RE);
    if (key) {
      // `- name: x` — a map whose first key sits at the column after "- ".
      const offset = indent + body.indexOf(rest[0], 1);
      out.push(parseMap(st, offset, { line: i, key: key[1], rest: key[2] }));
    } else {
      out.push(parseScalar(st, i, rest));
    }
  }
  return out;
}

/**
 * `seed` carries the first key/value when the map opened on a sequence-item
 * line (`- name: x`), where that pair has already been consumed.
 */
function parseMap(st, indent, seed) {
  const out = {};
  if (seed) out[seed.key] = parseValue(st, seed.line, seed.rest, indent);

  while (seek(st) !== -1) {
    const i = st.i;
    if (indentOf(st, i) !== indent) break;
    const body = stripComment(st.lines[i].slice(indent)).trimEnd();
    if (body === '') { st.i = i + 1; continue; }
    if (/^-([ \t]|$)/.test(body)) break;

    // Name the unsupported construct rather than reporting a generic shape
    // error: this message is the signal that a real YAML parser has earned
    // its dependency.
    if (body.startsWith('<<')) fail(st, i, 'merge keys are not supported');
    if (body.startsWith('&') || body.startsWith('*')) fail(st, i, 'anchors and aliases are not supported');
    if (body.startsWith('?')) fail(st, i, 'complex keys are not supported');
    if (body === '---' || body === '...') fail(st, i, 'multiple documents are not supported');

    const m = body.match(KEY_RE);
    if (!m) fail(st, i, `expected "key: value", got ${JSON.stringify(body.trim())}`);
    st.i = i + 1;
    out[m[1]] = parseValue(st, i, m[2], indent);
  }
  return out;
}

/** The value for a `key:` on line `i`, which may live on following lines. */
function parseValue(st, i, rest, indent) {
  const text = rest === undefined ? '' : rest.trim();

  const block = text.match(BLOCK_SCALAR_RE);
  if (block) return parseBlockScalar(st, indent, block[1], block[2]);

  if (text === '') {
    const nested = seek(st);
    if (nested === -1) return null;
    const childIndent = indentOf(st, nested);
    if (childIndent > indent) return parseBlock(st, childIndent);
    // A sequence may sit at the parent's own indentation, which is legal YAML.
    if (childIndent === indent && /^-([ \t]|$)/.test(st.lines[nested].slice(indent))) {
      return parseSeq(st, indent);
    }
    return null;
  }

  return parseScalar(st, i, text);
}

function parseBlockScalar(st, indent, style, chomp) {
  const kept = [];
  let childIndent = null;
  while (st.i < st.lines.length) {
    const line = st.lines[st.i];
    if (line.trim() === '') { kept.push(''); st.i++; continue; }
    const ind = indentOf(st, st.i);
    if (ind <= indent) break;
    if (childIndent === null) childIndent = ind;
    kept.push(line.slice(childIndent));
    st.i++;
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();

  let body;
  if (style === '|') body = kept.join('\n');
  else {
    // Folded: a line break between two non-empty lines folds to a space, and a
    // run of n blank lines folds to n newlines — not n + 1.
    let blanks = 0;
    body = '';
    let started = false;
    for (const line of kept) {
      if (line === '') { blanks++; continue; }
      if (!started) { body = line; started = true; }
      else body += (blanks > 0 ? '\n'.repeat(blanks) : ' ') + line;
      blanks = 0;
    }
  }
  if (chomp === '+') return `${body}\n`;
  if (chomp === '-') return body;
  return kept.length ? `${body}\n` : body;
}

function parseScalar(st, i, raw) {
  const text = stripComment(raw).trim();

  if (text.startsWith('"')) return unquoteDouble(st, i, text);
  if (text.startsWith("'")) return unquoteSingle(st, i, text);
  if (text.startsWith('[')) return parseFlowSeq(st, i, text);

  if (text.startsWith('{')) fail(st, i, 'flow mappings are not supported');
  if (text.startsWith('&') || text.startsWith('*')) fail(st, i, 'anchors and aliases are not supported');
  if (text.startsWith('<<')) fail(st, i, 'merge keys are not supported');
  if (text === '---' || text === '...') fail(st, i, 'multiple documents are not supported');

  return coerce(text);
}

function coerce(text) {
  if (text === '' || text === '~' || text.toLowerCase() === 'null') return null;
  const lower = text.toLowerCase();
  if (TRUE.has(lower)) return true;
  if (FALSE.has(lower)) return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?(?:\d+\.\d*|\.\d+)$/.test(text)) return Number(text);
  return text;
}

function unquoteDouble(st, i, text) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) fail(st, i, 'unterminated double-quoted string');
  return text
    .slice(1, -1)
    .replace(/\\(["\\/nrt])/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t' }[ch] ?? ch));
}

function unquoteSingle(st, i, text) {
  if (!/^'(?:[^']|'')*'$/.test(text)) fail(st, i, 'unterminated single-quoted string');
  return text.slice(1, -1).replace(/''/g, "'");
}

function parseFlowSeq(st, i, text) {
  if (!text.endsWith(']')) fail(st, i, 'unterminated flow sequence');
  const inner = text.slice(1, -1);
  if (/[[{]/.test(stripQuoted(inner))) fail(st, i, 'nested flow collections are not supported');

  const items = [];
  let buf = '';
  let quote = null;
  for (let n = 0; n < inner.length; n++) {
    const ch = inner[n];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"') buf += inner[++n] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; buf += ch; }
    else if (ch === ',') { items.push(buf); buf = ''; }
    else buf += ch;
  }
  if (quote) fail(st, i, 'unterminated string in flow sequence');
  if (buf.trim() !== '' || items.length) items.push(buf);
  return items.map((s) => s.trim()).filter((s, n, a) => !(s === '' && n === a.length - 1 && a.length === 1))
    .map((s) => (s.startsWith('"') ? unquoteDouble(st, i, s) : s.startsWith("'") ? unquoteSingle(st, i, s) : coerce(s)));
}

/** Blank out quoted spans so structural scans ignore their contents. */
function stripQuoted(s) {
  return s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
}
