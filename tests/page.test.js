import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PAGE_PATH, checkPage, renderPage } from '../src/page.js';
import { hungarian } from '../src/hungarian.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

test('the committed page matches a fresh build', () => {
  const result = checkPage();
  assert.equal(result.ok, true, result.reason);
});

test('the page carries the scorer, not a second copy of it', () => {
  const html = renderPage();
  const score = readFileSync(path.join(SRC, 'score.js'), 'utf8');
  // A distinctive line from the reversal pass. If the page were hand written or bundled from
  // a stale copy, this would drift.
  const marker = "type: 'edge-reversed',";
  assert.ok(score.includes(marker));
  assert.ok(html.includes(marker));
});

test('the bundle contains no surviving import or export statement', () => {
  const html = renderPage();
  const script = html.slice(html.indexOf('<script type="module">'));
  assert.ok(!/^\s*import\s/m.test(script), 'an import survived the bundle');
  assert.ok(!/^\s*export\s/m.test(script), 'an export survived the bundle');
});

test('the page is self contained: no external stylesheet, script or image', () => {
  const html = renderPage();
  assert.ok(!/<link[^>]+stylesheet/i.test(html));
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/https?:\/\/[^"']*\.(js|css|woff2?|png|jpg|svg)/i.test(html));
});

test('the page never uses body overflow-x hidden', () => {
  // It masks real overflow and makes the scrollWidth probe in the browser check vacuous.
  const html = renderPage();
  assert.ok(!/overflow-x:\s*hidden/i.test(html), 'overflow-x: hidden is in the stylesheet');
});

test('both themes are declared and the toggle overrides the media query both ways', () => {
  const html = renderPage();
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /:root\[data-theme='light'\]/);
  assert.match(html, /:root\[data-theme='dark'\]/);
  const mediaAt = html.indexOf('@media (prefers-color-scheme: dark)');
  const lightAt = html.indexOf(":root[data-theme='light']");
  const darkAt = html.indexOf(":root[data-theme='dark']");
  assert.ok(
    lightAt > mediaAt && darkAt > mediaAt,
    'the explicit theme rules must come after the media query to win at equal specificity',
  );
});

test('every sample document is embedded in the page', () => {
  const html = renderPage();
  for (const phrase of [
    'Photosynthesis is two linked stages',
    'A TCP connection does not start with data',
    'Source files are compiled into object files',
  ]) {
    assert.ok(html.includes(JSON.stringify(phrase).slice(1, -1)), phrase);
  }
});

test('the page states its own limits where a reader can see them', () => {
  const html = renderPage();
  assert.match(html, /upper bound/);
  assert.match(html, /Above 64 nodes the tool refuses/);
  assert.match(html, /Textbook graph edit distance has no reversal operation/);
});

test('the page path is inside docs/', () => {
  assert.match(PAGE_PATH, /docs[/\\]index\.html$/);
});

test('the Hungarian solver finds the known optimum on a small matrix', () => {
  // Worked by hand: the only assignment costing 5 is (0,1), (1,0), (2,2).
  const cost = [
    [4, 1, 3],
    [2, 0, 5],
    [3, 2, 2],
  ];
  const { assignment, total } = hungarian(cost);
  assert.equal(total, 5);
  assert.deepEqual(assignment, [1, 0, 2]);
});

test('the Hungarian solver agrees with brute force on random matrices', () => {
  const random = (() => {
    let seed = 12345;
    return () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  })();
  const permutations = (items) => {
    if (items.length <= 1) return [items];
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([items[i], ...tail]);
    }
    return out;
  };
  for (let trial = 0; trial < 40; trial += 1) {
    const n = 2 + (trial % 5);
    const cost = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => Math.floor(random() * 20)),
    );
    let best = Infinity;
    for (const order of permutations([...Array(n).keys()])) {
      let sum = 0;
      for (let i = 0; i < n; i += 1) sum += cost[i][order[i]];
      best = Math.min(best, sum);
    }
    assert.equal(hungarian(cost).total, best, `trial ${trial}`);
  }
});
