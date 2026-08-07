import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMermaid } from '../src/mermaid.js';
import { score } from '../src/score.js';
import { describeFinding, headlines, renderReport } from '../src/report.js';

function pair(referenceSource, attemptSource) {
  const reference = parseMermaid(referenceSource).graph;
  const attempt = parseMermaid(attemptSource).graph;
  return { reference, attempt, result: score(reference, attempt) };
}

test('a reversal is described as one relation being backwards', () => {
  const { reference, attempt, result } = pair(
    'graph TD\n  Hypothesis[Hypothesis] --> Experiment[Experiment]',
    'graph TD\n  Experiment[Experiment] --> Hypothesis[Hypothesis]',
  );
  const text = describeFinding(result.findings[0], reference, attempt);
  assert.match(text, /backwards/);
  assert.match(text, /Hypothesis --> Experiment/);
  assert.match(text, /not a missing link plus a spare one/);
});

test('the reversal wording names both directions, so it can be acted on', () => {
  const { reference, attempt, result } = pair(
    'graph TD\n  Rain -->|feeds| River',
    'graph TD\n  River -->|feeds| Rain',
  );
  const text = describeFinding(result.findings[0], reference, attempt);
  assert.match(text, /Rain --> River/);
  assert.match(text, /you drew River --> Rain/);
  assert.match(text, /feeds/);
});

test('a label only error is reported as the shape being right', () => {
  const { result } = pair(
    'graph LR\n  A -->|compiles to| B',
    'graph LR\n  A -->|objects| B',
  );
  const lines = headlines(result);
  assert.match(lines[0], /^Structure: correct/);
  assert.match(lines[1], /wording difference/);
});

test('a structural error is not reported as correct structure', () => {
  const { result } = pair('graph LR\n  A --> B\n  C', 'graph LR\n  A --> C\n  B');
  const lines = headlines(result);
  assert.match(lines[0], /^Structure: 2 edits away/);
  assert.equal(lines[1], 'Labels: correct.');
});

test('a perfect reconstruction reports zero and nothing else', () => {
  const { reference, attempt, result } = pair('graph TD\n  A --> B', 'graph TD\n  A --> B');
  const text = renderReport(result, reference, attempt);
  assert.match(text, /Distance 0/);
  assert.ok(!text.includes('backwards'));
});

test('the report states the algorithm, the complexity and whether it is exact', () => {
  const { reference, attempt, result } = pair(
    'graph TD\n  A[One] --> B[Two]',
    'graph TD\n  P[One] --> Q[Two]',
  );
  const text = renderReport(result, reference, attempt);
  assert.match(text, /algorithm  exact branch and bound/);
  assert.match(text, /complexity O\(n! \* E\)/);
  assert.match(text, /result     exact/);
});

test('an approximate report never says exact', () => {
  const chain = (prefix) => {
    const lines = ['graph TD'];
    for (let i = 1; i < 12; i += 1) lines.push(`  ${prefix}${i}[N${i}] --> ${prefix}${i + 1}[N${i + 1}]`);
    return lines.join('\n');
  };
  const { reference, attempt, result } = pair(chain('a'), chain('b'));
  const text = renderReport(result, reference, attempt);
  assert.match(text, /APPROXIMATE, upper bound/);
  assert.ok(!/result     exact/.test(text));
});

test('the report says node positions are not scored', () => {
  const { reference, attempt, result } = pair('graph TD\n  A --> B', 'graph TD\n  A --> B');
  assert.match(renderReport(result, reference, attempt), /Node positions are not scored/);
});

test('every finding type has wording', () => {
  const { reference, attempt, result } = pair(
    'graph TD\n  subgraph s [S]\n    A{Alpha} -.->|why| B((Beta))\n  end\n  B --- C\n  C --> D\n  D --> E',
    'graph TD\n  A[Alpha] --x|how| B((Beta))\n  B --> C\n  D --> C\n  E --> D\n  F',
  );
  const seen = new Set();
  for (const finding of result.findings) {
    const text = describeFinding(finding, reference, attempt);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 10, `${finding.type} produced ${JSON.stringify(text)}`);
    seen.add(finding.type);
  }
  assert.ok(seen.size >= 6, `only ${seen.size} finding types exercised: ${[...seen].join(', ')}`);
});

test('an unclassified finding type is a crash, not a blank line', () => {
  assert.throws(
    () => describeFinding({ type: 'invented' }, parseMermaid('graph TD\n A').graph, parseMermaid('graph TD\n A').graph),
    /no wording for finding type invented/,
  );
});
