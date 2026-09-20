#!/usr/bin/env python3
"""
Regenerates the CSP hash for index.html's <style> block.

Why this exists: style-src is locked to 'self' + a specific sha256 hash of the
exact <style>...</style> content, instead of 'unsafe-inline'. That's tighter,
but it means ANY edit to that CSS block -- even adding one rule -- changes its
hash, and the page's styling will silently break (browser just drops the whole
stylesheet, no console-visible layout, just unstyled HTML) until both CSP
copies are updated to match. This script computes the correct hash from the
current file so you don't have to do it by hand.

Usage, after editing the CSS inside <style>...</style> in index.html:
    python3 regen-style-hash.py

Then paste the printed hash into BOTH:
  - index.html: the style-src line inside the <meta http-equiv="Content-Security-Policy"> tag
  - _headers:   the style-src segment of the Content-Security-Policy line

Both copies must match exactly, or the stricter of the two wins and the page
breaks anyway.
"""
import hashlib
import base64
import sys

def main():
    with open('index.html', encoding='utf-8') as f:
        content = f.read()

    # Anchor off the last closing tag and the nearest preceding opening tag
    # - not a naive first-match, since an existing design-notes comment
    # earlier in the file legitimately discusses "<style>" several times in
    # plain text, and a strict "exactly one occurrence in the whole file"
    # check would wrongly reject that.
    try:
        end = content.rindex('</style>')
        start = content.rfind('<style>', 0, end) + len('<style>')
    except ValueError:
        print("ERROR: couldn't find <style>...</style> in index.html", file=sys.stderr)
        sys.exit(1)

    style_content = content[start:end]

    # This is the check that actually matters, and the one that was missing
    # before: the EXTRACTED SPAN itself must never contain the literal
    # substrings "<style>" or "</style>" - a real CSS block never
    # legitimately contains either. This has already broken once: a CSS
    # comment INSIDE the real style block said something like "no inline
    # <style> tag", and rfind() picked THAT occurrence as the boundary
    # instead of the true opening tag further up, silently hashing a much
    # shorter, wrong span. The browser hashes the REAL full block regardless
    # of what any comment says, so the mismatched hash shipped, CSP silently
    # rejected the whole stylesheet, and nothing in the console pointed at
    # why - it just looked like unstyled HTML. Failing loudly here beats
    # that class of bug reaching a screenshot again.
    if '<style>' in style_content or '</style>' in style_content:
        print("ERROR: the extracted <style> block content itself contains "
              "a literal '<style>' or '</style>' substring - almost "
              "certainly inside a CSS comment describing the tag by name. "
              "This makes the boundary detection above unreliable (it may "
              "have already picked the wrong span). Find and reword that "
              "comment so it doesn't contain the literal tag text, then "
              "rerun this script.", file=sys.stderr)
        sys.exit(1)

    # Cheap sanity floor - the real stylesheet has always been tens of KB;
    # anything drastically shorter means the extraction is almost certainly
    # wrong even though the check above passed, so don't print a hash that
    # looks plausible but isn't.
    if len(style_content) < 5000:
        print(f"ERROR: extracted style content is only {len(style_content)} "
              f"chars, which is far shorter than expected - refusing to "
              f"print a hash. Double check the <style>/</style> tags were "
              f"found correctly.", file=sys.stderr)
        sys.exit(1)

    digest = hashlib.sha256(style_content.encode('utf-8')).digest()
    b64 = base64.b64encode(digest).decode('ascii')
    csp_hash = f"sha256-{b64}"

    print(csp_hash)

if __name__ == '__main__':
    main()
