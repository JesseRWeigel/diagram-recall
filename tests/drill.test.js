import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { graphToJSON } from '../src/graph.js';
import { attemptFromPlacements, buildDrill, DrillError, seededRandom, shuffle } from '../src/drill.js';
import { score } from '../src/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(here, '..', 'fixtures', 'samples');

function sample(name) {
  return readFileSync(path.join(SAMPLES, name), 'utf8');
}

function placeCorrectly(drill) {
  const reference = graphToJSON(drill.reference);
  const remaining = [...drill.pile.relations];
  return reference.edges.map((edge) => {
    const index = remaining.findIndex(
      (card) =>
        (card.label || null) === (edge.label || null) &&
        card.kind === edge.kind &&
        card.head === edge.head,
    );
    assert.notEqual(index, -1, `no card for ${JSON.stringify(edge)}`);
    const card = remaining.splice(index, 1)[0];
    return { from: edge.from, to: edge.to, kind: card.kind, head: card.head, label: card.label };
  });
}

test('every sample document builds a drill with no error diagnostics', () => {
  const names = readdirSync(SAMPLES).filter((name) => name.endsWith('.md'));
  assert.ok(names.length >= 3, 'the sample corpus should have at least three documents');
  for (const name of names) {
    const drill = buildDrill(sample(name));
    assert.deepEqual(
      drill.diagnostics.filter((item) => item.severity === 'error'),
      [],
      name,
    );
    assert.ok(drill.pile.nodes.length >= 5, name);
    assert.equal(drill.pile.relations.length, drill.reference.edges.length, name);
  }
});

test('replaying a drill perfectly scores zero, for every sample', () => {
  // The negative control for the drill layer. Without it, a scorer that always found
  // something wrong would pass every other test in this file.
  for (const name of readdirSync(SAMPLES).filter((item) => item.endsWith('.md'))) {
    const drill = buildDrill(sample(name));
    const attempt = attemptFromPlacements(drill.pile, placeCorrectly(drill));
    const result = score(drill.reference, attempt);
    assert.equal(result.totals.total, 0, `${name}: ${JSON.stringify(result.findings)}`);
    assert.equal(result.perfect, true, name);
  }
});

test('turning one directed relation round costs exactly one structural edit', () => {
  const drill = buildDrill(sample('photosynthesis.md'));
  const placements = placeCorrectly(drill);
  const index = placements.findIndex((placement) => placement.head !== 'open');
  const flipped = placements.map((placement, i) =>
    i === index ? { ...placement, from: placement.to, to: placement.from } : placement,
  );
  const result = score(drill.reference, attemptFromPlacements(drill.pile, flipped));
  assert.deepEqual(result.totals, { structure: 1, label: 0, style: 0, grouping: 0, total: 1 });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].type, 'edge-reversed');
});

test('the relation cards withhold the endpoints and the direction', () => {
  const drill = buildDrill(sample('photosynthesis.md'));
  for (const card of drill.pile.relations) {
    assert.deepEqual(Object.keys(card).sort(), ['cardId', 'directed', 'head', 'kind', 'label']);
    assert.equal(card.from, undefined);
    assert.equal(card.to, undefined);
  }
});

test('the prose has the diagram removed and the rest kept', () => {
  const markdown = sample('photosynthesis.md');
  const drill = buildDrill(markdown);
  assert.ok(!drill.prose.includes('```mermaid'));
  assert.ok(!drill.prose.includes('Calvin cycle]'));
  assert.ok(drill.prose.includes('Photosynthesis is two linked stages'));
  assert.ok(drill.prose.includes('Three details in that diagram'));
});

test('the shuffle is seeded, so the same seed gives the same pile', () => {
  const markdown = sample('build-pipeline.md');
  const a = buildDrill(markdown, { seed: 42 });
  const b = buildDrill(markdown, { seed: 42 });
  const c = buildDrill(markdown, { seed: 43 });
  assert.deepEqual(a.pile, b.pile);
  assert.notDeepEqual(
    a.pile.nodes.map((card) => card.id),
    c.pile.nodes.map((card) => card.id),
  );
});

test('the shuffle actually moves things', () => {
  const items = Array.from({ length: 30 }, (_, i) => i);
  const shuffled = shuffle(items, seededRandom(5));
  assert.equal(shuffled.length, items.length);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), items);
  assert.notDeepEqual(shuffled, items);
});

test('a drill is refused when the diagram contains syntax the parser cannot read', () => {
  const markdown = '# T\n\n```mermaid\ngraph TD\n  A --> B\n  A@{ shape: rect }\n```\n';
  assert.throws(
    () => buildDrill(markdown),
    (error) => {
      assert.ok(error instanceof DrillError);
      assert.match(error.message, /marks them down for a gap in this tool/);
      assert.match(error.message, /line 6/);
      return true;
    },
  );
});

test('allowErrors builds anyway, for a caller that knows what it is accepting', () => {
  const markdown = '# T\n\n```mermaid\ngraph TD\n  A --> B\n  A@{ shape: rect }\n```\n';
  const drill = buildDrill(markdown, { allowErrors: true });
  assert.equal(drill.pile.relations.length, 1);
  assert.equal(drill.diagnostics.filter((item) => item.severity === 'error').length, 1);
});

test('a placement naming a node that is not in the pile is refused', () => {
  const drill = buildDrill(sample('photosynthesis.md'));
  assert.throws(
    () => attemptFromPlacements(drill.pile, [{ from: 'Nope', to: 'Light' }]),
    DrillError,
  );
});

test('leaving a node card unused makes it a missing node', () => {
  const drill = buildDrill(sample('photosynthesis.md'));
  const keep = drill.pile.nodes.slice(1).map((card) => card.id);
  const dropped = drill.pile.nodes[0].id;
  const placements = placeCorrectly(drill).filter(
    (placement) => placement.from !== dropped && placement.to !== dropped,
  );
  const attempt = attemptFromPlacements(drill.pile, placements, { include: keep });
  const result = score(drill.reference, attempt);
  assert.ok(result.findings.some((finding) => finding.type === 'node-missing'));
});

test('a second mermaid block can be chosen', () => {
  const markdown = [
    '# Two diagrams',
    '',
    '```mermaid',
    'graph TD',
    '  A --> B',
    '```',
    '',
    '```mermaid',
    'graph LR',
    '  C --> D',
    '  D --> E',
    '```',
  ].join('\n');
  const first = buildDrill(markdown, { blockIndex: 0 });
  const second = buildDrill(markdown, { blockIndex: 1 });
  assert.equal(first.blockCount, 2);
  assert.equal(first.pile.relations.length, 1);
  assert.equal(second.pile.relations.length, 2);
  assert.ok(second.prose.includes('graph TD'), 'the block not under drill stays in the prose');
});

test('any markdown file with a mermaid block works, including one written from scratch', () => {
  const markdown = [
    '# An arbitrary document',
    '',
    'Words about a thing.',
    '',
    '```mermaid',
    'flowchart LR',
    '  Intake([Intake]) -->|triage| Queue[(Queue)]',
    '  Queue --> Worker{Worker}',
    '  Worker -.->|retry| Queue',
    '  Worker ==> Done((Done))',
    '```',
    '',
    'More words.',
  ].join('\n');
  const drill = buildDrill(markdown);
  assert.equal(drill.pile.nodes.length, 4);
  assert.equal(drill.pile.relations.length, 4);
  const attempt = attemptFromPlacements(drill.pile, placeCorrectly(drill));
  assert.equal(score(drill.reference, attempt).totals.total, 0);
});
