#!/usr/bin/env python3
"""Scan every tracked file for credential-shaped strings and personal paths.

Four things here exist because the obvious version of this script fails silently.

**The patterns are assembled from fragments.** A scanner holding its own pattern list as
literal text matches itself on the first run, and the usual repair is to exclude the scanner
from the scan, which disarms the check exactly where it is tested. Splitting each pattern
across a concatenation means no complete pattern exists as a contiguous string on disk, so the
scanner reads clean without an exclusion. It also keeps GitHub's push protection quiet, which
rejects a whole push over one synthetic key and scans full history, so a later fix does not
help.

**It reads bytes, not text, and it does not use grep.** One NUL byte anywhere in a file makes
git and grep classify the whole file as binary, and ``grep -I`` then skips it entirely. A real
token committed into such a file has been proven invisible to a grep-based sweep in this
workspace. Reading bytes in Python sees it. ``grep -P '\\x00'`` is not available in every grep
on this machine and returns no matches where Python finds the byte immediately, so the NUL
check is done in Python too.

**A positive control runs first.** Two synthetic secrets are written to a scratch file outside
the repository and fed through the same scan function, one of them behind a NUL byte. If
either is missed the run aborts, because a scanner that reads nothing is silent in exactly the
same way as a clean tree.

**An empty file list is a failure.** Before the first commit ``git ls-files`` returns nothing
and the scan passes without opening a file.

Exit codes: 0 clean, 1 findings, 2 the scan itself could not be trusted.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, NamedTuple

ROOT = Path(__file__).resolve().parent.parent

# Files whose whole job is to talk about credentials. None right now; the list exists so that
# adding one is a deliberate, visible act rather than a quiet regex tweak.
ALLOWED_PATHS: set[str] = set()

MINIMUM_TRACKED_FILES = 15


class Pattern(NamedTuple):
    name: str
    regex: re.Pattern
    why: str


def _build_patterns(user_override: str | None = None) -> List[Pattern]:
    """Every pattern is glued together here, so none of them exists as a literal above.

    `user_override` exists so the account-name patterns can be exercised against a substituted
    value. Two of these patterns read the environment, and on GitHub the account is `runner`,
    so a check that only ever runs under the author's own username proves nothing about what
    happens in CI. `substituted_user_control` below runs the scan under a fake name.
    """
    az = "A-Za-z0-9"
    home = os.path.expanduser("~")
    user = user_override if user_override is not None else Path(home).name

    def compile_case_sensitive(body: str) -> re.Pattern:
        # Deliberately NOT re.IGNORECASE. AWS key ids are uppercase by definition, and a
        # case-insensitive sweep matches base64 inside an inline image on any page.
        return re.compile(body)

    patterns = [
        Pattern("github personal access token",
                compile_case_sensitive("gh" + "[pousr]" + "_" + f"[{az}]{{36,255}}"),
                "GitHub tokens are unmistakable and are revoked on publication"),
        Pattern("aws access key id",
                compile_case_sensitive("(?:A" + "KIA|A" + "SIA)" + "[0-9A-Z]{16}"),
                "uppercase by definition, so the pattern stays case sensitive"),
        Pattern("openai key",
                compile_case_sensitive("sk" + "-" + f"[{az}]{{20,}}"),
                "matches the OpenAI and OpenRouter shapes"),
        Pattern("openrouter key",
                compile_case_sensitive("sk" + "-or-" + "v1-" + "[0-9a-f]{64}"),
                "the fleet's OpenRouter key shape"),
        Pattern("slack token",
                compile_case_sensitive("xox" + "[abposr]" + "-" + f"[{az}-]{{10,}}"),
                "Slack bot and user tokens"),
        Pattern("google api key",
                compile_case_sensitive("AI" + "za" + f"Sy[{az}_-]{{33}}"),
                "Gemini and other Google keys"),
        Pattern("private key block",
                compile_case_sensitive("-----BEGIN " + "[A-Z ]*PRIVATE" + " KEY-----"),
                "any PEM private key"),
        Pattern("bearer authorization header",
                compile_case_sensitive("[Aa]uthorization" + r"\s*[:=]\s*[\"']?" + "Bearer "
                                       + f"[{az}._-]{{20,}}"),
                "a hardcoded Authorization header"),
        Pattern("assigned api secret",
                re.compile("(?i)(?:api[_-]?key|secret|passwd|password|token)"
                           + r"\s*[:=]\s*[\"']" + f"[{az}/+_-]{{16,}}" + "[\"']"),
                "an assignment whose right-hand side looks like a real value"),
    ]
    if user and user not in ("root", ""):
        patterns.append(
            Pattern("home directory path",
                    compile_case_sensitive("/home/" + re.escape(user) + "/"),
                    "an absolute path naming the account, both private and unportable"))
        patterns.append(
            Pattern("bare username",
                    compile_case_sensitive(r"\b" + re.escape(user) + r"@"),
                    "an email local part or shell prompt naming the account"))
    return patterns


PATTERNS = _build_patterns()


class Finding(NamedTuple):
    path: str
    line: int
    pattern: str
    excerpt: str


def _redact(text: str) -> str:
    """Never print a whole match. A findings log is itself a place a secret can leak to."""
    body = text.strip()
    if len(body) <= 12:
        return body
    return f"{body[:6]}...{body[-4:]} ({len(body)} chars)"


def scan_bytes(path_label: str, blob: bytes) -> List[Finding]:
    """Scan one file's raw bytes. Never skips on NUL, never skips on a decode error."""
    text = blob.decode("utf-8", errors="replace")
    findings: List[Finding] = []
    for number, line in enumerate(text.splitlines(), 1):
        for pattern in PATTERNS:
            for match in pattern.regex.finditer(line):
                findings.append(Finding(path_label, number, pattern.name,
                                        _redact(match.group(0))))
    return findings


def scan_files(paths: Iterable[tuple[str, Path]]) -> tuple[List[Finding], int, List[str]]:
    findings: List[Finding] = []
    read = 0
    with_nul: List[str] = []
    for label, path in paths:
        try:
            blob = path.read_bytes()
        except (OSError, IsADirectoryError):
            continue
        read += 1
        if b"\0" in blob:
            with_nul.append(label)
        if label in ALLOWED_PATHS:
            continue
        findings.extend(scan_bytes(label, blob))
    return findings, read, with_nul


def positive_control() -> tuple[bool, List[str]]:
    """Plant synthetic secrets and require the scanner to find both.

    The second one sits behind a NUL byte, which is the exact condition under which a
    grep-based sweep goes blind while reporting success.
    """
    notes: List[str] = []
    az = "abcdefghijklmnopqrstuvwxyz0123456789"
    fake_github = "gh" + "p_" + (az * 2)[:36]
    fake_aws = "AK" + "IA" + "ABCDEFGHIJKLMNOP"

    with tempfile.TemporaryDirectory(prefix="recall-privacy-control-") as directory:
        plain = Path(directory) / "planted.txt"
        plain.write_text(f"token = {fake_github}\n", encoding="utf-8")

        binaryish = Path(directory) / "planted-with-nul.txt"
        binaryish.write_bytes(b"separator\0field\naws " + fake_aws.encode() + b"\n")

        findings, read, with_nul = scan_files(
            [("control/planted.txt", plain), ("control/planted-with-nul.txt", binaryish)])

    if read != 2:
        return False, [f"the control planted 2 files and the scanner opened {read}"]
    names = {f.pattern for f in findings}
    ok = True
    if "github personal access token" not in names:
        ok = False
        notes.append("the planted GitHub token was NOT found, so the scan is not reading files")
    else:
        notes.append("planted GitHub token found in a plain file")
    if "aws access key id" not in names:
        ok = False
        notes.append("the planted AWS key behind a NUL byte was NOT found, so the scan goes "
                     "blind on exactly the files a grep sweep skips")
    else:
        notes.append("planted AWS key found in a file containing a NUL byte")
    if "control/planted-with-nul.txt" not in with_nul:
        ok = False
        notes.append("the NUL byte in the control file was not detected")
    return ok, notes


def substituted_user_control() -> tuple[bool, List[str]]:
    """Run the account-name patterns against a substituted username, twice.

    Once as `runner`, which is the account every GitHub Actions job runs as, and once as a name
    that appears nowhere. Both must fire on planted text and neither may fire on the tracked
    tree, which is what tells us the tree carries no absolute home path under any name.
    """
    notes: List[str] = []
    ok = True
    for fake in ("runner", "zzplaceholderzz"):
        patterns = _build_patterns(fake)
        planted = f"path = /home/{fake}/Projects/thing\ncontact {fake}@example.invalid\n"
        names = {
            pattern.name
            for pattern in patterns
            for line in planted.splitlines()
            if pattern.regex.search(line)
        }
        if "home directory path" not in names or "bare username" not in names:
            ok = False
            notes.append(
                f"under the substituted account {fake!r} the planted home path or username "
                f"was NOT matched, so the check would go quiet on a runner with that account"
            )
        else:
            notes.append(f"account patterns fire under the substituted account {fake!r}")
    return ok, notes


def scan_with_patterns(paths, patterns) -> List[Finding]:
    """The same sweep as `scan_files`, under a pattern list the caller chose."""
    global PATTERNS
    original = PATTERNS
    PATTERNS = patterns
    try:
        findings, _, _ = scan_files(paths)
        return findings
    finally:
        PATTERNS = original


def tracked_files() -> List[tuple[str, Path]]:
    result = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True)
    labels = [p for p in result.stdout.decode().split("\0") if p]
    return [(label, ROOT / label) for label in labels]


def self_check() -> List[str]:
    """The scanner must not match its own pattern list. Asserted, not assumed."""
    me = Path(__file__).resolve()
    findings, _, _ = scan_files([(me.name, me)])
    return [f"{f.pattern} at line {f.line}" for f in findings]


def main() -> int:
    print("privacy scan")
    print(f"  {len(PATTERNS)} patterns, every one assembled from fragments at import time")

    ok, notes = positive_control()
    for note in notes:
        print(f"  control: {note}")
    if not ok:
        print("FAIL: the positive control did not fire, so a clean result would mean nothing",
              file=sys.stderr)
        return 2

    ok, notes = substituted_user_control()
    for note in notes:
        print(f"  control: {note}")
    if not ok:
        print("FAIL: the account-name patterns do not fire under a substituted username, so "
              "they would be silent on a CI runner", file=sys.stderr)
        return 2

    own = self_check()
    if own:
        print("FAIL: the scanner matches its own source, so the pattern list is written as "
              "literal text somewhere it should not be:", file=sys.stderr)
        for line in own:
            print("  " + line, file=sys.stderr)
        return 2
    print("  control: the scanner does not match its own source")

    files = tracked_files()
    if len(files) < MINIMUM_TRACKED_FILES:
        print(f"FAIL: only {len(files)} tracked files. Before the first commit 'git ls-files' "
              f"returns nothing and this scan passes without opening a file, which is "
              f"indistinguishable from a clean tree. Commit first.", file=sys.stderr)
        return 2

    # The tracked tree under a CI account's patterns. This is the run that would have caught
    # the fleet's "passed locally, failed on GitHub" privacy scan, where the pattern was keyed
    # on a username that is `runner` there and something else here.
    for fake in ("runner", "zzplaceholderzz"):
        substituted = scan_with_patterns(files, _build_patterns(fake))
        if substituted:
            print(f"FAIL: under the substituted account {fake!r} the tracked tree has "
                  f"{len(substituted)} finding(s), so this repository would fail a scan run "
                  f"on a machine with that account:", file=sys.stderr)
            for finding in substituted:
                print(f"  {finding.path}:{finding.line}  {finding.pattern}", file=sys.stderr)
            return 1
    print("  control: the tracked tree is clean under substituted account names too")

    findings, read, with_nul = scan_files(files)
    print(f"  read {read} of {len(files)} tracked files as raw bytes")
    if with_nul:
        print(f"FAIL: {len(with_nul)} tracked file(s) contain a NUL byte, which makes git and "
              f"grep treat them as binary and skip them in any other sweep. Write the byte as "
              f"the two-character escape \\0 instead:", file=sys.stderr)
        for label in with_nul:
            print("  " + label, file=sys.stderr)
        return 1

    if findings:
        print(f"FAIL: {len(findings)} credential-shaped or personal string(s) found",
              file=sys.stderr)
        for finding in findings:
            print(f"  {finding.path}:{finding.line}  {finding.pattern}  {finding.excerpt}",
                  file=sys.stderr)
        return 1

    print(f"clean: no credential-shaped strings, no personal paths, no NUL bytes in "
          f"{read} tracked files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
