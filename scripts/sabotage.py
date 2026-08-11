#!/usr/bin/env python3
"""Break the scorer on purpose and require a check to notice.

Three gates per sabotage. The patch must apply to the file, it must move the MEASURED
output, and only then does a detector have to catch it. Gate 2 reads scripts/measure.mjs,
which prints buckets and findings as numbers, rather than `recall fixtures`, which prints
ok and FAIL. Fingerprinting a verdict would make gate 2 and gate 3 the same question and
every sabotage would clear gate 2 for the reason it clears gate 3.

A null control runs first. It copies the tree unchanged into a differently named directory
and requires an identical fingerprint. Without it a fingerprint that varied with the
working directory would hand gate 2 to every sabotage for free, which is how eleven
sabotages in a sibling project scored as proven while proving nothing.

Guards invert gate 2. A guard is code that is dormant on well formed input, so removing it
must leave the measured output UNCHANGED while a check still fails. A guard that moved the
output would be an attack.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Sabotage:
    def __init__(self, name, target, old, new, detector, kind="attack", why=""):
        self.name, self.target = name, target
        self.old, self.new = old, new
        self.detector, self.kind, self.why = detector, kind, why


SABOTAGES = [
    Sabotage(
        "grouping-scored-as-structure", "src/score.js",
        "  if (GROUPING_TYPES.has(type)) return 'grouping';",
        "  if (GROUPING_TYPES.has(type)) return 'structure';",
        ["node", "bin/recall.js", "fixtures"],
        why="a node in the wrong subgraph becomes a wrong graph"),
    Sabotage(
        "style-scored-as-structure", "src/score.js",
        "  if (STYLE_TYPES.has(type)) return 'style';",
        "  if (STYLE_TYPES.has(type)) return 'structure';",
        ["node", "--test", "tests/score.test.js"],
        why="a rounded box instead of a rectangle becomes a structural error"),
    Sabotage(
        "label-scored-as-structure", "src/score.js",
        "  if (LABEL_TYPES.has(type)) return 'label';",
        "  if (LABEL_TYPES.has(type)) return 'structure';",
        ["node", "bin/recall.js", "fixtures"],
        why="a typo in a caption becomes a wrong relation"),
    Sabotage(
        "reversal-pass-disabled", "src/score.js",
        "    const { directed } = parseKey(key);\n    if (!directed) continue;",
        "    const { directed } = parseKey(key);\n    continue;",
        ["node", "bin/recall.js", "fixtures"],
        why="a reversed arrow scores as two errors, one missing and one invented, "
            "instead of the single reversal it is"),
    Sabotage(
        "size-cap-removed", "src/score.js",
        "  approxNodes: 64,",
        "  approxNodes: 100000000,",
        ["node", "--test", "tests/score.test.js"],
        kind="guard",
        why="the refusal to run on an enormous graph is dormant on every fixture, so "
            "removing it changes nothing measurable and leaves an unbounded run in"),
]


def fingerprint(tree: Path) -> tuple[str, str]:
    out = subprocess.run(["node", "scripts/measure.mjs"], cwd=tree,
                         capture_output=True, text=True)
    text = out.stdout
    return hashlib.sha256(text.encode()).hexdigest()[:16], text


def main() -> int:
    if "--list" in sys.argv:
        for s in SABOTAGES:
            print(f"{s.kind:7s} {s.name:32s} {s.why}")
        return 0

    work = Path(tempfile.mkdtemp(prefix="diagram-recall-sabotage-"))
    try:
        base_fp, base_text = fingerprint(ROOT)
        print(f"=== baseline ===\n  fingerprint {base_fp}, {len(base_text)} bytes measured")

        # Null control. A different directory name must not change the measurement.
        null = work / "a-different-name-entirely"
        shutil.copytree(ROOT, null, ignore=shutil.ignore_patterns(".git", "node_modules"))
        null_fp, _ = fingerprint(null)
        print("=== null control ===")
        if null_fp != base_fp:
            print(f"  FAILED: unmodified copy fingerprints {null_fp}, not {base_fp}.")
            print("  Gate 2 would be satisfied by the copy alone, so no sabotage below")
            print("  could prove anything. Refusing to run them.")
            return 1
        print(f"  identical fingerprint {null_fp} from a differently named directory")

        failed = 0
        for s in SABOTAGES:
            print(f"\n=== {s.kind}: {s.name} ===\n  {s.why}")
            d = work / s.name
            shutil.rmtree(d, ignore_errors=True)
            shutil.copytree(ROOT, d, ignore=shutil.ignore_patterns(".git", "node_modules"))
            path = d / s.target
            text = path.read_text()
            if s.old not in text:
                print(f"  gate 1 FAILED: anchor not found in {s.target}, the patch is a no-op")
                failed += 1
                continue
            path.write_text(text.replace(s.old, s.new, 1))
            print(f"  gate 1 applied: {s.target} changed")

            fp, _ = fingerprint(d)
            moved = fp != base_fp
            if s.kind == "guard":
                if moved:
                    print(f"  gate 2 FAILED: the measured output moved to {fp}, so this is an "
                          "attack rather than a dormant guard")
                    failed += 1
                    continue
                print("  gate 2 UNCHANGED, as a dormant guard must be")
            else:
                if not moved:
                    print("  gate 2 FAILED: the measured output is identical, so this attack "
                          "proves nothing about the checks")
                    failed += 1
                    continue
                print(f"  gate 2 moved: fingerprint {fp}")

            got = subprocess.run(s.detector, cwd=d, capture_output=True, text=True)
            if got.returncode == 0:
                print(f"  gate 3 FAILED: {' '.join(s.detector)} still exits 0, uncaught")
                failed += 1
                continue
            print(f"  gate 3 caught by `{' '.join(s.detector)}` (exit {got.returncode})")

        attacks = sum(1 for s in SABOTAGES if s.kind == "attack")
        guards = len(SABOTAGES) - attacks
        print(f"\n{'=' * 48}")
        if failed:
            print(f"SABOTAGE SUITE FAILED: {failed} of {len(SABOTAGES)} did not clear their gates")
            return 1
        print(f"{len(SABOTAGES)} of {len(SABOTAGES)} sabotages proven, "
              f"{attacks} attacks and {guards} guards")
        print("SABOTAGE SUITE PASSED")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
