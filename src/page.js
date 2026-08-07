/**
 * Building docs/index.html.
 *
 * The page is generated rather than hand written, so the scorer running in the browser is
 * byte for byte the scorer the tests exercise. `verify.sh` rebuilds it and fails on a
 * difference, which is what stops the published page drifting away from the code.
 *
 * The bundler is sixty lines because it only has to handle code from this repository: it
 * concatenates the modules in dependency order into one scope, removes the import lines, and
 * removes the `export` keyword. It then checks that nothing survived and that no two modules
 * declare the same top level name, because a silent shadowing here would produce a page whose
 * behaviour differs from the tests for a reason nobody would look for.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
export const PAGE_PATH = path.join(ROOT, 'docs', 'index.html');

/** Dependency order. Every module may use names declared above it and none below. */
const MODULES = [
  'graph.js',
  'hungarian.js',
  'mermaid.js',
  'score.js',
  'report.js',
  'drill.js',
  'ui.js',
];

const IMPORT_LINE = /^import[\s\S]*?from\s+'[^']+';$/gm;
const EXPORT_KEYWORD = /^export\s+/gm;
const TOP_LEVEL_DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

function bundle() {
  const seen = new Map();
  const parts = [];
  for (const name of MODULES) {
    const source = readFileSync(path.join(here, name), 'utf8');
    for (const match of source.matchAll(TOP_LEVEL_DECLARATION)) {
      // Only column zero declarations share the bundle's scope.
      if (match.index > 0 && source[match.index - 1] !== '\n') continue;
      const declared = match[1];
      if (seen.has(declared)) {
        throw new Error(
          `${name} declares "${declared}" and so does ${seen.get(declared)}. The bundle puts ` +
            'every module in one scope, so this would be a redeclaration.',
        );
      }
      seen.set(declared, name);
    }
    const stripped = source.replace(IMPORT_LINE, '').replace(EXPORT_KEYWORD, '');
    if (/^\s*(import|export)\b/m.test(stripped)) {
      throw new Error(`${name} still contains an import or export after stripping`);
    }
    parts.push(`/* ---- src/${name} ---- */\n${stripped.trim()}\n`);
  }
  return parts.join('\n');
}

function loadSamples() {
  const dir = path.join(ROOT, 'fixtures', 'samples');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const markdown = readFileSync(path.join(dir, name), 'utf8');
      const heading = /^#\s+(.+)$/m.exec(markdown);
      return { name, title: heading ? heading[1] : name, markdown };
    });
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf7;
  --panel: #ffffff;
  --ink: #1b1c1e;
  --muted: #5c6066;
  --line: #d9d6cf;
  --accent: #7a3d10;
  --accent-soft: #f3e6da;
  --good: #1e6b3a;
  --bad: #97260f;
  --shadow: 0 1px 2px rgba(20, 18, 14, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a;
    --panel: #1e2024;
    --ink: #ecebe7;
    --muted: #a2a6ad;
    --line: #34373d;
    --accent: #e9a26a;
    --accent-soft: #33261b;
    --good: #82d3a0;
    --bad: #f2957a;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
}
/* The toggle wins over the media query in both directions, so choosing light on a dark
   system and dark on a light system both work. */
:root[data-theme='light'] {
  color-scheme: light;
  --bg: #fbfaf7;
  --panel: #ffffff;
  --ink: #1b1c1e;
  --muted: #5c6066;
  --line: #d9d6cf;
  --accent: #7a3d10;
  --accent-soft: #f3e6da;
  --good: #1e6b3a;
  --bad: #97260f;
  --shadow: 0 1px 2px rgba(20, 18, 14, 0.08);
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #16171a;
  --panel: #1e2024;
  --ink: #ecebe7;
  --muted: #a2a6ad;
  --line: #34373d;
  --accent: #e9a26a;
  --accent-soft: #33261b;
  --good: #82d3a0;
  --bad: #f2957a;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.55 ui-serif, Georgia, 'Iowan Old Style', serif;
  padding: 0 0 4rem;
}
.wrap { max-width: 62rem; margin: 0 auto; padding: 0 1rem; }
header.masthead {
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  padding: 1.5rem 0 1.25rem;
  margin-bottom: 1.5rem;
}
h1 { font-size: clamp(1.5rem, 5vw, 2.1rem); margin: 0 0 0.35rem; letter-spacing: -0.01em; }
h2 { font-size: 1.15rem; margin: 0 0 0.6rem; }
h3 { font-size: 1rem; margin: 1rem 0 0.4rem; }
p { margin: 0 0 0.75rem; }
.lede { color: var(--muted); max-width: 46rem; margin: 0; }
.muted { color: var(--muted); }
.ok { color: var(--good); }
.bad { color: var(--bad); }

section.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 1rem;
  margin: 0 0 1.25rem;
  box-shadow: var(--shadow);
}

.controls { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: flex-end; }
.field { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.field label { font: 600 0.78rem/1.3 ui-sans-serif, system-ui, sans-serif; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.05em; }
select, input[type='file'], textarea, button {
  font: 0.95rem/1.4 ui-sans-serif, system-ui, sans-serif;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.4rem 0.5rem;
  /* A select sizes itself to its widest option, which is a documented cause of sideways
     page scroll on a narrow screen. */
  max-width: 100%;
}
textarea { width: 100%; min-height: 7rem; font-family: ui-monospace, monospace; font-size: 0.85rem; }
button {
  cursor: pointer;
  background: var(--accent-soft);
  border-color: var(--accent);
  font-weight: 600;
}
button.small { padding: 0.15rem 0.45rem; font-size: 0.82rem; font-weight: 500; }
button:hover { background: var(--accent); color: var(--panel); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

.prose {
  white-space: pre-wrap;
  font-size: 0.98rem;
  max-height: 22rem;
  overflow-y: auto;
  border-left: 3px solid var(--line);
  padding-left: 0.9rem;
}

#board {
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px dashed var(--line);
  border-radius: 4px;
  padding: 0.5rem;
  background: var(--bg);
}
#board svg { display: block; max-width: none; }
.node rect, .node polygon, .node ellipse {
  fill: var(--panel);
  stroke: var(--accent);
  stroke-width: 1.6;
}
.node ellipse.inner, .node line.inner { fill: none; stroke: var(--accent); stroke-width: 1.1; }
.node:focus { outline: none; }
.node:focus-visible rect, .node:focus-visible polygon, .node:focus-visible ellipse {
  stroke-width: 3.4;
}
.node-label {
  font: 12px ui-sans-serif, system-ui, sans-serif;
  fill: var(--ink);
  pointer-events: none;
}
.edge { stroke: var(--ink); stroke-width: 1.7; }
.edge.kind-dotted { stroke-dasharray: 5 4; }
.edge.kind-thick { stroke-width: 3.6; }
.edges .head-arrow path, marker.head-arrow path { fill: var(--ink); }
marker.head-circle circle { fill: none; stroke: var(--ink); stroke-width: 1.5; }
marker.head-cross path { fill: none; stroke: var(--ink); stroke-width: 1.5; }
.edge-label {
  font: 11px ui-sans-serif, system-ui, sans-serif;
  fill: var(--muted);
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--bg);
  stroke-width: 3px;
}

ul.cards { list-style: none; padding: 0; margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.4rem; }
ul.cards .card {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.2rem 0.7rem;
  font: 0.85rem ui-sans-serif, system-ui, sans-serif;
  background: var(--accent-soft);
}
ul.cards .card.done { background: transparent; color: var(--muted); }

ul.placed { list-style: none; padding: 0; margin: 0.5rem 0 0; }
li.placement {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--line);
}
li.placement .relation { font-family: ui-monospace, monospace; font-size: 0.86rem; min-width: 0;
  overflow-wrap: anywhere; }
li.placement .actions { display: flex; gap: 0.35rem; flex: none; }

dl.scoreboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.6rem;
  margin: 0.75rem 0;
}
dl.scoreboard dt {
  font: 600 0.75rem ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  /* A grid item defaults to min-width auto, which lets a long word push the row wider than
     the page. */
  min-width: 0;
}
dl.scoreboard dd { margin: 0; min-width: 0; }
dl.scoreboard .num { font-size: 1.6rem; font-weight: 700; display: block; }
dl.scoreboard .num.ok { color: var(--good); }
dl.scoreboard .note { font-size: 0.78rem; color: var(--muted); }

.verdict { font-size: 1.05rem; }
.headline { border-left: 3px solid var(--accent); padding-left: 0.7rem; }
.reversals {
  border: 2px solid var(--accent);
  border-radius: 5px;
  padding: 0.75rem 0.9rem;
  margin: 0.9rem 0;
  background: var(--accent-soft);
}
.reversals h3 { margin-top: 0; }
ul.findings { margin: 0.3rem 0 0; padding-left: 1.2rem; }
ul.findings li { margin-bottom: 0.3rem; }

ul.diagnostics { list-style: none; padding: 0; margin: 0.4rem 0 0; font-size: 0.88rem; }
ul.diagnostics li { padding: 0.2rem 0; }
.sev {
  font: 600 0.7rem ui-sans-serif, system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 0.3rem;
}
.sev-error .sev { color: var(--bad); border-color: var(--bad); }
.sev-warning .sev { color: var(--accent); border-color: var(--accent); }

pre {
  overflow-x: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.7rem;
  font-size: 0.82rem;
  margin: 0;
}
details.method { margin-top: 1rem; font-size: 0.9rem; color: var(--muted); }
details.method summary { cursor: pointer; font-weight: 600; color: var(--ink); }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
footer { color: var(--muted); font-size: 0.85rem; margin-top: 2rem; }
footer a { color: var(--accent); }
`;

const BODY = `
<header class="masthead">
  <div class="wrap">
    <h1>Diagram recall</h1>
    <p class="lede">
      Read an explanation with its diagram taken away, then rebuild the diagram from a shuffled
      pile of pieces. The reconstruction is scored against the reference by graph edit distance,
      and a relation you drew the wrong way round is reported as one mistake with a name, not as
      a missing link plus a spare one.
    </p>
  </div>
</header>

<main class="wrap">
  <p class="sr-only" id="live" role="status" aria-live="polite"></p>

  <section class="panel">
    <h2>The document</h2>
    <div class="controls">
      <div class="field">
        <label for="sample">Built in example</label>
        <select id="sample"></select>
      </div>
      <div class="field">
        <label for="block-index">Which mermaid block</label>
        <select id="block-index"></select>
      </div>
      <div class="field">
        <label for="file">Or open a markdown file</label>
        <input type="file" id="file" accept=".md,.markdown,.mmd,.mermaid,text/markdown,text/plain">
      </div>
      <div class="field">
        <label for="theme">Theme</label>
        <select id="theme">
          <option value="system">Match the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </div>
    <p class="muted" style="margin-top:0.75rem">
      Loaded: <strong id="source-name">nothing yet</strong>. Any markdown file with a fenced
      mermaid flowchart in it will do. Nothing leaves this page.
    </p>
    <details>
      <summary>Paste markdown instead</summary>
      <label class="sr-only" for="paste">Markdown to load</label>
      <textarea id="paste" placeholder="# A heading&#10;&#10;Some prose.&#10;&#10;\`\`\`mermaid&#10;graph TD&#10;  A --> B&#10;\`\`\`"></textarea>
      <button type="button" id="paste-load">Load the pasted markdown</button>
    </details>
    <div id="diagnostics"></div>
  </section>

  <section class="panel" id="problems" hidden></section>

  <div id="drill" hidden>
    <section class="panel">
      <h2>Read this first</h2>
      <div class="prose" id="prose"></div>
    </section>

    <section class="panel">
      <h2>The pile</h2>
      <div id="pile"></div>
    </section>

    <section class="panel">
      <h2>Place a relation</h2>
      <p class="muted">
        This form is the whole answer. Everything below it can be done from the keyboard alone.
      </p>
      <div class="controls">
        <div class="field">
          <label for="edge-from">From</label>
          <select id="edge-from"></select>
        </div>
        <div class="field">
          <label for="edge-card">Using the card</label>
          <select id="edge-card"></select>
        </div>
        <div class="field">
          <label for="edge-to">To</label>
          <select id="edge-to"></select>
        </div>
        <button type="button" id="add-edge">Place it</button>
      </div>
      <h3>Placed so far</h3>
      <ul class="placed" id="placements"></ul>
      <div class="controls" style="margin-top:1rem">
        <button type="button" id="check">Check my reconstruction</button>
        <button type="button" id="reset">Clear everything</button>
        <button type="button" id="reveal">Show the reference</button>
      </div>
    </section>

    <section class="panel" id="result" hidden>
      <h2>Result</h2>
      <div id="result-body"></div>
    </section>

    <section class="panel" id="reference" hidden>
      <h2>The reference</h2>
      <pre id="reference-source"></pre>
    </section>

    <section class="panel">
      <h2>The board</h2>
      <p class="muted">
        Drag a node, or focus one with Tab and move it with the arrow keys. Where a node sits is
        not scored and cannot be: a graph has no canonical layout, so the same graph arranged
        differently is the same graph.
      </p>
      <div id="board"></div>
    </section>
  </div>

  <footer>
    <p>
      Distances use a unit cost model with an explicit edge reversal operation costing 1.
      Textbook graph edit distance has no reversal operation and charges 2 for the same
      mistake. When node identifiers are shared the correspondence is given and the distance is
      exact in O(V + E log E). When they are not, an exact branch and bound runs up to 8 nodes
      and the Riesen and Bunke bipartite heuristic runs above that, reported as an upper bound.
      Above 64 nodes the tool refuses rather than running for an unbounded time.
    </p>
    <p>
      Built for catalog task EDU-046.
      <a href="https://github.com/JesseRWeigel/diagram-recall">Source</a>.
    </p>
  </footer>
</main>
`;

export function renderPage() {
  const samples = loadSamples();
  const code = bundle();
  return `<!doctype html>
<html lang="en" data-ready="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagram recall: rebuild a mermaid diagram from memory</title>
<meta name="description" content="Read an explanation, then rebuild its mermaid diagram from a shuffled pile of pieces. Scored by graph edit distance, with reversed relations named as reversed.">
<style>${CSS}</style>
</head>
<body>
${BODY}
<script type="module">
${code}
const SAMPLES = ${JSON.stringify(samples)};
boot(SAMPLES);
</script>
</body>
</html>
`;
}

export function buildPage() {
  const html = renderPage();
  writeFileSync(PAGE_PATH, html, 'utf8');
  return Buffer.byteLength(html, 'utf8');
}

export function checkPage() {
  const expected = renderPage();
  let actual;
  try {
    actual = readFileSync(PAGE_PATH, 'utf8');
  } catch {
    return { ok: false, reason: 'docs/index.html does not exist. Run: node bin/recall.js build-page' };
  }
  if (actual === expected) return { ok: true };
  const limit = Math.min(actual.length, expected.length);
  let at = 0;
  while (at < limit && actual[at] === expected[at]) at += 1;
  const line = expected.slice(0, at).split('\n').length;
  return {
    ok: false,
    reason:
      `the committed page differs from a fresh build at line ${line} ` +
      `(committed ${actual.length} bytes, fresh ${expected.length}). ` +
      'Run: node bin/recall.js build-page',
  };
}
