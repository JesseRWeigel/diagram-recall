import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMermaid } from '../src/mermaid.js';
import { GraphTooLarge, LIMITS, score, tallyFindings, diffUnderMapping } from '../src/score.js';
import { runScoringFixtures } from '../src/fixtures.js';

function graph(source) {
  const { graph: parsed, diagnostics } = parseMermaid(source);
  const errors = diagnostics.filter((item) => item.severity === 'error');
  assert.deepEqual(errors, [], `fixture source did not parse: ${JSON.stringify(errors)}`);
  return parsed;
}

function totals(reference, attempt, options) {
  return score(graph(reference), graph(attempt), options).totals;
}

function types(reference, attempt, options) {
  return score(graph(reference), graph(attempt), options)
    .findings.map((finding) => finding.type)
    .sort();
}

test('the scoring fixture corpus matches its hand computed distances', () => {
  for (const item of runScoringFixtures()) {
    assert.deepEqual(item.failures, [], `${item.name}\n${item.failures.join('\n')}`);
  }
});

test('a graph scored against itself is distance zero', () => {
  const sources = [
    'graph TD\n  A --> B',
    'flowchart LR\n  subgraph s [S]\n    A{Q} -.->|why| B((R))\n  end\n  B ==> C',
    'graph TD\n  A --- B\n  B --o C\n  C --x A',
  ];
  for (const source of sources) {
    const result = score(graph(source), graph(source));
    assert.equal(result.totals.total, 0, source);
    assert.equal(result.perfect, true);
    assert.deepEqual(result.findings, []);
  }
});

test('statement order and node declaration order do not matter', () => {
  const a = 'graph TD\n  A --> B\n  B --> C\n  C --> A';
  const b = 'graph TD\n  C --> A\n  A --> B\n  B --> C';
  assert.equal(score(graph(a), graph(b)).totals.total, 0);
});

test('the graph direction is not scored, since it is a layout hint', () => {
  assert.equal(score(graph('graph TD\n  A --> B'), graph('flowchart LR\n  A --> B')).totals.total, 0);
});

test('a reversal is one structural edit, and reported once', () => {
  const result = score(graph('graph TD\n  A --> B'), graph('graph TD\n  B --> A'));
  assert.deepEqual(result.totals, { structure: 1, label: 0, style: 0, grouping: 0, total: 1 });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].type, 'edge-reversed');
  assert.equal(result.findings[0].from, 'A');
  assert.equal(result.findings[0].to, 'B');
});

test('the reversal is charged 1, where textbook edit distance would charge 2', () => {
  const result = score(graph('graph TD\n  A --> B'), graph('graph TD\n  B --> A'));
  assert.equal(result.costModel.reversalCost, 1);
  assert.equal(result.costModel.textbookReversalCost, 2);
});

test('an opposing link added to a correct one is extra, not a reversal', () => {
  assert.deepEqual(types('graph TD\n  A --> B', 'graph TD\n  A --> B\n  B --> A'), ['edge-extra']);
});

test('one side dropped from a two way pair is missing, not a reversal', () => {
  assert.deepEqual(types('graph TD\n  A --> B\n  B --> A', 'graph TD\n  A --> B'), [
    'edge-missing',
  ]);
});

test('a two way pair reconstructed as a two way pair is correct', () => {
  assert.equal(
    score(graph('graph TD\n  A --> B\n  B --> A'), graph('graph TD\n  B --> A\n  A --> B')).totals
      .total,
    0,
  );
});

test('a self loop is preserved and cannot be reversed', () => {
  assert.equal(score(graph('graph TD\n  A --> A'), graph('graph TD\n  A --> A')).totals.total, 0);
  assert.deepEqual(types('graph TD\n  A --> A\n  A --> B', 'graph TD\n  A --> B'), [
    'edge-missing',
  ]);
});

test('structure and label are separate buckets', () => {
  const labelOnly = totals(
    'graph LR\n  A -->|one| B',
    'graph LR\n  A -->|two| B',
  );
  assert.deepEqual(labelOnly, { structure: 0, label: 1, style: 0, grouping: 0, total: 1 });

  // Same three nodes, one relation joined to the wrong one. The shape is wrong and no wording
  // is, which is the opposite result from the case above and must not be scored the same way.
  const structureOnly = totals('graph LR\n  A --> B\n  C', 'graph LR\n  A --> C\n  B');
  assert.deepEqual(structureOnly, {
    structure: 2,
    label: 0,
    style: 0,
    grouping: 0,
    total: 2,
  });
});

test('node shape and line style are style, never structure', () => {
  const result = totals('graph TD\n  A{Q} ==> B', 'graph TD\n  A[Q] --> B');
  assert.deepEqual(result, { structure: 0, label: 0, style: 2, grouping: 0, total: 2 });
});

test('an arrow head decoration is style and directedness is structure', () => {
  assert.deepEqual(totals('graph TD\n  A --> B', 'graph TD\n  A --x B'), {
    structure: 0,
    label: 0,
    style: 1,
    grouping: 0,
    total: 1,
  });
  assert.deepEqual(totals('graph TD\n  A --- B', 'graph TD\n  A --> B'), {
    structure: 1,
    label: 0,
    style: 0,
    grouping: 0,
    total: 1,
  });
});

test('two links between the same pair are matched by label, not arbitrarily', () => {
  const reference = 'graph TD\n  A -->|first| B\n  A -->|second| B';
  const attempt = 'graph TD\n  A -->|second| B\n  A -->|first| B';
  assert.equal(score(graph(reference), graph(attempt)).totals.total, 0);
});

test('a subgraph a node does not belong to is grouping, not structure', () => {
  const reference = 'graph TD\n  subgraph one\n    A\n  end\n  subgraph two\n    B\n  end\n  A --> B';
  const attempt = 'graph TD\n  subgraph one\n    A\n    B\n  end\n  subgraph two\n    Z\n  end\n  A --> B';
  const result = score(graph(reference), graph(attempt));
  assert.equal(result.totals.grouping, 1);
  assert.equal(result.totals.structure, 1); // the spare node Z
});

test('identity is used when the attempt only uses reference identifiers', () => {
  const result = score(graph('graph TD\n  A --> B\n  B --> C'), graph('graph TD\n  A --> B'));
  assert.equal(result.mode, 'identity');
  assert.equal(result.exact, true);
  assert.equal(result.complexity, 'O(V + E log E)');
});

test('renamed nodes trigger the exact search and it is reported as exact', () => {
  const result = score(
    graph('graph TD\n  A[One] --> B[Two]'),
    graph('graph TD\n  P[One] --> Q[Two]'),
  );
  assert.equal(result.mode, 'exact');
  assert.equal(result.exact, true);
  assert.equal(result.bound, 'exact');
  assert.equal(result.totals.total, 0);
  assert.match(result.complexity, /O\(n! \* E\)/);
});

test('the exact search really minimises, not merely matches names in order', () => {
  // The best correspondence pairs B with X and A with Y, which is the reverse of the order the
  // nodes are declared in. A search that walked them in order would report 2 instead of 0.
  const reference = 'graph TD\n  A[Alpha] --> B[Beta]';
  const attempt = 'graph TD\n  Y[Beta]\n  X[Alpha] --> Y';
  assert.equal(score(graph(reference), graph(attempt)).totals.total, 0);
});

test('above the exact cap the answer is labelled an upper bound', () => {
  const chain = (prefix, count) => {
    const lines = ['graph TD'];
    for (let i = 1; i < count; i += 1) {
      lines.push(`  ${prefix}${i}[N${i}] --> ${prefix}${i + 1}[N${i + 1}]`);
    }
    return lines.join('\n');
  };
  const result = score(graph(chain('a', 12)), graph(chain('b', 12)));
  assert.equal(result.mode, 'approx');
  assert.equal(result.exact, false);
  assert.equal(result.bound, 'upper');
  assert.equal(result.complexity, 'O(n^3)');
  assert.match(result.algorithm, /Riesen and Bunke/);
  // The heuristic still finds the perfect correspondence here, and an upper bound of zero
  // pins the true distance at zero.
  assert.equal(result.totals.total, 0);
});

test('the approximation never claims to be exact', () => {
  const wide = (prefix) => {
    const lines = ['graph TD'];
    for (let i = 1; i <= 20; i += 1) lines.push(`  ${prefix}hub --> ${prefix}${i}[leaf${i}]`);
    return lines.join('\n');
  };
  const result = score(graph(wide('a')), graph(wide('b')), { mapping: 'approx' });
  assert.equal(result.exact, false);
  assert.equal(result.bound, 'upper');
  assert.ok(result.note.length > 0);
});

test('an approximate distance is never below the identity distance for the same graphs', () => {
  // An upper bound that came out below a real edit script would mean the bound is wrong.
  const reference = graph('graph TD\n  A --> B\n  B --> C\n  C --> D\n  D --> A');
  const attempt = graph('graph TD\n  A --> B\n  C --> B\n  C --> D\n  D --> A');
  const identity = score(reference, attempt, { mapping: 'identity' }).totals.total;
  const approx = score(reference, attempt, { mapping: 'approx' }).totals.total;
  assert.ok(approx >= identity, `approx ${approx} came out below identity ${identity}`);
});

test('a graph above the hard cap is refused rather than run for an unbounded time', () => {
  const huge = (prefix) => {
    const lines = ['graph TD'];
    for (let i = 1; i <= LIMITS.approxNodes + 5; i += 1) lines.push(`  ${prefix}${i}`);
    return lines.join('\n');
  };
  assert.throws(
    () => score(graph(huge('a')), graph(huge('b'))),
    (error) => {
      assert.ok(error instanceof GraphTooLarge);
      assert.match(error.message, /NP-hard/);
      assert.equal(error.limit, LIMITS.approxNodes);
      return true;
    },
  );
});

test('the cap does not fire when the identifiers are shared, however large the graph', () => {
  const huge = () => {
    const lines = ['graph TD'];
    for (let i = 1; i <= LIMITS.approxNodes + 40; i += 1) lines.push(`  n${i} --> n${i + 1}`);
    return lines.join('\n');
  };
  const result = score(graph(huge()), graph(huge()));
  assert.equal(result.mode, 'identity');
  assert.equal(result.totals.total, 0);
});

test('an explicit mapping mode is honoured even when auto would choose another', () => {
  const reference = graph('graph TD\n  A[One] --> B[Two]');
  const attempt = graph('graph TD\n  P[One] --> Q[Two]');
  const forced = score(reference, attempt, { mapping: 'identity' });
  assert.equal(forced.mode, 'identity');
  assert.equal(forced.totals.total, 6);
  assert.ok(forced.note.includes('identity correspondence was requested'));
});

test('findings are exhaustive: every finding falls into exactly one bucket', () => {
  const reference = graph(
    'graph TD\n  subgraph s [S]\n    A{Alpha} -.->|why| B((Beta))\n  end\n  B --- C\n  C --> D',
  );
  const attempt = graph(
    'graph TD\n  A[Alpha] -->|how| B((Beta))\n  B --> C\n  D --> C\n  E',
  );
  const result = score(reference, attempt);
  assert.equal(tallyFindings(result.findings).total, result.findings.length);
  assert.equal(
    result.totals.structure + result.totals.label + result.totals.style + result.totals.grouping,
    result.totals.total,
  );
});

test('diffUnderMapping is symmetric in the sense that swapping the arguments swaps the roles', () => {
  const a = graph('graph TD\n  A --> B\n  B --> C');
  const b = graph('graph TD\n  A --> B');
  const mapping = new Map([['A', 'A'], ['B', 'B']]);
  const forward = diffUnderMapping(a, b, mapping).map((finding) => finding.type).sort();
  const backward = diffUnderMapping(b, a, mapping).map((finding) => finding.type).sort();
  assert.deepEqual(forward, ['edge-missing', 'node-missing']);
  assert.deepEqual(backward, ['edge-extra', 'node-extra']);
});

test('an empty attempt costs one edit per node plus one per link', () => {
  const reference = graph('graph TD\n  A --> B\n  B --> C');
  const empty = graph('graph TD\n  Z');
  const result = score(reference, empty, { mapping: 'identity' });
  assert.equal(result.totals.structure, 3 + 2 + 1);
});
