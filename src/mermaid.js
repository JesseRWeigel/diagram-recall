/**
 * A mermaid flowchart parser that refuses to drop things quietly.
 *
 * The reason this file is careful is pedagogical rather than aesthetic. The reference graph is
 * what a learner is marked against. A link this parser fails to read is a link the learner is
 * penalised for drawing correctly. So every statement is either understood, or reported with
 * its line number and its text. There is no third branch.
 *
 * Diagnostics come in three severities:
 *
 *   error   The statement could not be interpreted, so the graph is incomplete and unsafe to
 *           score against. Callers refuse to build a drill from a block with any of these.
 *   warning The statement was understood but something about it is likely to surprise, for
 *           example a bidirectional link expanded into two directed links.
 *   info    The statement was recognised and deliberately ignored because it is presentation
 *           only, for example `style`, `classDef`, `click` and `linkStyle`. These cannot change
 *           the graph, so ignoring them is safe, and they are still reported so that nothing
 *           disappears without a trace.
 */

import { createGraph, ensureNode } from './graph.js';

export const ERROR = 'error';
export const WARNING = 'warning';
export const INFO = 'info';

/**
 * Opening and closing delimiters for every node shape, longest opening first.
 *
 * Two entries share the opening `[/` and two share `[\`. For those, the closing delimiter that
 * actually turns up decides which shape it was, which is how mermaid itself distinguishes a
 * parallelogram from a trapezoid.
 */
const SHAPES = [
  { open: '(((', close: ')))', shape: 'double-circle' },
  { open: '((', close: '))', shape: 'circle' },
  { open: '([', close: '])', shape: 'stadium' },
  { open: '[[', close: ']]', shape: 'subroutine' },
  { open: '[(', close: ')]', shape: 'cylinder' },
  { open: '[/', close: '/]', shape: 'parallelogram' },
  { open: '[/', close: '\\]', shape: 'trapezoid' },
  { open: '[\\', close: '\\]', shape: 'parallelogram-alt' },
  { open: '[\\', close: '/]', shape: 'trapezoid-alt' },
  { open: '{{', close: '}}', shape: 'hexagon' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '>', close: ']', shape: 'asymmetric' },
];

/**
 * A complete link operator with nothing between its halves.
 *
 * Ordered so that the dotted forms are tried before the solid ones, and so that a form with a
 * head is tried before the bare open link of the same family. Note that the shortest solid open
 * link is three dashes: a bare `--` is never a complete operator, which is exactly what makes
 * the `-- text -->` form unambiguous.
 */
const PLAIN_OPERATOR = /^(-\.+-[>ox]?|-{2,}[>ox]|-{3,}|={2,}[>ox]|={3,})/;

/** The opening half of a link that carries its label in the middle. */
const MIDDLE_OPENERS = [
  { open: '-.', kind: 'dotted', close: /\.-+[>ox]?/ },
  { open: '==', kind: 'thick', close: /={2,}[>ox]?|=[>ox]/ },
  { open: '--', kind: 'solid', close: /-{2,}[>ox]?|-[>ox]/ },
];

/** A node id: letters, digits and underscores, with dots and interior hyphens allowed. */
const NODE_ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?=[\p{L}\p{N}_]))*/u;

/** Recognised and deliberately ignored. None of these can change the graph. */
const PRESENTATION_KEYWORDS = new Set([
  'style',
  'classdef',
  'class',
  'click',
  'linkstyle',
  'direction',
  'acctitle',
  'accdescr',
]);

/** Diagram types that are not flowcharts. Naming them gives a better message than "unknown". */
const OTHER_DIAGRAM_TYPES = [
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'journey',
  'gantt',
  'pie',
  'gitgraph',
  'mindmap',
  'timeline',
  'quadrantchart',
  'requirementdiagram',
  'c4context',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'architecture-beta',
];

const HEADER = /^(graph|flowchart|flowchart-elk)(?:\s+(TB|TD|BT|RL|LR))?$/i;

class Diagnostics {
  constructor() {
    this.items = [];
  }

  add(severity, line, text, message) {
    this.items.push({ severity, line, text: text.trim(), message });
  }

  get errors() {
    return this.items.filter((item) => item.severity === ERROR);
  }
}

/** Advance past a double quoted run starting at `i`, returning the index after it, or -1. */
function skipQuoted(source, i) {
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === '"') return j + 1;
    j += 1;
  }
  return -1;
}

/** Index of the first occurrence of any of `needles` outside a quoted run, or -1. */
function findOutsideQuotes(source, from, needles) {
  let i = from;
  while (i < source.length) {
    if (source[i] === '"') {
      const next = skipQuoted(source, i);
      if (next < 0) return -1;
      i = next;
      continue;
    }
    for (const needle of needles) {
      if (source.startsWith(needle, i)) return i;
    }
    i += 1;
  }
  return -1;
}

/** First match of `pattern` outside a quoted run, as `{index, match}`, or null. */
function searchOutsideQuotes(source, from, pattern) {
  let i = from;
  const anchored = new RegExp(`^(?:${pattern.source})`, pattern.flags.replace('g', ''));
  while (i < source.length) {
    if (source[i] === '"') {
      const next = skipQuoted(source, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    const match = anchored.exec(source.slice(i));
    if (match) return { index: i, match: match[0] };
    i += 1;
  }
  return null;
}

function unquote(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

/** Collapse runs of whitespace so that a caption split over two lines compares equal. */
export function normaliseLabel(text) {
  return unquote(text).replace(/\s+/g, ' ').trim();
}

/** Strip a `%%` comment that is not inside quotes. */
function stripComment(line) {
  const at = findOutsideQuotes(line, 0, ['%%']);
  return at < 0 ? line : line.slice(0, at);
}

/**
 * Split the block into statements. Mermaid separates them by newline or by a semicolon that is
 * not inside quotes. Each statement carries the line it came from, because that is what a
 * diagnostic has to point at.
 */
function splitStatements(source, startLine) {
  const out = [];
  const lines = source.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = startLine + index;
    if (/^\s*%%\{/.test(raw)) {
      out.push({ text: raw.trim(), line, directive: true });
      continue;
    }
    const body = stripComment(raw);
    let buffer = '';
    let i = 0;
    while (i < body.length) {
      if (body[i] === '"') {
        const next = skipQuoted(body, i);
        if (next < 0) {
          buffer += body.slice(i);
          i = body.length;
          break;
        }
        buffer += body.slice(i, next);
        i = next;
        continue;
      }
      if (body[i] === ';') {
        out.push({ text: buffer, line });
        buffer = '';
        i += 1;
        continue;
      }
      buffer += body[i];
      i += 1;
    }
    out.push({ text: buffer, line });
  }
  return out.filter((statement) => statement.text.trim() !== '');
}

class Cursor {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  get rest() {
    return this.text.slice(this.i);
  }

  skipSpace() {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i += 1;
  }

  atEnd() {
    this.skipSpace();
    return this.i >= this.text.length;
  }
}

class StatementError extends Error {}

/** Read `A`, `A[Caption]`, `A{{Caption}}` and the rest of the shape table. */
function readNodeSpec(cursor) {
  cursor.skipSpace();
  const idMatch = NODE_ID.exec(cursor.rest);
  if (!idMatch) return null;
  const id = idMatch[0];
  cursor.i += id.length;

  const candidates = SHAPES.filter((entry) => cursor.text.startsWith(entry.open, cursor.i));
  if (candidates.length === 0) return { id, label: null, shape: null };

  const openLength = Math.max(...candidates.map((entry) => entry.open.length));
  const viable = candidates.filter((entry) => entry.open.length === openLength);
  const textStart = cursor.i + openLength;
  const found = findOutsideQuotes(
    cursor.text,
    textStart,
    viable.map((entry) => entry.close),
  );
  if (found < 0) {
    throw new StatementError(
      `node "${id}" opens with "${viable[0].open}" and never closes with ` +
        `"${viable.map((entry) => entry.close).join('" or "')}". If the caption contains a ` +
        'delimiter character, wrap it in double quotes.',
    );
  }
  const entry = viable.find((candidate) => cursor.text.startsWith(candidate.close, found));
  const raw = cursor.text.slice(textStart, found);
  cursor.i = found + entry.close.length;
  return { id, label: normaliseLabel(raw), shape: entry.shape };
}

/** Read `A & B & C`, the set of nodes one side of a link applies to. */
function readNodeGroup(cursor) {
  const specs = [];
  for (;;) {
    const spec = readNodeSpec(cursor);
    if (!spec) break;
    specs.push(spec);
    cursor.skipSpace();
    if (cursor.text[cursor.i] === '&') {
      cursor.i += 1;
      continue;
    }
    break;
  }
  return specs.length ? specs : null;
}

function headFromCap(cap) {
  if (cap === '>') return 'arrow';
  if (cap === 'o') return 'circle';
  if (cap === 'x') return 'cross';
  return 'open';
}

function kindFromOperator(operator) {
  if (operator.includes('.')) return 'dotted';
  if (operator.includes('=')) return 'thick';
  return 'solid';
}

/** Read `|label|` immediately after an operator, if present. */
function readPipeLabel(cursor) {
  cursor.skipSpace();
  if (cursor.text[cursor.i] !== '|') return null;
  const close = findOutsideQuotes(cursor.text, cursor.i + 1, ['|']);
  if (close < 0) {
    throw new StatementError(
      'a link label opened with "|" and never closed. If the label contains a "|", ' +
        'wrap the label in double quotes.',
    );
  }
  const raw = cursor.text.slice(cursor.i + 1, close);
  cursor.i = close + 1;
  return normaliseLabel(raw);
}

/**
 * Read one link operator, in any of the forms this parser supports.
 *
 * Returns `{kind, head, label, bidirectional}` or null when the cursor is not on an operator.
 */
function readOperator(cursor) {
  cursor.skipSpace();
  let bidirectional = false;
  let tailCap = null;
  if (cursor.text[cursor.i] === '<') {
    bidirectional = true;
    cursor.i += 1;
  } else if (/[ox]/.test(cursor.text[cursor.i] || '') && /[-=]/.test(cursor.text[cursor.i + 1] || '')) {
    tailCap = cursor.text[cursor.i];
    bidirectional = true;
    cursor.i += 1;
  }

  const plain = PLAIN_OPERATOR.exec(cursor.rest);
  if (plain) {
    const operator = plain[0];
    cursor.i += operator.length;
    const cap = /[>ox]$/.test(operator) ? operator[operator.length - 1] : '';
    const head = headFromCap(cap);
    if (bidirectional && head === 'open' && !tailCap) {
      throw new StatementError(`"<${operator}" is not a link this parser understands.`);
    }
    return {
      kind: kindFromOperator(operator),
      head: bidirectional && !cap ? headFromCap(tailCap) : head,
      label: readPipeLabel(cursor),
      bidirectional,
    };
  }

  for (const opener of MIDDLE_OPENERS) {
    if (!cursor.text.startsWith(opener.open, cursor.i)) continue;
    const textStart = cursor.i + opener.open.length;
    const found = searchOutsideQuotes(cursor.text, textStart, opener.close);
    if (!found) {
      throw new StatementError(
        `a link opened with "${opener.open}" and its closing half was never found. ` +
          'Mermaid writes a mid-link label as `A -- text --> B`.',
      );
    }
    const raw = cursor.text.slice(textStart, found.index);
    if (raw.trim() === '') continue;
    cursor.i = found.index + found.match.length;
    const cap = /[>ox]$/.test(found.match) ? found.match[found.match.length - 1] : '';
    return {
      kind: opener.kind,
      head: bidirectional && !cap ? headFromCap(tailCap) : headFromCap(cap),
      label: normaliseLabel(raw),
      bidirectional,
    };
  }

  if (bidirectional) cursor.i -= 1;
  return null;
}

/** True when the statement contains something that looks like a link, quotes excluded. */
function looksLikeALink(text) {
  return (
    searchOutsideQuotes(text, 0, /-{2,}|-\.+-|={2,}|-\.\s|==\s/) !== null
  );
}

function parseSubgraphHeader(text) {
  const body = text.replace(/^subgraph\s*/i, '');
  if (body.trim() === '') return { id: null, title: null };
  const cursor = new Cursor(body);
  if (body.trim().startsWith('"')) {
    return { id: null, title: normaliseLabel(body) };
  }
  const spec = readNodeSpec(cursor);
  if (!spec) return { id: null, title: normaliseLabel(body) };
  if (cursor.atEnd()) {
    return { id: spec.id, title: spec.label };
  }
  // `subgraph one [Title]` with a space before the bracket.
  const rest = cursor.rest.trim();
  const bracket = /^\[(.*)\]$/.exec(rest);
  if (bracket) return { id: spec.id, title: normaliseLabel(bracket[1]) };
  // Anything else after the first word means the whole line was a title with spaces in it,
  // for example `subgraph Data ingestion`. Mermaid uses that text as both id and title.
  return { id: null, title: normaliseLabel(body) };
}

/**
 * Parse one mermaid flowchart block.
 *
 * `startLine` is the 1 based line number of the block's first line in the enclosing file, so
 * that diagnostics point at the file rather than at the extracted fragment.
 */
export function parseMermaid(source, { startLine = 1 } = {}) {
  const diagnostics = new Diagnostics();
  const statements = splitStatements(source, startLine);
  const graph = createGraph('TD');

  if (statements.length === 0) {
    diagnostics.add(ERROR, startLine, '', 'the mermaid block is empty.');
    return { graph, diagnostics: diagnostics.items };
  }

  const first = statements[0];
  const header = HEADER.exec(first.text.trim());
  if (!header) {
    const word = (/^[\w-]+/.exec(first.text.trim()) || [''])[0].toLowerCase();
    if (OTHER_DIAGRAM_TYPES.includes(word)) {
      diagnostics.add(
        ERROR,
        first.line,
        first.text,
        `this is a "${word}", and only flowcharts are supported. A flowchart block starts ` +
          'with `graph TD` or `flowchart LR`.',
      );
    } else {
      diagnostics.add(
        ERROR,
        first.line,
        first.text,
        'the block does not start with `graph <dir>` or `flowchart <dir>`, so its diagram ' +
          'type is unknown and nothing below can be read safely.',
      );
    }
    return { graph, diagnostics: diagnostics.items };
  }
  graph.direction = (header[2] || 'TB').toUpperCase();
  if (header[1].toLowerCase() === 'flowchart-elk') {
    diagnostics.add(
      INFO,
      first.line,
      first.text,
      'flowchart-elk selects a different renderer and is read as a plain flowchart. ' +
        'The graph is unaffected.',
    );
  }

  const stack = [];
  let anonymousSubgraphs = 0;

  for (const statement of statements.slice(1)) {
    const text = statement.text;
    const trimmed = text.trim();

    if (statement.directive) {
      diagnostics.add(
        INFO,
        statement.line,
        trimmed,
        'an init directive sets renderer options and cannot change the graph, so it is ignored.',
      );
      continue;
    }

    if (/^end$/i.test(trimmed)) {
      if (stack.length === 0) {
        diagnostics.add(ERROR, statement.line, trimmed, '`end` with no open `subgraph`.');
      } else {
        stack.pop();
      }
      continue;
    }

    if (/^subgraph\b/i.test(trimmed)) {
      let parsed;
      try {
        parsed = parseSubgraphHeader(trimmed);
      } catch (error) {
        diagnostics.add(ERROR, statement.line, trimmed, error.message);
        continue;
      }
      anonymousSubgraphs += 1;
      const id = parsed.id || `subgraph${anonymousSubgraphs}`;
      graph.subgraphs.set(id, {
        id,
        title: parsed.title === null || parsed.title === '' ? null : parsed.title,
        parent: stack.length ? stack[stack.length - 1] : null,
      });
      stack.push(id);
      continue;
    }

    const keyword = (/^[A-Za-z_]+/.exec(trimmed) || [''])[0].toLowerCase();
    if (PRESENTATION_KEYWORDS.has(keyword) && !looksLikeALink(trimmed)) {
      diagnostics.add(
        INFO,
        statement.line,
        trimmed,
        `\`${keyword}\` is presentation only and cannot change the graph, so it is ignored.`,
      );
      continue;
    }

    try {
      parseChain(text, statement.line, graph, stack, diagnostics);
    } catch (error) {
      if (!(error instanceof StatementError)) throw error;
      diagnostics.add(ERROR, statement.line, trimmed, error.message);
    }
  }

  if (stack.length) {
    diagnostics.add(
      ERROR,
      startLine,
      '',
      `${stack.length} subgraph(s) opened and never closed with \`end\`: ${stack.join(', ')}.`,
    );
  }

  return { graph, diagnostics: diagnostics.items };
}

function parseChain(text, line, graph, stack, diagnostics) {
  const cursor = new Cursor(text);
  const groups = [];
  const operators = [];

  const firstGroup = readNodeGroup(cursor);
  if (!firstGroup) {
    throw new StatementError(
      'this statement is not a node declaration, a link, a subgraph or a known directive, ' +
        'so the parser cannot tell what it declares. It is reported rather than dropped, ' +
        'because a dropped statement would silently make the reference diagram wrong.',
    );
  }
  groups.push(firstGroup);

  while (!cursor.atEnd()) {
    const before = cursor.i;
    const operator = readOperator(cursor);
    if (!operator) {
      throw new StatementError(
        `unexpected "${cursor.rest.trim()}" after a node. Supported links are \`-->\`, ` +
          '`---`, `-.->`, `==>`, `--o`, `--x` and their labelled forms `-->|text|` and ' +
          '`-- text -->`.',
      );
    }
    if (cursor.i === before) throw new StatementError('the link operator made no progress.');
    const group = readNodeGroup(cursor);
    if (!group) {
      throw new StatementError('a link has no node on its right hand side.');
    }
    operators.push(operator);
    groups.push(group);
  }

  const subgraph = stack.length ? stack[stack.length - 1] : null;
  for (const group of groups) {
    for (const spec of group) {
      const node = ensureNode(graph, spec.id, line);
      if (spec.label !== null) node.label = spec.label;
      if (spec.shape !== null) node.shape = spec.shape;
      // A node belongs to the subgraph it is first written inside. Later mentions elsewhere
      // do not move it, which is how mermaid itself behaves.
      if (node.subgraph === null && subgraph !== null) node.subgraph = subgraph;
    }
  }

  for (let index = 0; index < operators.length; index += 1) {
    const operator = operators[index];
    for (const from of groups[index]) {
      for (const to of groups[index + 1]) {
        graph.edges.push({
          from: from.id,
          to: to.id,
          kind: operator.kind,
          head: operator.head,
          label: operator.label,
          line,
        });
        if (operator.bidirectional) {
          graph.edges.push({
            from: to.id,
            to: from.id,
            kind: operator.kind,
            head: operator.head,
            label: operator.label,
            line,
          });
          diagnostics.add(
            WARNING,
            line,
            text.trim(),
            `the bidirectional link between "${from.id}" and "${to.id}" is read as two ` +
              'directed links, so a reconstruction has to place both.',
          );
        }
      }
    }
  }
}

/**
 * Every fenced mermaid block in a markdown document, in order.
 *
 * Handles backtick and tilde fences of three characters or more, an info string with extra
 * attributes, and indented fences inside list items. A fence closes on a run of the same
 * character at least as long as the opening run.
 */
export function extractMermaidBlocks(markdown) {
  const lines = markdown.split(/\r\n|\r|\n/);
  const blocks = [];
  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (open) {
      const close = new RegExp(`^\\s{0,3}${open.char}{${open.length},}\\s*$`);
      if (close.test(line)) {
        blocks.push({
          code: open.body.join('\n'),
          startLine: open.startLine,
          fenceLine: open.fenceLine,
          info: open.info,
        });
        open = null;
        continue;
      }
      open.body.push(line);
      continue;
    }
    const fence = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)(.*)$/.exec(line);
    if (!fence) continue;
    const info = fence[3].toLowerCase();
    if (info !== 'mermaid') continue;
    open = {
      char: fence[2][0] === '`' ? '`' : '~',
      length: fence[2].length,
      body: [],
      startLine: index + 2,
      fenceLine: index + 1,
      info: (fence[3] + fence[4]).trim(),
    };
  }
  if (open) {
    blocks.push({
      code: open.body.join('\n'),
      startLine: open.startLine,
      fenceLine: open.fenceLine,
      info: open.info,
      unterminated: true,
    });
  }
  return blocks;
}

/** Parse the nth mermaid block of a markdown document. */
export function parseMarkdown(markdown, { blockIndex = 0 } = {}) {
  const blocks = extractMermaidBlocks(markdown);
  if (blocks.length === 0) {
    return {
      graph: createGraph(),
      diagnostics: [
        {
          severity: ERROR,
          line: 1,
          text: '',
          message: 'no fenced ```mermaid block was found in this markdown file.',
        },
      ],
      blocks,
      block: null,
    };
  }
  if (blockIndex < 0 || blockIndex >= blocks.length) {
    return {
      graph: createGraph(),
      diagnostics: [
        {
          severity: ERROR,
          line: 1,
          text: '',
          message: `block index ${blockIndex} was requested but the file has ${blocks.length}.`,
        },
      ],
      blocks,
      block: null,
    };
  }
  const block = blocks[blockIndex];
  const result = parseMermaid(block.code, { startLine: block.startLine });
  if (block.unterminated) {
    result.diagnostics.unshift({
      severity: ERROR,
      line: block.fenceLine,
      text: '',
      message: 'the mermaid fence opened here was never closed.',
    });
  }
  return { ...result, blocks, block };
}
