#!/usr/bin/env bash
# Verify diagram-recall. The exit code of this script is the result.
#
#   bash scripts/verify.sh
#
# There is no skip path. Chrome is a hard requirement rather than an optional extra,
# because the drill is a web page and a run that quietly stopped before opening it would
# report the same green as one that opened it and measured it.
#
# Steps print as "== N. name" and never as "## name". The README's Status section holds
# this transcript, and a section reader that stops at the next Markdown heading would cut
# the section short at the first step and hide the success line sitting inside it.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
FAILED=0
STAGE=0

step() { STAGE=$((STAGE + 1)); printf '\n== %d. %s\n' "$STAGE" "$1"; }
fail() { printf '   FAIL: %s\n' "$1"; FAILED=$((FAILED + 1)); }
tree_digest() {
  git ls-files -z | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1
}

# ---------------------------------------------------------------- prerequisites
step "prerequisites"
for tool in node python3 git; do
  command -v "$tool" >/dev/null || { echo "$tool is required, install it and rerun"; exit 1; }
done
command -v google-chrome >/dev/null || command -v chromium >/dev/null || {
  echo "google-chrome or chromium is required: the drill is a web page and this suite"
  echo "measures it in a real browser rather than asserting about it"; exit 1; }
node --version
python3 --version
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "this is not a git work tree, and several checks ask git directly"; exit 1; }
BEFORE="$(tree_digest)"
PORCELAIN_BEFORE="$(git status --porcelain)"
echo "   tracked file digest before: ${BEFORE:0:16}"

# ---------------------------------------------------------------------- unit suite
step "unit tests"
UNIT_OUT="$(node --test tests/*.test.js 2>&1)"
UNIT_COUNT="$(echo "$UNIT_OUT" | sed -n 's/^# *pass \([0-9]*\)$/\1/p' | tail -1)"
[ -z "$UNIT_COUNT" ] && UNIT_COUNT="$(echo "$UNIT_OUT" | sed -n 's/.*ℹ pass \([0-9]*\)/\1/p' | tail -1)"
UNIT_FAIL="$(echo "$UNIT_OUT" | sed -n 's/.*ℹ fail \([0-9]*\)/\1/p' | tail -1)"
echo "   $UNIT_COUNT passed, ${UNIT_FAIL:-?} failed"
[ "${UNIT_FAIL:-1}" = "0" ] || { echo "$UNIT_OUT" | tail -20; fail "the unit suite did not pass"; }
# A floor, not an equality. It catches a suite that collapsed to nothing, which is how a
# test run fails silently: the runner finds no files and reports success.
[ -n "$UNIT_COUNT" ] && [ "$UNIT_COUNT" -ge 70 ] || \
  fail "expected at least 70 unit tests, the runner reported '${UNIT_COUNT:-none}'"

# ------------------------------------------------------------ hand written fixtures
step "fixtures against hand computed expectations"
node bin/recall.js fixtures || fail "a fixture disagreed with its hand computed expectation"

# -------------------------------------------------- independent recomputation
step "the scores recomputed by code that shares nothing with the package"
python3 scripts/check_independent.py || fail "the independent recomputation disagreed"

step "the independence prover is shown able to reject"
python3 scripts/check_independent.py --prove-independence || fail "the import graph proof did not hold"

# ------------------------------------------------------------------ privacy sweep
step "no credentials, home directory paths, or NUL bytes in tracked files"
python3 scripts/privacy_scan.py || fail "the tracked file sweep found something, or its controls did not fire"

# ------------------------------------------------------------------- the real page
step "the published page measured in real headless Chrome"
python3 scripts/browser_check.py || fail "the page did not behave as claimed in a real browser"

step "the committed page matches a fresh build"
node bin/recall.js build-page --check || fail "docs/index.html is stale, rebuild with build-page"

# --------------------------------------------------------------------- sabotage
step "sabotage: break the scorer on purpose and require a check to notice"
python3 scripts/sabotage.py
[ $? -eq 0 ] || fail "at least one sabotage was a no-op or went uncaught"

# ----------------------------------------------------------------------- README
step "the README describes what actually happened"
python3 - "$UNIT_COUNT" <<'PY' || fail "the README is out of step with this run"
import re, sys

wanted = sys.argv[1]
problems = []
text = open("README.md", encoding="utf-8").read()

# Headings are only headings outside a fenced block. The Status section holds this
# script's transcript, and any line in it that began with ## would otherwise end the
# section early and hide what the check is looking for.
def section(body, heading):
    lines, fenced, start = body.split("\n"), False, None
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        if line.strip().startswith("##"):
            name = line.strip().lstrip("#").strip().lower()
            if start is None and name == heading.lower():
                start = i
            elif start is not None:
                return "\n".join(lines[start + 1:i])
    return None if start is None else "\n".join(lines[start + 1:])

prose = []
fenced = False
for line in text.split("\n"):
    if line.lstrip().startswith("```"):
        fenced = not fenced
        prose.append("")
        continue
    prose.append("" if fenced else line)
prose = "\n".join(prose)

for marker in ("TODO", "FIXME", "NOT YET VERIFIED", "replace with a real description"):
    if marker in prose:
        problems.append("the scaffold marker %r is still in the prose" % marker)

for required in ("What this is", "Running it", "Status", "Unfinished"):
    if section(text, required) is None:
        problems.append("no '## %s' section" % required)

status = section(text, "Status")
# NEVER write the success line itself here. This script's output is pasted into the Status
# section this check reads, so quoting it would plant a second copy in the README and the
# check would then pass on its own announcement whatever the run said. The same applies to
# the failure branch, since a failing transcript can be pasted just as easily.
sentinel = "VERIFY " + "PASSED: diagram-recall"
if status is not None and sentinel not in status:
    problems.append("the Status section does not carry this script's success line, so it "
                    "does not hold the output of a passing run")

claims = re.findall(r"(\d+) unit tests", text)
if not claims:
    problems.append("the README states no unit test count, and a count never stated "
                    "cannot go stale, but it also cannot be checked")
for claim in set(claims):
    if claim != wanted:
        problems.append("the README claims %s unit tests and %s ran just now" % (claim, wanted))

for message in problems:
    print("   %s" % message)
print("   README checks: %d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
PY

# ------------------------------------------------------- the run changed nothing
step "this run did not modify the tree it verified"
AFTER="$(tree_digest)"
echo "   tracked file digest after:  ${AFTER:0:16}"
[ "$BEFORE" = "$AFTER" ] || {
  fail "verify modified a tracked file, so a later run could pass for reasons this one created"
  git status --porcelain
}
# Compared against the state at the start rather than against clean, so a tree that was
# already dirty is not reported as damage this run did. A file that appeared during the
# run is damage.
if [ "$PORCELAIN_BEFORE" != "$(git status --porcelain)" ]; then
  diff <(printf '%s\n' "$PORCELAIN_BEFORE") <(git status --porcelain) || true
  fail "the run added or removed files in the working tree"
fi

# ---------------------------------------------------------------------- verdict
printf '\n'
if [ "$FAILED" -ne 0 ]; then
  echo "VERIFY FAILED: $FAILED check(s) did not pass, across $STAGE steps"
  exit 1
fi
echo "VERIFY PASSED: diagram-recall, $STAGE of $STAGE steps, $UNIT_COUNT unit tests"
