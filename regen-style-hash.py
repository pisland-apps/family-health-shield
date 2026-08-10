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

    # Anchor off the closing tag (should be unique) and take the nearest
    # preceding opening tag, rather than the first '<style>' substring in the
    # file -- the CSP design-notes comment above also mentions "<style>" in
    # passing, and naively taking the first match grabs the wrong span.
    try:
        end = content.rindex('</style>')
        start = content.rfind('<style>', 0, end) + len('<style>')
    except ValueError:
        print("ERROR: couldn't find <style>...</style> in index.html", file=sys.stderr)
        sys.exit(1)

    style_content = content[start:end]
    digest = hashlib.sha256(style_content.encode('utf-8')).digest()
    b64 = base64.b64encode(digest).decode('ascii')
    csp_hash = f"sha256-{b64}"

    print(csp_hash)

if __name__ == '__main__':
    main()
