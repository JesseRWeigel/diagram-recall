#!/usr/bin/env node
/**
 * diagram-recall command line.
 *
 *   recall parse <file.md> [--block N] [--json]
 *   recall drill <file.md> [--block N] [--seed S] [--json]
 *   recall score <reference.md> <attempt.md> [--mapping auto|identity|exact|approx] [--json]
 *   recall fixtures
 *   recall build-page [--check]
 *
 * Exit codes are the point. `parse` and `drill` exit nonzero when the diagram contains syntax
 * this parser cannot read, because scoring against a half read reference penalises the learner
 * for a gap in the tool.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { graphToJSON } from '../src/graph.js';
import { ERROR, parseMarkdown, parseMermaid } from '../src/mermaid.js';
import { buildDrill, DrillError } from '../src/drill.js';
import { GraphTooLarge, score } from '../src/score.js';
import { renderReport } from '../src/report.js';
import { runParsingFixtures, runScoringFixtures } from '../src/fixtures.js';
import { buildPage, checkPage } from '../src/page.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[name] = argv[i + 1];
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function readSource(file) {
  const text = readFileSync(file, 'utf8');
  // A bare .mmd file is a mermaid block with no markdown around it.
  if (/\.(mmd|mermaid)$/i.test(file)) {
    return { markdown: '```mermaid\n' + text + '\n```', wrapped: true };
  }
  return { markdown: text, wrapped: false };
}

function printDiagnostics(diagnostics) {
  if (diagnostics.length === 0) {
    process.stdout.write('diagnostics: none, every line was understood\n');
    return;
  }
  process.stdout.write(`diagnostics: ${diagnostics.length}\n`);
  for (const item of diagnostics) {
    process.stdout.write(
      `  ${item.severity.toUpperCase().padEnd(7)} line ${item.line}` +
        (item.text ? `: ${item.text}` : '') +
        `\n          ${item.message}\n`,
    );
  }
}

function loadGraph(file, blockIndex) {
  const { markdown } = readSource(file);
  const parsed = parseMarkdown(markdown, { blockIndex });
  return parsed;
}

function commandParse(positional, flags) {
  const [file] = positional;
  if (!file) throw new Error('usage: recall parse <file.md>');
  const blockIndex = Number(flags.block ?? 0);
  const parsed = loadGraph(file, blockIndex);
  const errors = parsed.diagnostics.filter((item) => item.severity === ERROR);
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          graph: graphToJSON(parsed.graph),
          diagnostics: parsed.diagnostics,
          blockCount: parsed.blocks.length,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`mermaid blocks in file: ${parsed.blocks.length}\n`);
    process.stdout.write(`reading block ${blockIndex}\n\n`);
    const json = graphToJSON(parsed.graph);
    process.stdout.write(`direction ${json.direction}\n`);
    process.stdout.write(`nodes ${json.nodes.length}\n`);
    for (const node of json.nodes) {
      process.stdout.write(
        `  ${node.id.padEnd(14)} ${node.shape.padEnd(16)} ${JSON.stringify(node.label)}` +
          (node.subgraph ? `  in ${node.subgraph}` : '') +
          '\n',
      );
    }
    process.stdout.write(`edges ${json.edges.length}\n`);
    for (const edge of json.edges) {
      process.stdout.write(
        `  ${edge.from} ${edge.kind}/${edge.head} ${edge.to}` +
          (edge.label ? `  ${JSON.stringify(edge.label)}` : '') +
          '\n',
      );
    }
    process.stdout.write('\n');
    printDiagnostics(parsed.diagnostics);
  }
  return errors.length ? 1 : 0;
}

function commandDrill(positional, flags) {
  const [file] = positional;
  if (!file) throw new Error('usage: recall drill <file.md>');
  const { markdown } = readSource(file);
  let drill;
  try {
    drill = buildDrill(markdown, {
      blockIndex: Number(flags.block ?? 0),
      seed: Number(flags.seed ?? 1),
    });
  } catch (error) {
    if (!(error instanceof DrillError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          prose: drill.prose,
          pile: drill.pile,
          diagnostics: drill.diagnostics,
          reference: graphToJSON(drill.reference),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write('Read this, then rebuild the diagram from the pile below.\n\n');
  process.stdout.write(`${drill.prose.trim()}\n\n`);
  process.stdout.write(`pile: ${drill.pile.nodes.length} nodes\n`);
  for (const card of drill.pile.nodes) {
    process.stdout.write(
      `  [${card.id}] ${JSON.stringify(card.label)} (${card.shape})` +
        (card.subgraph ? ` in ${card.subgraph}` : '') +
        '\n',
    );
  }
  process.stdout.write(`pile: ${drill.pile.relations.length} relations, endpoints withheld\n`);
  for (const card of drill.pile.relations) {
    process.stdout.write(
      `  (${card.cardId}) ${card.label ? JSON.stringify(card.label) : 'unlabelled'}` +
        ` ${card.kind}/${card.head}\n`,
    );
  }
  process.stdout.write('\n');
  printDiagnostics(drill.diagnostics);
  return 0;
}

function commandScore(positional, flags) {
  const [referenceFile, attemptFile] = positional;
  if (!referenceFile || !attemptFile) {
    throw new Error('usage: recall score <reference.md> <attempt.md>');
  }
  const referenceParsed = loadGraph(referenceFile, Number(flags.block ?? 0));
  const attemptParsed = loadGraph(attemptFile, Number(flags['attempt-block'] ?? 0));
  const blocking = [
    ...referenceParsed.diagnostics.filter((item) => item.severity === ERROR),
    ...attemptParsed.diagnostics.filter((item) => item.severity === ERROR),
  ];
  if (blocking.length && !flags.force) {
    process.stderr.write(
      'refusing to score: one of the diagrams contains syntax this parser cannot read, so\n' +
        'the comparison would be against an incomplete graph.\n',
    );
    for (const item of blocking) {
      process.stderr.write(`  line ${item.line}: ${item.text}\n    ${item.message}\n`);
    }
    process.stderr.write('Pass --force to score anyway, knowing the reference is incomplete.\n');
    return 1;
  }
  let result;
  try {
    result = score(referenceParsed.graph, attemptParsed.graph, {
      mapping: flags.mapping || 'auto',
    });
  } catch (error) {
    if (!(error instanceof GraphTooLarge)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${renderReport(result, referenceParsed.graph, attemptParsed.graph)}\n`,
    );
  }
  if (flags['require-perfect'] && !result.perfect) return 3;
  return 0;
}

function commandFixtures() {
  const parsing = runParsingFixtures();
  const scoring = runScoringFixtures();
  let failed = 0;
  process.stdout.write('parsing fixtures\n');
  for (const item of parsing) {
    if (item.failures.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${item.name}\n`);
      for (const failure of item.failures) process.stdout.write(`      ${failure}\n`);
    } else {
      process.stdout.write(`  ok    ${item.name}\n`);
    }
  }
  process.stdout.write('\nscoring fixtures\n');
  for (const item of scoring) {
    if (item.failures.length) {
      failed += 1;
      process.stdout.write(`  FAIL  ${item.name}\n`);
      for (const failure of item.failures) process.stdout.write(`      ${failure}\n`);
    } else {
      process.stdout.write(`  ok    ${item.name}\n`);
    }
  }
  const total = parsing.length + scoring.length;
  const zeroCase = scoring.find((item) => item.result && item.result.perfect);
  process.stdout.write('\n');
  if (!zeroCase) {
    process.stdout.write(
      'FAIL: no scoring fixture produced a distance of zero. A suite built only out of wrong\n' +
        '      answers is passed by a scorer that always reports an error, so the perfect\n' +
        '      reconstruction is the control that gives the rest of the suite its meaning.\n',
    );
    return 1;
  }
  if (failed) {
    process.stdout.write(`FAIL: ${failed} of ${total} fixture cases did not match\n`);
    return 1;
  }
  process.stdout.write(
    `${total}/${total} fixture cases match their hand computed expectations ` +
      `(${parsing.length} parsing, ${scoring.length} scoring, including the zero distance ` +
      'negative control)\n',
  );
  return 0;
}

function commandBuildPage(flags) {
  if (flags.check) {
    const result = checkPage();
    if (result.ok) {
      process.stdout.write('docs/index.html matches a fresh build\n');
      return 0;
    }
    process.stdout.write(`docs/index.html is stale: ${result.reason}\n`);
    return 1;
  }
  const bytes = buildPage();
  process.stdout.write(`wrote docs/index.html, ${bytes} bytes\n`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift();
  switch (command) {
    case 'parse':
      return commandParse(positional, flags);
    case 'drill':
      return commandDrill(positional, flags);
    case 'score':
      return commandScore(positional, flags);
    case 'fixtures':
      return commandFixtures();
    case 'build-page':
      return commandBuildPage(flags);
    default:
      process.stderr.write(
        'usage: recall <parse|drill|score|fixtures|build-page> [...]\n' +
          '  parse      <file.md> [--block N] [--json]\n' +
          '  drill      <file.md> [--block N] [--seed S] [--json]\n' +
          '  score      <reference.md> <attempt.md> [--mapping auto|identity|exact|approx]\n' +
          '  fixtures\n' +
          '  build-page [--check]\n',
      );
      return 64;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 70;
}

export { parseMermaid };
