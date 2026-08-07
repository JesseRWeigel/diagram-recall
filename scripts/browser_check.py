#!/usr/bin/env python3
"""Load docs/index.html in real headless Chrome and measure it from inside the page.

Every assertion here runs as JavaScript in the page, not against a screenshot, because
``chrome --headless --screenshot --window-size=`` renders at one width and captures at
another, and because a page whose whole script failed to parse still produces a screenshot
that looks broadly plausible.

What this covers that a unit test cannot:

  * the drill actually built. One unbalanced parenthesis anywhere in the bundle stops the
    module executing, and every unit test still passes, because the tests import the modules
    directly and never load the page.
  * the page is operable from the keyboard alone. Relations are placed, reversed, checked and
    cleared using focus, select changes and clicks on focused buttons. No coordinate is used.
  * a CORRECT reconstruction, built through the real form, scores zero. This is the negative
    control for the whole page. A scorer that always finds something wrong passes any check
    built only out of wrong answers.
  * one relation reversed from that correct state is reported as one reversal, in words, in
    the rendered DOM.
  * nothing escapes the page sideways at 390px, found by walking elements and comparing their
    right edge against the viewport, ignoring anything inside a horizontally scrollable
    ancestor because content scrolling inside its own container is correct. The stylesheet
    contains no ``overflow-x: hidden`` on the body, which would hide the symptom and make
    this probe vacuous.
  * both themes, with the explicit toggle overriding the system preference in both directions.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp import Chrome, ChromeMissing  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "docs", "index.html")
TITLE = "Diagram recall"

OVERFLOW_PROBE = """
(function () {
  const limit = document.documentElement.clientWidth;
  const scrollers = new Set();
  for (const node of document.querySelectorAll('*')) {
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') scrollers.add(node);
  }
  const inScroller = (node) => {
    for (let p = node.parentElement; p; p = p.parentElement) if (scrollers.has(p)) return true;
    return false;
  };
  const offenders = [];
  for (const node of document.querySelectorAll('body *')) {
    if (inScroller(node)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > limit + 0.5 || rect.left < -0.5) {
      offenders.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        cls: (node.className && node.className.toString().slice(0, 40)) || null,
        right: Math.round(rect.right),
        left: Math.round(rect.left),
      });
    }
  }
  return {
    limit,
    documentScrollWidth: document.documentElement.scrollWidth,
    offenders: offenders.slice(0, 8),
  };
})()
"""

# Rebuild the reference exactly, using only the controls a keyboard user has: focus a select,
# change its value, focus the button, click it. Returns the rendered verdict.
BUILD_CORRECT = """
(function () {
  const handle = window.diagramRecall;
  if (!handle) throw new Error('the page exposed no handle, so its module never ran');
  const reference = handle.graphToJSON(handle.state.drill.reference);
  const set = (id, value) => {
    const node = document.getElementById(id);
    node.focus();
    if (document.activeElement !== node) throw new Error(id + ' cannot take keyboard focus');
    node.value = value;
    if (node.value !== value) throw new Error(id + ' has no option ' + value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const reset = document.getElementById('reset');
  reset.focus();
  reset.click();
  for (const edge of reference.edges) {
    const card = document.getElementById('edge-card');
    const option = [...card.options].find((candidate) => {
      if (!candidate.value) return false;
      const relation = handle.state.drill.pile.relations.find(
        (item) => item.cardId === candidate.value,
      );
      return (
        relation &&
        (relation.label || null) === (edge.label || null) &&
        relation.kind === edge.kind &&
        relation.head === edge.head
      );
    });
    if (!option) throw new Error('no remaining card matches ' + JSON.stringify(edge));
    set('edge-from', edge.from);
    set('edge-to', edge.to);
    set('edge-card', option.value);
    const add = document.getElementById('add-edge');
    add.focus();
    if (document.activeElement !== add) throw new Error('the place button cannot take focus');
    add.click();
  }
  const check = document.getElementById('check');
  check.focus();
  check.click();
  const buckets = {};
  for (const node of document.querySelectorAll('[data-bucket]')) {
    buckets[node.getAttribute('data-bucket')] = Number(node.querySelector('.num').textContent);
  }
  return {
    placed: document.querySelectorAll('#placements li.placement').length,
    edges: reference.edges.length,
    hidden: document.getElementById('result').hidden,
    verdict: document.querySelector('[data-testid="verdict"]').textContent.trim(),
    buckets,
    reversalsBox: Boolean(document.querySelector('[data-testid="reversals"]')),
    liveRegion: document.getElementById('live').textContent,
  };
})()
"""

# From the correct state, turn exactly one relation round using its Reverse button.
#
# `which` picks the placement to turn: 'directed' takes the first relation that has a
# direction to get wrong, and 'undirected' takes the first plain line. Reversing a plain line
# has to be a no operation, because an undirected relation has no direction to get backwards,
# and that is the control that stops this check being satisfied by a scorer that penalises any
# change at all.
REVERSE_ONE = """
(function (which) {
  const handle = window.diagramRecall;
  const index = handle.state.placements.findIndex((placement) =>
    which === 'directed' ? placement.head !== 'open' : placement.head === 'open');
  if (index < 0) throw new Error('no ' + which + ' placement to turn round');
  const rows = document.querySelectorAll('#placements li.placement');
  const row = rows[index];
  const button = row.querySelector('button[data-reverse]');
  const before = row.querySelector('.relation').textContent;
  button.focus();
  if (document.activeElement !== button) throw new Error('reverse cannot take focus');
  button.click();
  const after = document.querySelectorAll('#placements li.placement')[index]
    .querySelector('.relation').textContent;
  const check = document.getElementById('check');
  check.focus();
  check.click();
  const buckets = {};
  for (const node of document.querySelectorAll('[data-bucket]')) {
    buckets[node.getAttribute('data-bucket')] = Number(node.querySelector('.num').textContent);
  }
  const box = document.querySelector('[data-testid="reversals"]');
  return {
    which,
    index,
    before,
    after,
    buckets,
    heading: box ? box.querySelector('h3').textContent : null,
    wording: box ? box.querySelector('p').textContent : null,
    otherFindings: document.querySelectorAll('[data-testid="findings"] li').length,
  };
})
"""


class Checks:
    def __init__(self) -> None:
        self.passed = 0
        self.failures: list[str] = []

    def expect(self, name: str, condition: bool, detail: str = "") -> bool:
        if condition:
            self.passed += 1
            print(f"  ok    {name}")
            return True
        self.failures.append(f"{name}: {detail}")
        print(f"  FAIL  {name}\n          {detail}")
        return False


def main() -> int:
    if not os.path.exists(PAGE):
        print(f"FAIL: {PAGE} does not exist. Run: node bin/recall.js build-page")
        return 1

    checks = Checks()
    url = "file://" + PAGE

    try:
        chrome = Chrome()
    except ChromeMissing as exc:
        print(f"FAIL: {exc}")
        print(
            "This is a failure rather than a skip. Without a browser the page's script is\n"
            "never executed, and the rest of the suite only ever exercises the modules that\n"
            "the page might not even be able to load."
        )
        return 1

    try:
        chrome.viewport(1280, 900)
        chrome.navigate(url)
        chrome.wait_for(
            "document.documentElement.getAttribute('data-ready') === 'yes'", timeout=30
        )

        title = chrome.evaluate("document.title")
        checks.expect(
            "the page under test is the right one",
            TITLE in title,
            f"document.title is {title!r}",
        )
        width = chrome.evaluate("document.documentElement.clientWidth", TITLE)
        checks.expect("desktop viewport really is 1280 wide", width == 1280, f"got {width}")

        cards = chrome.evaluate(
            "document.querySelectorAll('[data-testid=\"relation-cards\"] li').length", TITLE
        )
        checks.expect(
            "the drill was built by the page's own script",
            cards >= 5,
            f"only {cards} relation cards rendered, so the module probably did not run",
        )
        node_options = chrome.evaluate(
            "document.getElementById('edge-from').options.length", TITLE
        )
        checks.expect(
            "the node selects are populated", node_options >= 5, f"{node_options} options"
        )
        board_nodes = chrome.evaluate(
            "document.querySelectorAll('[data-testid=\"board-svg\"] g.node').length", TITLE
        )
        checks.expect(
            "the board drew one shape per node",
            board_nodes == node_options,
            f"{board_nodes} board nodes against {node_options} select options",
        )

        # ---- the negative control: a correct reconstruction must score zero ------------
        correct = chrome.evaluate(BUILD_CORRECT, TITLE)
        checks.expect(
            "every reference relation was placed through the keyboard form",
            correct["placed"] == correct["edges"],
            json.dumps(correct),
        )
        checks.expect(
            "a CORRECT reconstruction scores zero in the page",
            correct["buckets"] == {"structure": 0, "labels": 0, "style": 0, "grouping": 0},
            json.dumps(correct),
        )
        checks.expect(
            "the zero result says so in words",
            "matches the reference exactly" in correct["verdict"],
            json.dumps(correct["verdict"]),
        )
        checks.expect(
            "a correct reconstruction reports no reversal",
            correct["reversalsBox"] is False,
            json.dumps(correct),
        )

        # ---- turning an UNDIRECTED relation round must change nothing --------------------
        undirected = chrome.evaluate(f"({REVERSE_ONE})('undirected')", TITLE)
        checks.expect(
            "reversing a plain undirected line is not an error, because it has no direction",
            undirected["buckets"] == {"structure": 0, "labels": 0, "style": 0, "grouping": 0},
            json.dumps(undirected),
        )

        # ---- one directed relation turned round -----------------------------------------
        chrome.evaluate(BUILD_CORRECT, TITLE)
        reversed_result = chrome.evaluate(f"({REVERSE_ONE})('directed')", TITLE)
        checks.expect(
            "the Reverse button turns a placed relation round",
            reversed_result["before"] != reversed_result["after"],
            json.dumps(reversed_result)[:300],
        )
        checks.expect(
            "one reversal costs exactly one structural edit and nothing else",
            reversed_result["buckets"]
            == {"structure": 1, "labels": 0, "style": 0, "grouping": 0},
            json.dumps(reversed_result["buckets"]),
        )
        checks.expect(
            "the reversal is reported as one relation being backwards",
            reversed_result["heading"] == "One relation is backwards",
            json.dumps(reversed_result["heading"]),
        )
        checks.expect(
            "the wording tells the learner they got the relation backwards",
            reversed_result["wording"] is not None
            and "backwards" in reversed_result["wording"]
            and "not a missing link plus a spare one" in reversed_result["wording"],
            json.dumps(reversed_result["wording"]),
        )
        checks.expect(
            "a reversal is not also listed as a separate deletion and insertion",
            reversed_result["otherFindings"] == 0,
            f"{reversed_result['otherFindings']} other findings alongside the reversal",
        )

        # ---- keyboard only movement on the board -----------------------------------------
        focusable = chrome.evaluate(
            """(function () {
                 const node = document.querySelector('[data-testid="board-svg"] g.node');
                 node.focus();
                 return document.activeElement === node;
               })()""",
            TITLE,
        )
        checks.expect("a board node can take keyboard focus", focusable is True, str(focusable))

        moved = chrome.evaluate(
            """(function () {
                 const pick = () =>
                   document.querySelector('[data-testid="board-svg"] g.node')
                     .getBoundingClientRect().left;
                 const before = pick();
                 const node = document.querySelector('[data-testid="board-svg"] g.node');
                 node.focus();
                 node.dispatchEvent(new KeyboardEvent('keydown',
                   { key: 'ArrowRight', bubbles: true }));
                 return { before: Math.round(before), after: Math.round(pick()) };
               })()""",
            TITLE,
        )
        checks.expect(
            "arrow keys move a focused node", moved["after"] > moved["before"], json.dumps(moved)
        )

        # ---- moving nodes changes nothing about the score --------------------------------
        after_move = chrome.evaluate(
            """(function () {
                 for (const node of document.querySelectorAll(
                        '[data-testid="board-svg"] g.node')) {
                   node.focus();
                   for (let i = 0; i < 5; i += 1) {
                     node.dispatchEvent(new KeyboardEvent('keydown',
                       { key: 'ArrowDown', bubbles: true }));
                   }
                 }
                 document.getElementById('check').click();
                 const buckets = {};
                 for (const node of document.querySelectorAll('[data-bucket]')) {
                   buckets[node.getAttribute('data-bucket')] =
                     Number(node.querySelector('.num').textContent);
                 }
                 return buckets;
               })()""",
            TITLE,
        )
        checks.expect(
            "moving every node around does not change the score",
            after_move == reversed_result["buckets"],
            f"{json.dumps(after_move)} against {json.dumps(reversed_result['buckets'])}",
        )

        # ---- a diagram the parser cannot read is refused, loudly --------------------------
        refused = chrome.evaluate(
            """(function () {
                 const box = document.getElementById('paste');
                 box.focus();
                 box.value = '# Broken\\n\\n```mermaid\\ngraph TD\\n  A --> B\\n  ' +
                   'A@{ shape: rounded }\\n```\\n';
                 box.dispatchEvent(new Event('input', { bubbles: true }));
                 const load = document.getElementById('paste-load');
                 load.focus();
                 load.click();
                 const problems = document.getElementById('problems');
                 return {
                   hidden: problems.hidden,
                   text: problems.textContent,
                   drillHidden: document.getElementById('drill').hidden,
                 };
               })()""",
            TITLE,
        )
        checks.expect(
            "unreadable syntax refuses the drill and names the line",
            refused["hidden"] is False
            and "@{ shape: rounded }" in refused["text"]
            and refused["drillHidden"] is True,
            json.dumps(refused)[:400],
        )

        # ---- themes, both directions ------------------------------------------------------
        chrome.navigate(url)
        chrome.wait_for(
            "document.documentElement.getAttribute('data-ready') === 'yes'", timeout=30
        )
        chrome.emulate_color_scheme("light")
        light_default = chrome.evaluate(
            "getComputedStyle(document.body).backgroundColor", TITLE
        )
        chrome.emulate_color_scheme("dark")
        dark_default = chrome.evaluate(
            "getComputedStyle(document.body).backgroundColor", TITLE
        )
        checks.expect(
            "the system preference changes the palette",
            light_default != dark_default,
            f"light {light_default} dark {dark_default}",
        )
        forced_light_on_dark = chrome.evaluate(
            """(function () {
                 const select = document.getElementById('theme');
                 select.value = 'light';
                 select.dispatchEvent(new Event('change', { bubbles: true }));
                 return getComputedStyle(document.body).backgroundColor;
               })()""",
            TITLE,
        )
        checks.expect(
            "choosing light overrides a dark system preference",
            forced_light_on_dark == light_default,
            f"got {forced_light_on_dark}, expected {light_default}",
        )
        chrome.emulate_color_scheme("light")
        forced_dark_on_light = chrome.evaluate(
            """(function () {
                 const select = document.getElementById('theme');
                 select.value = 'dark';
                 select.dispatchEvent(new Event('change', { bubbles: true }));
                 return getComputedStyle(document.body).backgroundColor;
               })()""",
            TITLE,
        )
        checks.expect(
            "choosing dark overrides a light system preference",
            forced_dark_on_light == dark_default,
            f"got {forced_dark_on_light}, expected {dark_default}",
        )
        chrome.emulate_color_scheme("")

        desktop_overflow = chrome.evaluate(OVERFLOW_PROBE, TITLE)
        checks.expect(
            "nothing escapes the page sideways at 1280px",
            not desktop_overflow["offenders"],
            json.dumps(desktop_overflow),
        )

        # ---- 390px -------------------------------------------------------------------------
        chrome.viewport(390, 844)
        chrome.navigate(url)
        chrome.wait_for(
            "document.documentElement.getAttribute('data-ready') === 'yes'", timeout=30
        )
        narrow_width = chrome.evaluate("document.documentElement.clientWidth", TITLE)
        checks.expect(
            "narrow viewport really is 390 wide",
            narrow_width == 390,
            f"got {narrow_width}, which is why a --window-size screenshot cannot be trusted",
        )
        narrow_cards = chrome.evaluate(
            "document.querySelectorAll('[data-testid=\"relation-cards\"] li').length", TITLE
        )
        checks.expect(
            "the drill builds at 390px too", narrow_cards >= 5, f"{narrow_cards} relation cards"
        )
        narrow_overflow = chrome.evaluate(OVERFLOW_PROBE, TITLE)
        checks.expect(
            "nothing escapes the page sideways at 390px",
            not narrow_overflow["offenders"],
            json.dumps(narrow_overflow),
        )
        body_scroll = chrome.evaluate(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1",
            TITLE,
        )
        checks.expect(
            "the document itself does not scroll sideways at 390px",
            body_scroll is True,
            f"scrollWidth {narrow_overflow['documentScrollWidth']} against 390",
        )
        narrow_correct = chrome.evaluate(BUILD_CORRECT, TITLE)
        checks.expect(
            "the whole drill can be completed at 390px, and scores zero",
            narrow_correct["buckets"]
            == {"structure": 0, "labels": 0, "style": 0, "grouping": 0},
            json.dumps(narrow_correct)[:400],
        )
        after_narrow = chrome.evaluate(OVERFLOW_PROBE, TITLE)
        checks.expect(
            "the result panel does not overflow at 390px",
            not after_narrow["offenders"],
            json.dumps(after_narrow),
        )

        errors = [
            event
            for event in chrome.drain()
            if event.get("method") == "Runtime.exceptionThrown"
        ]
        checks.expect(
            "the page threw no uncaught exception", not errors, json.dumps(errors)[:400]
        )
    finally:
        chrome.close()

    print()
    total = checks.passed + len(checks.failures)
    if checks.failures:
        print(f"FAILED: {len(checks.failures)} of {total} browser checks")
        for failure in checks.failures:
            print(f"  - {failure}")
        return 1
    print(f"{checks.passed} browser checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
