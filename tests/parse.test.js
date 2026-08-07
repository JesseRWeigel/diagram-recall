import test from 'node:test';
import assert from 'node:assert/strict';

import { graphToJSON } from '../src/graph.js';
import {
  ERROR,
  INFO,
  WARNING,
  extractMermaidBlocks,
  normaliseLabel,
  parseMarkdown,
  parseMermaid,
} from '../src/mermaid.js';
import { runParsingFixtures } from '../src/fixtures.js';

function parse(source) {
  const { graph, diagnostics } = parseMermaid(source);
  return { json: graphToJSON(graph), diagnostics };
}

test('the parsing fixture corpus matches', () => {
  for (const item of runParsingFixtures()) {
    assert.deepEqual(item.failures, [], `${item.name}\n${item.failures.join('\n')}`);
  }
});

test('a header with no direction defaults to TB', () => {
  assert.equal(parse('flowchart\n  A --> B').json.direction, 'TB');
});

test('a link operator can be any length', () => {
  const { json } = parse('graph TD\n  A ------> B\n  C -------- D\n  E -...-> F\n  G =====> H');
  assert.deepEqual(
    json.edges.map((edge) => `${edge.from} ${edge.kind}/${edge.head} ${edge.to}`),
    ['A solid/arrow B', 'C solid/open D', 'E dotted/arrow F', 'G thick/arrow H'],
  );
});

test('a hyphen inside a node id is kept and a link operator still ends it', () => {
  const { json, diagnostics } = parse('graph TD\n  node-one-->node-two');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(json.nodes.map((node) => node.id), ['node-one', 'node-two']);
});

test('a quoted caption may contain the closing delimiter', () => {
  const { json } = parse('graph TD\n  A["a ] bracket"] --> B');
  assert.equal(json.nodes[0].label, 'a ] bracket');
});

test('a quoted mid link label may contain the closing operator', () => {
  const { json } = parse('graph TD\n  A -- "not --> an arrow" --> B');
  assert.equal(json.edges[0].label, 'not --> an arrow');
});

test('a caption declared once is remembered when the node is mentioned again', () => {
  const { json } = parse('graph TD\n  A[Named] --> B\n  B --> A');
  assert.equal(json.nodes.find((node) => node.id === 'A').label, 'Named');
});

test('whitespace inside a caption is collapsed', () => {
  assert.equal(normaliseLabel('  two   words  '), 'two words');
});

test('a statement that cannot be read is an error and the rest of the block still parses', () => {
  const { json, diagnostics } = parse('graph TD\n  A --> B\n  ???\n  C --> D');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, ERROR);
  assert.equal(diagnostics[0].line, 3);
  assert.equal(json.edges.length, 2);
});

test('an unknown statement is never silently dropped', () => {
  // The whole point. A parser that drops what it does not understand produces a reference
  // graph that is missing links, and the learner is then marked down for the tool's gap.
  const cases = [
    'graph TD\n  A e1@--> B',
    'graph TD\n  A@{ shape: rect }',
    'graph TD\n  A ~~~ B',
    'graph TD\n  A -+- B',
  ];
  for (const source of cases) {
    const { diagnostics } = parse(source);
    assert.ok(
      diagnostics.some((item) => item.severity === ERROR),
      `no error diagnostic for ${JSON.stringify(source)}`,
    );
  }
});

test('presentation directives are reported at info level, not dropped', () => {
  const { diagnostics } = parse('graph TD\n  A --> B\n  style A fill:#fff');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, INFO);
});

test('a node id that begins with a presentation keyword is still a node', () => {
  const { json, diagnostics } = parse('graph TD\n  class --> style\n  clicks --> B');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(json.nodes.map((node) => node.id).sort(), ['B', 'class', 'clicks', 'style']);
});

test('a bidirectional link warns and produces both directions', () => {
  const { json, diagnostics } = parse('graph TD\n  A <--> B');
  assert.equal(json.edges.length, 2);
  assert.equal(diagnostics.filter((item) => item.severity === WARNING).length, 1);
});

test('markdown extraction finds every fenced mermaid block in order', () => {
  const markdown = [
    '# Title',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    'Some prose with ```inline``` in it.',
    '',
    '~~~mermaid',
    'flowchart LR',
    '  C --> D',
    '~~~',
    '',
    '```js',
    'const notMermaid = true;',
    '```',
  ].join('\n');
  const blocks = extractMermaidBlocks(markdown);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].code, /A --> B/);
  assert.match(blocks[1].code, /C --> D/);
});

test('diagnostic line numbers point at the markdown file, not the extracted block', () => {
  const markdown = ['# Title', '', 'prose', '', '```mermaid', 'graph TD', '  ???', '```'].join(
    '\n',
  );
  const parsed = parseMarkdown(markdown);
  const errors = parsed.diagnostics.filter((item) => item.severity === ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 7);
});

test('a markdown file with no mermaid block is an error, not an empty graph', () => {
  const parsed = parseMarkdown('# Nothing here\n\nJust words.\n');
  assert.equal(parsed.diagnostics.filter((item) => item.severity === ERROR).length, 1);
});

test('an unterminated fence is reported', () => {
  const parsed = parseMarkdown('# T\n\n```mermaid\ngraph TD\n  A --> B\n');
  assert.ok(
    parsed.diagnostics.some(
      (item) => item.severity === ERROR && item.message.includes('never closed'),
    ),
  );
});

test('a mermaid fence indented inside a list item is still found', () => {
  const markdown = ['- a list item', '', '  ```mermaid', '  graph TD', '    A --> B', '  ```'].join(
    '\n',
  );
  assert.equal(extractMermaidBlocks(markdown).length, 1);
});

test('CRLF line endings parse the same as LF', () => {
  const lf = parse('graph TD\n  A[One] --> B\n  B --> C');
  const crlf = parse('graph TD\r\n  A[One] --> B\r\n  B --> C');
  assert.deepEqual(crlf.json, lf.json);
  assert.deepEqual(crlf.diagnostics, lf.diagnostics);
});

test('no source file in src/ contains a NUL byte', async () => {
  // A file holding a NUL is classified as binary by git and grep, and `grep -I` then skips it
  // entirely, so a privacy scan reports the same "clean" for a file it never opened.
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = (await import('node:path')).default;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  for (const name of readdirSync(dir)) {
    const bytes = readFileSync(path.join(dir, name));
    assert.equal(bytes.includes(0), false, `${name} contains a NUL byte`);
  }
});
