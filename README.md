# diagram-recall

Rebuild a mermaid diagram from a shuffled pile of nodes and edges, scored by graph edit distance

**[Rebuild a diagram from a shuffled pile →](https://jesserweigel.github.io/diagram-recall/)**

Catalog task: `EDU-046`. One of a public catalog of build ideas: https://github.com/JesseRWeigel/722-things-to-build

## What this is

Point it at any markdown file containing a mermaid block. It reads the diagram, shuffles the nodes
and edges into a pile, and asks you to put them back. Then it scores what you built against the
reference and names what you got wrong.

```bash
node bin/recall.js drill notes.md --seed 7
node bin/recall.js score reference.md attempt.md
```

The scoring is the whole project. Anyone can diff two diagrams and print "different". The useful
answer is *how* different, and in what way.

**A reversed relation is one mistake, not two.** This is the case that made the tool worth building.
A naive diff sees `A --> B` where it expected `B --> A` and reports two errors: a missing edge and an
invented one. That is wrong as feedback, because you did not forget a relation and you did not
imagine one. You knew the relation and got its direction backwards, which is one thing to fix. The
scorer carries an explicit edge reversal primitive of cost 1 and reports it as a single finding.

The distinction is defended with negative controls, because a rule that calls everything a reversal
is worse than no rule. An added opposite link where the original still exists is an extra edge and
not a reversal. Dropping one side of a two way pair is a missing edge and not a reversal. Two
genuine reversals are two errors.

**Errors are sorted into four buckets that mean different things.**

| Bucket | What it covers |
|---|---|
| `structure` | Which nodes exist, which pairs are related, and which way each relation points |
| `label` | The caption on a node or a relation |
| `style` | Node shape, link line style, the decoration on a link head |
| `grouping` | Which subgraph a node sits in |

Getting a box rounded instead of rectangular is not the same kind of failure as inventing a
relation, and a tool that adds them into one number cannot tell you which you did. Every finding
falls into exactly one bucket, and the suite asserts the four subtotals sum to the total rather than
trusting it.

**The correspondence between your nodes and the reference's is searched, not assumed.** If you used
the reference's identifiers the mapping is given. If you renamed things, the tool has to work out
which of your nodes is which, and that is an assignment problem. Below 8 nodes it enumerates every
correspondence and the answer is exact. Above it, the answer is an approximation and is **labelled
an upper bound**, never presented as exact. Above 64 nodes it refuses outright rather than running
for an unbounded time.

**Two links between the same pair are matched by label rather than arbitrarily.** Otherwise which
one is reported wrong depends on iteration order.

## Running it

```bash
# turn a markdown file into a drill
node bin/recall.js drill notes.md --seed 7

# just parse and show what was understood
node bin/recall.js parse notes.md --json

# score an attempt against a reference
node bin/recall.js score reference.md attempt.md --mapping auto

# run the hand computed fixture set
node bin/recall.js fixtures

# rebuild the browser drill at docs/index.html
node bin/recall.js build-page
```

Node 20 or newer, no runtime dependencies. Python 3 and Chrome are needed for the verification
scripts and for nothing else. There is a browser version of the drill at `docs/index.html`.

### Verify command

```bash
bash scripts/verify.sh
```

Its exit code is the result. There is no skip path: Chrome is a hard requirement because the drill
is a web page, and a run that stopped before opening it would report the same green as one that
opened it and measured it.

## How it is checked

**81 unit tests**, plus 33 hand computed fixture cases (15 parsing, 18 scoring) whose expected
numbers were worked out on paper and are stored with the derivation that produced them. One is a
zero distance negative control, because a scorer that always finds errors passes any suite built
only from wrong answers.

**An independent recomputation** in `scripts/check_independent.py` re-derives every scoring fixture
by set algebra over ordered pairs, sharing no code with the JavaScript. It agrees on 17 of 17 cases
and 20 structural edits, and its import graph is proved clean with `ast` against planted probes. It
declines to recompute the above-the-cap case rather than pretending to, which is the honest outcome
for a case whose answer is an upper bound.

That checker earned its place by being wrong in a way the package was not. It enumerates
correspondences between attempt and reference nodes, and a renamed node landing on the identifier of
a node it left unmapped silently merged the two, so a four node attempt was scored as three and one
fixture came out at a total of 1 where no injective correspondence scores below 2. It is guarded
against that now.

**5 sabotages under a three gate rule.** A sabotage counts only if the patch applies, it moves the
measured output, and only then is caught. Gate 2 reads `scripts/measure.mjs`, which prints buckets
and findings as numbers, rather than the fixture runner, which prints ok and FAIL. Fingerprinting a
verdict would make gates 2 and 3 the same question. A null control runs first: an unmodified copy of
the tree in a differently named directory must fingerprint identically, or gate 2 would be free.

Four are attacks, aimed at plausible wrong implementations rather than obviously broken code:
scoring a subgraph move as a structural error, scoring a shape difference as a structural error,
scoring a caption typo as a wrong relation, and disabling the reversal pass so a backwards arrow
scores as two errors again. One is a guard, which inverts gate 2: the 64 node refusal is dormant on
every fixture, so removing it must leave the measured output unchanged while a test still fails.

**30 browser checks** drive real headless Chrome over the DevTools protocol with no driver
dependency, measuring the page from inside it at 390px as well as at desktop width, and asserting it
threw no uncaught exception.

A privacy scan reads every tracked file as raw bytes with a positive control on planted secrets and
a control proving the scanner does not match its own source. The run digests every tracked file
before and after and fails if it changed the tree it was verifying.

## Status

```text

== 1. prerequisites
v24.13.0
Python 3.12.3
   tracked file digest before: 3847c66cff7ad133

== 2. unit tests
   81 passed, 0 failed

== 3. fixtures against hand computed expectations
parsing fixtures
  ok    graph TD with the four common node shapes
  ok    flowchart LR with the less common shapes
  ok    every link kind and head
  ok    labels in both the pipe form and the mid link form
  ok    a mid link label containing a hyphen
  ok    quoted captions containing the delimiter characters
  ok    subgraphs, including a nested one and the bracketed title form
  ok    chains, ampersand groups, semicolons and comments
  ok    presentation directives are reported and ignored, never dropped in silence
  ok    a bidirectional link becomes two directed links and says so
  ok    UNSUPPORTED: the new @{ } node metadata syntax is reported with its line
  ok    UNSUPPORTED: an unclosed node caption is reported, not guessed at
  ok    UNSUPPORTED: a diagram that is not a flowchart is named
  ok    UNSUPPORTED: a subgraph left open is reported
  ok    UNSUPPORTED: an unclosed link label is reported

scoring fixtures
  ok    perfect reconstruction scores zero
  ok    one reversed relation is one error and is named as such
  ok    a reversal keeps its label when the label is right
  ok    an added opposite link is an extra edge and NOT a reversal
  ok    dropping one side of a two way pair is a missing edge, not a reversal
  ok    two reversals are two errors
  ok    the shape is right and one link label is wrong
  ok    a node caption is wrong and nothing else is
  ok    structurally wrong: one relation missing and one invented
  ok    a missing node takes its relations with it
  ok    an arrow where the reference has a plain line
  ok    shape and line style are style, not structure
  ok    a reversal and a label error on different relations add up
  ok    a node in the wrong subgraph is a grouping error
  ok    renamed nodes force a correspondence search
  ok    renamed nodes with one reversal still finds the reversal
  ok    above the exact cap the answer is an upper bound and says so
  ok    forcing the identity correspondence on renamed nodes rebuilds the whole graph

33/33 fixture cases match their hand computed expectations (15 parsing, 18 scoring, including the zero distance negative control)

== 4. the scores recomputed by code that shares nothing with the package
recomputing every scoring fixture by set algebra over ordered pairs
  ok    perfect reconstruction scores zero
  ok    one reversed relation is one error and is named as such
  ok    a reversal keeps its label when the label is right
  ok    an added opposite link is an extra edge and NOT a reversal
  ok    dropping one side of a two way pair is a missing edge, not a reversal
  ok    two reversals are two errors
  ok    the shape is right and one link label is wrong
  ok    a node caption is wrong and nothing else is
  ok    structurally wrong: one relation missing and one invented
  ok    a missing node takes its relations with it
  ok    an arrow where the reference has a plain line
  ok    shape and line style are style, not structure
  ok    a reversal and a label error on different relations add up
  ok    a node in the wrong subgraph is a grouping error
  ok    renamed nodes force a correspondence search
  ok    renamed nodes with one reversal still finds the reversal
  ....  above the exact cap the answer is an upper bound and says so
          10 nodes is too many to enumerate every correspondence
  ok    forcing the identity correspondence on renamed nodes rebuilds the whole graph

not recomputed: above the exact cap the answer is an upper bound and says so (10 nodes is too many to enumerate every correspondence)
17/17 independent recomputations agree with the hand computed fixtures, 20 structural edits in total

== 5. the independence prover is shown able to reject
proving independence with the ast module, not with grep
  ok    probe 'a relative import reaching the package' rejected
  ok    probe 'an absolute import of a package module' rejected
  ok    probe 'a from-import of a package module' rejected
  ok    probe 'a dynamic import with a constant name' rejected
  ok    probe 'a dynamic import with a computed name' rejected
  ok    probe 'shelling out to node' rejected
  ok    probe 'os.system' rejected
  ok    probe 'stdlib only, which is what this file is allowed to do' accepted
  ok    probe 'a comment mentioning the package, which a grep would wrongly flag' accepted
  ok    this file imports nothing from the package and starts no subprocess
9 probes went the right way, and the checker itself is clean

== 6. no credentials, home directory paths, or NUL bytes in tracked files
privacy scan
  11 patterns, every one assembled from fragments at import time
  control: planted GitHub token found in a plain file
  control: planted AWS key found in a file containing a NUL byte
  control: account patterns fire under the substituted account 'runner'
  control: account patterns fire under the substituted account 'zzplaceholderzz'
  control: the scanner does not match its own source
  control: the tracked tree is clean under substituted account names too
  read 29 of 29 tracked files as raw bytes
clean: no credential-shaped strings, no personal paths, no NUL bytes in 29 tracked files

== 7. the published page measured in real headless Chrome
  ok    the page under test is the right one
  ok    desktop viewport really is 1280 wide
  ok    the drill was built by the page's own script
  ok    the node selects are populated
  ok    the board drew one shape per node
  ok    every reference relation was placed through the keyboard form
  ok    a CORRECT reconstruction scores zero in the page
  ok    the zero result says so in words
  ok    a correct reconstruction reports no reversal
  ok    reversing a plain undirected line is not an error, because it has no direction
  ok    the Reverse button turns a placed relation round
  ok    one reversal costs exactly one structural edit and nothing else
  ok    the reversal is reported as one relation being backwards
  ok    the wording tells the learner they got the relation backwards
  ok    a reversal is not also listed as a separate deletion and insertion
  ok    a board node can take keyboard focus
  ok    arrow keys move a focused node
  ok    moving every node around does not change the score
  ok    unreadable syntax refuses the drill and names the line
  ok    the system preference changes the palette
  ok    choosing light overrides a dark system preference
  ok    choosing dark overrides a light system preference
  ok    nothing escapes the page sideways at 1280px
  ok    narrow viewport really is 390 wide
  ok    the drill builds at 390px too
  ok    nothing escapes the page sideways at 390px
  ok    the document itself does not scroll sideways at 390px
  ok    the whole drill can be completed at 390px, and scores zero
  ok    the result panel does not overflow at 390px
  ok    the page threw no uncaught exception

30 browser checks passed

== 8. the committed page matches a fresh build
docs/index.html matches a fresh build

== 9. sabotage: break the scorer on purpose and require a check to notice
=== baseline ===
  fingerprint bb7bc597b74ef818, 3079 bytes measured
=== null control ===
  identical fingerprint bb7bc597b74ef818 from a differently named directory

=== attack: grouping-scored-as-structure ===
  a node in the wrong subgraph becomes a wrong graph
  gate 1 applied: src/score.js changed
  gate 2 moved: fingerprint 69622d9ee99fb9a4
  gate 3 caught by `node bin/recall.js fixtures` (exit 1)

=== attack: style-scored-as-structure ===
  a rounded box instead of a rectangle becomes a structural error
  gate 1 applied: src/score.js changed
  gate 2 moved: fingerprint 2c9371e6aea36617
  gate 3 caught by `node --test tests/score.test.js` (exit 1)

=== attack: label-scored-as-structure ===
  a typo in a caption becomes a wrong relation
  gate 1 applied: src/score.js changed
  gate 2 moved: fingerprint 9ab144aa0df347a6
  gate 3 caught by `node bin/recall.js fixtures` (exit 1)

=== attack: reversal-pass-disabled ===
  a reversed arrow scores as two errors, one missing and one invented, instead of the single reversal it is
  gate 1 applied: src/score.js changed
  gate 2 moved: fingerprint 32cac2992d0b5610
  gate 3 caught by `node bin/recall.js fixtures` (exit 1)

=== guard: size-cap-removed ===
  the refusal to run on an enormous graph is dormant on every fixture, so removing it changes nothing measurable and leaves an unbounded run in
  gate 1 applied: src/score.js changed
  gate 2 UNCHANGED, as a dormant guard must be
  gate 3 caught by `node --test tests/score.test.js` (exit 1)

================================================
5 of 5 sabotages proven, 4 attacks and 1 guards
SABOTAGE SUITE PASSED

== 10. the README describes what actually happened
   README checks: 0 problem(s)

== 11. this run did not modify the tree it verified
   tracked file digest after:  3847c66cff7ad133

VERIFY PASSED: diagram-recall, 11 of 11 steps, 81 unit tests
```

## Unfinished

- **Mermaid support is a useful subset, not the language.** Flowcharts and graphs with the common
  node shapes, link kinds, labels and subgraphs. No class diagrams, no sequence diagrams, no state
  diagrams, no styling directives.
- **The approximation above 8 nodes is Hungarian assignment on a local cost, then branch and bound
  with an expansion budget.** It is a real upper bound and it is labelled one, and it is not the
  optimum.
- **The drill shuffles, it does not distract.** A pile of the right pieces in the wrong order is
  easier than recall from nothing. Plausible wrong pieces mixed into the pile would be a harder and
  better exercise.
- **No spaced repetition.** Each drill is independent, and nothing is remembered between runs.
- **Grouping is a flat label.** A node is in a subgraph or it is not. Nested subgraphs parse, but
  moving a node between two levels of nesting scores the same as moving it anywhere else.
