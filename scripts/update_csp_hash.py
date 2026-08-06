#!/usr/bin/env python3
"""
Recomputes the SHA-256 hash of the inline <script> block in index.html and
keeps it in sync with the 'sha256-...' entry in the CSP <meta> tag's
script-src directive.

Why this exists: the CSP uses a hash allowlist instead of 'unsafe-inline'
for script-src (see the design note at the top of index.html). That means
the hash in the CSP has to match the inline <script>...</script> content
byte-for-byte. If someone edits that script and forgets to update the
hash, the app white-screens in the browser (CSP blocks the script) with
only a console warning to explain why - not obvious to catch.

Usage:
  python3 scripts/update_csp_hash.py           # recompute and rewrite index.html if needed
  python3 scripts/update_csp_hash.py --check    # exit 1 if the hash is stale, don't modify anything
"""
import base64
import hashlib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "index.html"

# Matches the inline <script> ... </script> block that has no `src=` attribute
# (i.e. the one whose literal content the CSP hash must cover), not the
# cdnjs <script src="..."> tag.
INLINE_SCRIPT_RE = re.compile(rb"<script>\n(.*?\n)  </script>\n</body>", re.DOTALL)
CSP_HASH_RE = re.compile(rb"'sha256-[A-Za-z0-9+/=]+'")


def compute_hash(data: bytes) -> bytes:
    match = INLINE_SCRIPT_RE.search(data)
    if not match:
        print("ERROR: could not locate the inline <script> block in index.html "
              "(expected it right before </body>). Update INLINE_SCRIPT_RE in "
              "this script if the file structure changed.", file=sys.stderr)
        sys.exit(2)
    script_body = match.group(1)
    digest = hashlib.sha256(script_body).digest()
    return b"sha256-" + base64.b64encode(digest)


def main():
    check_only = "--check" in sys.argv

    data = INDEX_HTML.read_bytes()
    new_hash = compute_hash(data)
    new_token = b"'" + new_hash + b"'"

    existing_matches = CSP_HASH_RE.findall(data)
    if not existing_matches:
        print("ERROR: no 'sha256-...' token found in index.html's CSP meta tag.", file=sys.stderr)
        sys.exit(2)

    current_token = existing_matches[0]

    if current_token == new_token:
        print(f"CSP hash is up to date ({new_token.decode()}).")
        return

    if check_only:
        print("CSP hash is STALE.", file=sys.stderr)
        print(f"  meta tag has:  {current_token.decode()}", file=sys.stderr)
        print(f"  should be:     {new_token.decode()}", file=sys.stderr)
        print("Run: python3 scripts/update_csp_hash.py", file=sys.stderr)
        sys.exit(1)

    updated = data.replace(current_token, new_token, 1)
    INDEX_HTML.write_bytes(updated)
    print(f"Updated CSP hash: {current_token.decode()} -> {new_token.decode()}")


if __name__ == "__main__":
    main()
