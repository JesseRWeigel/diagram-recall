/**
 * Running the fixture corpus.
 *
 * The fixtures hold hand computed answers. This module compares the implementation to them and
 * reports every difference. It never rewrites a fixture, because a suite that updates its own
 * expectations agrees with whatever the code currently does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { graphToJSON, nodeLabel, nodeShape, subgraphPath } from './graph.js';
import { parseMermaid } from './mermaid.js';
import { score } from './score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, '..', 'fixtures');

export function loadFixtures(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function nodeSignature(graph, node) {
  const group = subgraphPath(graph, node).join('/');
  return [node.id, nodeShape(node), nodeLabel(node), group].filter((part) => part !== '').join(' ');
}

function edgeSignature(edge) {
  const parts = [edge.from, edge.kind, edge.head, edge.to];
  if (edge.label) parts.push(edge.label);
  return parts.join(' ');
}

function compareLists(what, actual, expected, failures) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) === JSON.stringify(right)) return;
  failures.push(`${what}\n      expected ${JSON.stringify(right)}\n      actual   ${JSON.stringify(left)}`);
}

export function runParsingFixtures() {
  const data = loadFixtures('parsing.json');
  const results = [];
  for (const testCase of data.cases) {
    const failures = [];
    const { graph, diagnostics } = parseMermaid(testCase.source);
    const json = graphToJSON(graph);
    if (json.direction !== testCase.expect.direction) {
      failures.push(`direction expected ${testCase.expect.direction}, actual ${json.direction}`);
    }
    compareLists(
      'nodes',
      [...graph.nodes.values()].map((node) => nodeSignature(graph, node)),
      testCase.expect.nodes,
      failures,
    );
    compareLists('edges', graph.edges.map(edgeSignature), testCase.expect.edges, failures);

    const expectedDiagnostics = testCase.expect.diagnostics || [];
    if (diagnostics.length !== expectedDiagnostics.length) {
      failures.push(
        `diagnostic count expected ${expectedDiagnostics.length}, actual ${diagnostics.length}` +
          `\n      actual   ${JSON.stringify(diagnostics.map((d) => `${d.severity} line ${d.line}: ${d.message}`), null, 0)}`,
      );
    } else {
      for (let i = 0; i < expectedDiagnostics.length; i += 1) {
        const want = expectedDiagnostics[i];
        const got = diagnostics[i];
        if (got.severity !== want.severity) {
          failures.push(`diagnostic ${i} severity expected ${want.severity}, actual ${got.severity}`);
        }
        if (want.line !== undefined && got.line !== want.line) {
          failures.push(`diagnostic ${i} line expected ${want.line}, actual ${got.line}`);
        }
        if (want.contains && !got.message.includes(want.contains)) {
          failures.push(
            `diagnostic ${i} message should contain ${JSON.stringify(want.contains)}` +
              `\n      actual   ${JSON.stringify(got.message)}`,
          );
        }
      }
    }
    results.push({ name: testCase.name, failures });
  }
  return results;
}

/** Does an actual finding satisfy the fixture's partial description of it? */
function findingMatches(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function runScoringFixtures() {
  const data = loadFixtures('scoring.json');
  const results = [];
  for (const testCase of data.cases) {
    const failures = [];
    const reference = parseMermaid(testCase.reference).graph;
    const attempt = parseMermaid(testCase.attempt).graph;
    let result = null;
    try {
      result = score(reference, attempt, testCase.options || {});
    } catch (error) {
      failures.push(`score() threw: ${error.message}`);
      results.push({ name: testCase.name, failures, result: null });
      continue;
    }
    for (const bucket of ['structure', 'label', 'style', 'grouping', 'total']) {
      if (result.totals[bucket] !== testCase.expect[bucket]) {
        failures.push(
          `${bucket} expected ${testCase.expect[bucket]}, actual ${result.totals[bucket]}`,
        );
      }
    }
    if (testCase.expect.exact !== undefined && result.exact !== testCase.expect.exact) {
      failures.push(`exact expected ${testCase.expect.exact}, actual ${result.exact}`);
    }
    if (testCase.expect.mode !== undefined && result.mode !== testCase.expect.mode) {
      failures.push(`mode expected ${testCase.expect.mode}, actual ${result.mode}`);
    }
    const wanted = testCase.expect.findings || [];
    for (const want of wanted) {
      if (!result.findings.some((finding) => findingMatches(finding, want))) {
        failures.push(
          `expected a finding ${JSON.stringify(want)}` +
            `\n      actual   ${JSON.stringify(result.findings)}`,
        );
      }
    }
    if (wanted.length === 0 && result.findings.length !== 0) {
      failures.push(`expected no findings, actual ${JSON.stringify(result.findings)}`);
    }
    results.push({ name: testCase.name, failures, result });
  }
  return results;
}

/**
 * The headline number the independent Python check recomputes by a different route: the sum of
 * the structural edits across every scoring fixture.
 */
export function totalStructuralEdits() {
  let total = 0;
  for (const testCase of loadFixtures('scoring.json').cases) {
    const reference = parseMermaid(testCase.reference).graph;
    const attempt = parseMermaid(testCase.attempt).graph;
    total += score(reference, attempt, testCase.options || {}).totals.structure;
  }
  return total;
}
