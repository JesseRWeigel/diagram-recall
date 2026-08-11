#!/usr/bin/env python3
"""A second implementation of the scoring, sharing nothing with the first.

Why this exists. The JavaScript scorer is checked against `fixtures/scoring.json`, whose
numbers were worked out by hand. That is one derivation agreeing with one hand calculation.
This file is a second derivation, in a different language, by a different method:

  * its own mermaid reader, written as line by line regular expressions, with no knowledge of
    the JavaScript parser's cursor and shape table;
  * structural distance computed with set algebra over ordered pairs, rather than by the
    JavaScript's bucketed multiset matching;
  * the node correspondence found by brute force over all permutations for the small cases,
    rather than by branch and bound.

It reads `fixtures/scoring.json` for the inputs and the hand computed answers. It never runs
the JavaScript, and never imports anything from this project. `--prove-independence` walks this
file's own syntax tree to prove that, and is shown able to fail by being run against planted
probes it must reject.

Usage:
  python3 scripts/check_independent.py                     recompute and compare
  python3 scripts/check_independent.py --prove-independence prove the isolation first
"""

from __future__ import annotations

import ast
import json
import re
import sys
from itertools import permutations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "scoring.json"

# ----------------------------------------------------------------------------------------
# Part 1: proving that this file reaches nothing in the package under test.
# ----------------------------------------------------------------------------------------

# Anything a check could use to reach the implementation it is meant to be independent of.
# Shelling out to node would be exactly as disqualifying as importing a module.
FORBIDDEN_MODULES = {"subprocess", "os", "shutil", "runpy", "importlib", "ctypes", "pty"}
PROJECT_HINTS = ("src", "recall", "graph", "score", "mermaid", "drill", "report", "hungarian")


class ImportFinding:
    def __init__(self, kind: str, name: str, line: int, why: str) -> None:
        self.kind = kind
        self.name = name
        self.line = line
        self.why = why

    def __str__(self) -> str:
        return f"line {self.line}: {self.kind} {self.name!r}, {self.why}"


def audit_source(source: str, label: str) -> list[ImportFinding]:
    """Walk the syntax tree and report every way this source could reach the package.

    An `ast` walk rather than a grep. A grep is satisfied by the word appearing in a comment
    and misses `importlib.import_module`, `__import__`, and a relative import written with
    leading dots.
    """
    findings: list[ImportFinding] = []
    tree = ast.parse(source, filename=label)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in FORBIDDEN_MODULES:
                    findings.append(
                        ImportFinding("import", alias.name, node.lineno,
                                      "this module can run the implementation as a subprocess")
                    )
                if any(hint == root for hint in PROJECT_HINTS):
                    findings.append(
                        ImportFinding("import", alias.name, node.lineno,
                                      "this names a module inside the package under test")
                    )
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                findings.append(
                    ImportFinding("relative import", "." * node.level + (node.module or ""),
                                  node.lineno,
                                  "a relative import reaches out of scripts/ into the package")
                )
                continue
            root = (node.module or "").split(".")[0]
            if root in FORBIDDEN_MODULES:
                findings.append(
                    ImportFinding("from-import", node.module or "", node.lineno,
                                  "this module can run the implementation as a subprocess")
                )
            if any(hint == root for hint in PROJECT_HINTS):
                findings.append(
                    ImportFinding("from-import", node.module or "", node.lineno,
                                  "this names a module inside the package under test")
                )
        elif isinstance(node, ast.Call):
            target = node.func
            name = None
            if isinstance(target, ast.Name):
                name = target.id
            elif isinstance(target, ast.Attribute):
                name = target.attr
            if name in ("__import__", "import_module"):
                argument = node.args[0] if node.args else None
                shown = (
                    argument.value
                    if isinstance(argument, ast.Constant)
                    else "<computed at run time>"
                )
                findings.append(
                    ImportFinding("dynamic import", str(shown), node.lineno,
                                  "a name resolved at run time cannot be audited statically, "
                                  "so it is refused whatever it says")
                )
            if name in ("system", "popen", "spawn", "run", "call", "check_output") and isinstance(
                target, ast.Attribute
            ):
                owner = target.value
                if isinstance(owner, ast.Name) and owner.id in FORBIDDEN_MODULES:
                    findings.append(
                        ImportFinding("process call", f"{owner.id}.{name}", node.lineno,
                                      "running another process could reach the implementation")
                    )
    return findings


# Probes the auditor must reject, and one it must accept. A prover that has never been shown
# failing is a prover nobody has tested.
PROBES = [
    ("a relative import reaching the package", "from ..src import score\n", True),
    ("an absolute import of a package module", "import score\n", True),
    ("a from-import of a package module", "from graph import structuralKey\n", True),
    ("a dynamic import with a constant name",
     "import importlib\nimportlib.import_module('score')\n", True),
    ("a dynamic import with a computed name",
     "import importlib\nname = 'sco' + 're'\nimportlib.import_module(name)\n", True),
    ("shelling out to node",
     "import subprocess\nsubprocess.run(['node', 'bin/recall.js'])\n", True),
    ("os.system", "import os\nos.system('node bin/recall.js')\n", True),
    ("stdlib only, which is what this file is allowed to do",
     "import json\nimport re\nfrom pathlib import Path\nfrom itertools import permutations\n",
     False),
    ("a comment mentioning the package, which a grep would wrongly flag",
     "# this does not import src/score.js at all\nimport json\n", False),
]


def prove_independence() -> int:
    print("proving independence with the ast module, not with grep")
    failures = 0
    for name, source, should_reject in PROBES:
        findings = audit_source(source, f"<probe {name}>")
        rejected = bool(findings)
        if rejected != should_reject:
            failures += 1
            verdict = "REJECTED" if rejected else "accepted"
            wanted = "reject" if should_reject else "accept"
            print(f"  FAIL  probe {name!r} was {verdict}, the auditor should {wanted} it")
        else:
            verdict = "rejected" if rejected else "accepted"
            print(f"  ok    probe {name!r} {verdict}")
    if failures:
        print(f"FAIL: {failures} probe(s) went the wrong way, so the auditor is not trustworthy",
              file=sys.stderr)
        return 1

    own = audit_source(Path(__file__).read_text(encoding="utf-8"), __file__)
    # This file names the forbidden modules in string literals and in a set, which the ast walk
    # correctly does not treat as imports. Only real imports and real calls count.
    if own:
        print("FAIL: this checker itself reaches the package under test:", file=sys.stderr)
        for finding in own:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print("  ok    this file imports nothing from the package and starts no subprocess")
    print(f"{len(PROBES)} probes went the right way, and the checker itself is clean")
    return 0


# ----------------------------------------------------------------------------------------
# Part 2: an independent mermaid reader.
#
# Deliberately not a port of the JavaScript. It works line by line with regular expressions
# and understands only the subset the scoring fixtures use. Anything outside that subset is a
# hard error, never a skip, because quietly reading a fixture as fewer links than it has would
# make this checker agree with a wrong answer.
# ----------------------------------------------------------------------------------------

SHAPE_PATTERNS = [
    (re.compile(r"^\(\((.*)\)\)$"), "circle"),
    (re.compile(r"^\(\[(.*)\]\)$"), "stadium"),
    (re.compile(r"^\[\((.*)\)\]$"), "cylinder"),
    (re.compile(r"^\{\{(.*)\}\}$"), "hexagon"),
    (re.compile(r"^\[/(.*)/\]$"), "parallelogram"),
    (re.compile(r"^\[(.*)\]$"), "rect"),
    (re.compile(r"^\((.*)\)$"), "round"),
    (re.compile(r"^\{(.*)\}$"), "diamond"),
]

LINK = re.compile(
    r"^(?P<left>[A-Za-z0-9_]+)\s*(?P<decor>\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|"
    r"\(\([^)]*\)\)|\[\([^)]*\)\]|\[/[^/]*/\])?\s*"
    r"(?P<op>-->|---|-\.->|-\.-|==>|===|--o|--x)\s*"
    r"(?:\|(?P<label1>[^|]*)\|\s*)?"
    r"(?P<right>[A-Za-z0-9_]+)\s*(?P<rdecor>\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|"
    r"\(\([^)]*\)\)|\[\([^)]*\)\]|\[/[^/]*/\])?\s*$"
)

MID_LABEL = re.compile(
    r"^(?P<left>[A-Za-z0-9_]+)\s*(?P<decor>\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*"
    r"--\s*(?P<label>[^-]+?)\s*(?P<op>-->|---)\s*"
    r"(?P<right>[A-Za-z0-9_]+)\s*(?P<rdecor>\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*$"
)

BARE_NODE = re.compile(
    r"^(?P<id>[A-Za-z0-9_]+)\s*(?P<decor>\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|"
    r"\(\([^)]*\)\)|\[\([^)]*\)\])?\s*$"
)

HEADER = re.compile(r"^(?:graph|flowchart)(?:\s+(?:TB|TD|BT|RL|LR))?$", re.IGNORECASE)
SUBGRAPH = re.compile(r"^subgraph\s+(?P<name>.+)$", re.IGNORECASE)

DIRECTED_OPS = {"-->": ("solid", True), "-.->": ("dotted", True), "==>": ("thick", True),
                "--o": ("solid", True), "--x": ("solid", True)}
UNDIRECTED_OPS = {"---": ("solid", False), "-.-": ("dotted", False), "===": ("thick", False)}


class ReaderError(Exception):
    pass


def read_decoration(text: str | None) -> tuple[str | None, str]:
    if not text:
        return None, "rect"
    for pattern, shape in SHAPE_PATTERNS:
        match = pattern.match(text)
        if match:
            return match.group(1).strip().strip('"'), shape
    raise ReaderError(f"unknown node decoration {text!r}")


class Diagram:
    def __init__(self) -> None:
        self.labels: dict[str, str] = {}
        self.shapes: dict[str, str] = {}
        self.groups: dict[str, str | None] = {}
        self.links: list[tuple[str, str, str, bool, str | None]] = []

    def note_node(self, node_id: str, decoration: str | None, group: str | None) -> None:
        label, shape = read_decoration(decoration)
        if label is not None:
            self.labels[node_id] = label
        self.labels.setdefault(node_id, node_id)
        if decoration:
            self.shapes[node_id] = shape
        self.shapes.setdefault(node_id, "rect")
        if node_id not in self.groups or self.groups[node_id] is None:
            self.groups[node_id] = group

    @property
    def nodes(self) -> list[str]:
        return sorted(self.labels)


def read_mermaid(source: str) -> Diagram:
    diagram = Diagram()
    stack: list[str] = []
    lines = [line.strip() for line in source.splitlines()]
    lines = [line for line in lines if line and not line.startswith("%%")]
    if not lines or not HEADER.match(lines[0]):
        raise ReaderError(f"first line {lines[0]!r} is not a flowchart header" if lines
                          else "empty diagram")
    for raw in lines[1:]:
        if raw.lower() == "end":
            if not stack:
                raise ReaderError("`end` with no open subgraph")
            stack.pop()
            continue
        subgraph = SUBGRAPH.match(raw)
        if subgraph:
            stack.append(subgraph.group("name").strip())
            continue
        group = stack[-1] if stack else None

        match = LINK.match(raw)
        if match:
            operator = match.group("op")
            kind, directed = (DIRECTED_OPS | UNDIRECTED_OPS)[operator]
            diagram.note_node(match.group("left"), match.group("decor"), group)
            diagram.note_node(match.group("right"), match.group("rdecor"), group)
            label = match.group("label1")
            diagram.links.append(
                (match.group("left"), match.group("right"), kind, directed,
                 label.strip() if label is not None else None)
            )
            continue

        mid = MID_LABEL.match(raw)
        if mid:
            operator = mid.group("op")
            kind, directed = (DIRECTED_OPS | UNDIRECTED_OPS)[operator]
            diagram.note_node(mid.group("left"), mid.group("decor"), group)
            diagram.note_node(mid.group("right"), mid.group("rdecor"), group)
            diagram.links.append(
                (mid.group("left"), mid.group("right"), kind, directed, mid.group("label").strip())
            )
            continue

        bare = BARE_NODE.match(raw)
        if bare:
            diagram.note_node(bare.group("id"), bare.group("decor"), group)
            continue

        raise ReaderError(f"this reader does not understand {raw!r}")
    if stack:
        raise ReaderError(f"{len(stack)} subgraph(s) left open")
    return diagram


# ----------------------------------------------------------------------------------------
# Part 3: the distance, by set algebra over ordered pairs.
# ----------------------------------------------------------------------------------------


def keyed_links(diagram: Diagram, rename: dict[str, str]) -> tuple[list, list]:
    """Split a diagram's links into directed ordered pairs and undirected unordered pairs."""
    directed = []
    undirected = []
    for left, right, kind, is_directed, label in diagram.links:
        a = rename.get(left, left)
        b = rename.get(right, right)
        if is_directed:
            directed.append(((a, b), kind, label))
        else:
            undirected.append(((min(a, b), max(a, b)), kind, label))
    return directed, undirected


def multiset(items):
    counts: dict = {}
    for item in items:
        counts[item] = counts.get(item, 0) + 1
    return counts


def subtract(left: dict, right: dict) -> dict:
    out = {}
    for key, count in left.items():
        remaining = count - right.get(key, 0)
        if remaining > 0:
            out[key] = remaining
    return out


def total(counts: dict) -> int:
    return sum(counts.values())


def distance(reference: Diagram, attempt: Diagram, rename: dict[str, str]) -> dict:
    """Structure, label, style and grouping, computed independently of the JavaScript."""
    ref_nodes = set(reference.nodes)
    att_nodes = {rename.get(node, node) for node in attempt.nodes}
    missing = ref_nodes - att_nodes
    extra = att_nodes - ref_nodes
    shared = ref_nodes & att_nodes
    inverse = {value: key for key, value in rename.items()}

    structure = len(missing) + len(extra)
    label = 0
    style = 0
    grouping = 0
    for node in sorted(shared):
        original = inverse.get(node, node)
        if reference.labels[node] != attempt.labels[original]:
            label += 1
        if reference.shapes[node] != attempt.shapes[original]:
            style += 1
        if (reference.groups.get(node) or None) != (attempt.groups.get(original) or None):
            grouping += 1

    ref_directed, ref_undirected = keyed_links(reference, {})
    att_directed, att_undirected = keyed_links(attempt, rename)

    # Links touching a node that has no counterpart are edits on their own, and they are taken
    # out before anything is matched.
    def touches_absent(link, absent):
        return link[0][0] in absent or link[0][1] in absent

    ref_directed_live = [x for x in ref_directed if not touches_absent(x, missing)]
    ref_undirected_live = [x for x in ref_undirected if not touches_absent(x, missing)]
    att_directed_live = [x for x in att_directed if not touches_absent(x, extra)]
    att_undirected_live = [x for x in att_undirected if not touches_absent(x, extra)]
    structure += (
        len(ref_directed) - len(ref_directed_live)
        + len(ref_undirected) - len(ref_undirected_live)
        + len(att_directed) - len(att_directed_live)
        + len(att_undirected) - len(att_undirected_live)
    )

    # Pass one: identical ordered pair. Only the wording and the line style can differ.
    ref_pairs = multiset(link[0] for link in ref_directed_live)
    att_pairs = multiset(link[0] for link in att_directed_live)
    for pair, count in ref_pairs.items():
        shared_count = min(count, att_pairs.get(pair, 0))
        if shared_count == 0:
            continue
        ref_attrs = sorted(
            (link[1], link[2]) for link in ref_directed_live if link[0] == pair
        )[:shared_count]
        att_attrs = sorted(
            (link[1], link[2]) for link in att_directed_live if link[0] == pair
        )[:shared_count]
        for (ref_kind, ref_label), (att_kind, att_label) in zip(ref_attrs, att_attrs):
            if ref_label != att_label:
                label += 1
            if ref_kind != att_kind:
                style += 1

    ref_left = subtract(ref_pairs, att_pairs)
    att_left = subtract(att_pairs, ref_pairs)

    # Pass two: an unmatched reference pair whose mirror image is an unmatched attempt pair.
    # One edit, because the relation is there and points the wrong way.
    reversals = 0
    for (a, b), count in sorted(ref_left.items()):
        mirror = (b, a)
        if mirror not in att_left:
            continue
        turned = min(count, att_left[mirror])
        reversals += turned
        ref_left[(a, b)] -= turned
        att_left[mirror] -= turned
        if ref_left[(a, b)] == 0:
            del ref_left[(a, b)]
        if att_left[mirror] == 0:
            del att_left[mirror]
    structure += reversals

    # Pass three: right pair, wrong directedness.
    ref_und = multiset(link[0] for link in ref_undirected_live)
    att_und = multiset(link[0] for link in att_undirected_live)
    matched_und = 0
    for pair, count in ref_und.items():
        matched_und += min(count, att_und.get(pair, 0))
    ref_und_left = subtract(ref_und, att_und)
    att_und_left = subtract(att_und, ref_und)

    direction_mismatches = 0
    for (a, b), count in sorted(ref_left.items()):
        pair = (min(a, b), max(a, b))
        available = att_und_left.get(pair, 0)
        if not available:
            continue
        taken = min(count, available)
        direction_mismatches += taken
        ref_left[(a, b)] -= taken
        att_und_left[pair] -= taken
        if ref_left[(a, b)] == 0:
            del ref_left[(a, b)]
        if att_und_left[pair] == 0:
            del att_und_left[pair]
    for pair, count in sorted(ref_und_left.items()):
        for candidate in (pair, (pair[1], pair[0])):
            available = att_left.get(candidate, 0)
            remaining = ref_und_left.get(pair, 0)
            if not available or not remaining:
                continue
            taken = min(remaining, available)
            direction_mismatches += taken
            ref_und_left[pair] -= taken
            att_left[candidate] -= taken
            if att_left[candidate] == 0:
                del att_left[candidate]
    ref_und_left = {k: v for k, v in ref_und_left.items() if v > 0}
    structure += direction_mismatches
    structure += total(ref_left) + total(att_left) + total(ref_und_left) + total(att_und_left)

    return {
        "structure": structure,
        "label": label,
        "style": style,
        "grouping": grouping,
        "total": structure + label + style + grouping,
        "reversals": reversals,
    }


def best_distance(reference: Diagram, attempt: Diagram, mode: str) -> dict:
    """Brute force over correspondences, which is what makes this a different route."""
    ref_nodes = reference.nodes
    att_nodes = attempt.nodes
    if mode == "identity" or set(att_nodes) <= set(ref_nodes):
        return distance(reference, attempt, {})
    if len(att_nodes) > 8 or len(ref_nodes) > 8:
        # The exhaustive search is factorial, so above eight this file reports that it cannot
        # check the case rather than pretending to.
        return {"skipped": f"{max(len(ref_nodes), len(att_nodes))} nodes is too many to "
                           f"enumerate every correspondence"}
    best = None
    for chosen in permutations(ref_nodes, min(len(ref_nodes), len(att_nodes))):
        for assignment in permutations(att_nodes, len(chosen)):
            rename = dict(zip(assignment, chosen))
            candidate = distance(reference, attempt, rename)
            if best is None or candidate["total"] < best["total"]:
                best = candidate
    return best


def main() -> int:
    if "--prove-independence" in sys.argv:
        return prove_independence()

    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    failures = 0
    checked = 0
    skipped = []
    structural_sum = 0

    print("recomputing every scoring fixture by set algebra over ordered pairs")
    for case in data["cases"]:
        mode = (case.get("options") or {}).get("mapping", "auto")
        try:
            reference = read_mermaid(case["reference"])
            attempt = read_mermaid(case["attempt"])
        except ReaderError as error:
            failures += 1
            print(f"  FAIL  {case['name']}\n          this reader could not read it: {error}")
            continue
        result = best_distance(reference, attempt, mode)
        if "skipped" in result:
            skipped.append((case["name"], result["skipped"]))
            print(f"  ....  {case['name']}\n          {result['skipped']}")
            continue
        checked += 1
        structural_sum += result["structure"]
        differences = [
            f"{bucket} expected {case['expect'][bucket]}, recomputed {result[bucket]}"
            for bucket in ("structure", "label", "style", "grouping", "total")
            if result[bucket] != case["expect"][bucket]
        ]
        expected_reversals = sum(
            1 for finding in case["expect"].get("findings", [])
            if finding.get("type") == "edge-reversed"
        )
        if result["reversals"] != expected_reversals:
            differences.append(
                f"reversals expected {expected_reversals}, recomputed {result['reversals']}"
            )
        if differences:
            failures += 1
            print(f"  FAIL  {case['name']}")
            for difference in differences:
                print(f"          {difference}")
        else:
            print(f"  ok    {case['name']}")

    print()
    if failures:
        print(f"FAIL: {failures} fixture(s) disagree with this independent recomputation",
              file=sys.stderr)
        return 1
    if checked < 12:
        print(f"FAIL: only {checked} fixtures were recomputed. Too few to mean anything.",
              file=sys.stderr)
        return 1
    if len(skipped) > 2:
        print(f"FAIL: {len(skipped)} fixtures were beyond this reader, which is more than the "
              f"two large-graph cases it is expected to leave alone.", file=sys.stderr)
        return 1
    for name, reason in skipped:
        print(f"not recomputed: {name} ({reason})")
    print(f"{checked}/{checked} independent recomputations agree with the hand computed "
          f"fixtures, {structural_sum} structural edits in total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
