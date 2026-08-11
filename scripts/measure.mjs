#!/usr/bin/env node
// Print what the scorer concluded about every fixture, deterministically, as numbers.
//
// This exists so the sabotage harness has an artefact that is a MEASUREMENT rather than a
// verdict. `recall fixtures` prints ok and FAIL, so using it for gate 2 would ask "did the
// output change" and "did a check notice" as the same question, and every sabotage would
// pass gate 2 for the same reason it passes gate 3. Raw buckets and findings keep the two
// apart: a sabotage has to move a number here before any detector is credited with catching
// it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMermaid } from '../src/mermaid.js';
import { score } from '../src/score.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/scoring.json'), 'utf8'));
const cases = Array.isArray(fixtures) ? fixtures : fixtures.cases;

let structural = 0;
for (const c of cases) {
  const reference = parseMermaid(c.reference).graph;
  const attempt = parseMermaid(c.attempt).graph;
  let result;
  try {
    result = score(reference, attempt, c.options ?? {});
  } catch (err) {
    console.log(`${c.name}\n  refused: ${err.constructor.name}`);
    continue;
  }
  const t = result.totals;
  console.log(c.name);
  console.log(
    `  structure=${t.structure} label=${t.label} style=${t.style} ` +
    `grouping=${t.grouping} total=${t.total}`);
  console.log(`  mode=${result.mode} exact=${result.exact} bound=${result.bound ?? 'none'}`);
  // Sorted so the fingerprint depends on the findings and never on their order.
  const findings = [...result.findings]
    .map((f) => `${f.type}:${f.id ?? ''}${f.from ?? ''}${f.to ?? ''}`)
    .sort();
  for (const f of findings) console.log(`    ${f}`);
  structural += t.total;
}
console.log(`\n${cases.length} scoring fixtures, ${structural} edits in total`);
