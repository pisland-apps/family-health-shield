# vendor/

This folder should contain a single file: `jszip.min.js` (JSZip 3.10.1),
vendored locally instead of loaded from cdnjs, so the app has zero
third-party script origins and no CDN supply-chain exposure.

**That file is intentionally NOT included in this zip** — it was generated
in a sandbox with no network access, so the real bytes couldn't be fetched
and verified here. Run one of the commands below yourself before deploying.

Every command below both downloads the file AND verifies it against the
SRI hash you already confirmed via cdnjs.com's own "Copy SRI Hash" button,
so you get the same supply-chain check as before, just done once at build
time instead of by the browser on every page load.

Expected hash:
```
sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==
```

## macOS / Linux
```bash
cd vendor
curl -sL https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js -o jszip.min.js
actual=$(openssl dgst -sha512 -binary jszip.min.js | openssl base64 -A)
expected="XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg=="
if [ "$actual" = "$expected" ]; then
  echo "✅ Hash matches — jszip.min.js is verified."
else
  echo "❌ Hash mismatch — DO NOT use this file. Got: $actual"
fi
```

## Windows PowerShell
```powershell
cd vendor
Invoke-WebRequest -Uri "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js" -OutFile jszip.min.js
$hash = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash([System.IO.File]::ReadAllBytes("jszip.min.js")))
$expected = "XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg=="
if ($hash -eq $expected) { Write-Host "✅ Hash matches — jszip.min.js is verified." }
else { Write-Host "❌ Hash mismatch — DO NOT use this file. Got: $hash" }
```

If either check fails, don't use the downloaded file — re-download once
(transient corruption) and if it still fails, stop and investigate before
deploying; that mismatch is exactly the supply-chain-tampering scenario
this whole exercise is meant to catch.

Once verified, delete this README or leave it — either is fine, it's not
referenced by index.html.
