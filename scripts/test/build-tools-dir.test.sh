#!/usr/bin/env bash
# Tests scripts/build-tools-dir.sh and scripts/audit-tool-hosts.sh against a
# local fake npm registry. Usage: scripts/test/build-tools-dir.test.sh
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
server_pid=""
cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

failures=0
check() { # check <label> <command...>
  local label="$1"; shift
  if "$@"; then echo "ok   $label"; else echo "FAIL $label"; failures=$((failures + 1)); fi
}

mkdir -p "$work/registry"
python3 -I - "$work" <<'PY'
import base64, hashlib, io, sys, tarfile
from pathlib import Path

work = Path(sys.argv[1])
files = {
    "package/package.json": b'{"name":"@t/tool"}',
    "package/config.json": b"{}",
    "package/preview.png": b"png",
    "package/dist/bundle.js": b"// see https://example.org/docs and http://cdn.bad.example/x.js",
    "package/src/index.js": b"src",
    "package/demo.html": b"demo",
    "package/test/a.js": b"test",
    "stray.txt": b"no directory",
}
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for name, body in files.items():
        info = tarfile.TarInfo(name)
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))
data = buf.getvalue()
tarball = work / "registry" / "@t" / "tool" / "-" / "tool-1.0.0.tgz"
tarball.mkdir(parents=True)
(tarball / "body").write_bytes(data)
sri = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
(work / "good.txt").write_text(f"@t/tool 1.0.0 {sri}\n")
(work / "bad.txt").write_text("@t/tool 1.0.0 sha512-" + "A" * 86 + "==\n")
(work / "nohash.txt").write_text("@t/tool 1.0.0\n")
PY

cat > "$work/server.py" <<'PY'
import http.server, sys
from pathlib import Path

root, flaky = Path(sys.argv[1]), int(sys.argv[2])
hits = {"n": 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        hits["n"] += 1
        if hits["n"] <= flaky:
            self.send_response(429)
            self.end_headers()
            return
        body = (root / self.path.lstrip("/") / "body").read_bytes()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
PY

start_registry() { # start_registry <flaky-count>
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  python3 -I "$work/server.py" "$work/registry" "$1" > "$work/port" &
  server_pid=$!
  for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
  export BLUEGENES_NPM_REGISTRY="http://127.0.0.1:$(cat "$work/port")"
}

build() { # build <pins> <out>
  BLUEGENES_TOOL_PINS="$1" "$repo/scripts/build-tools-dir.sh" "$2" > "$work/build.log" 2>&1
}

mkdir -p "$work/empty-alliance"
export BLUEGENES_ALLIANCE_TOOLS="$work/empty-alliance"

start_registry 0
check "good hash installs" build "$work/good.txt" "$work/out1"
check "dist/bundle.js kept" test -f "$work/out1/@t/tool/dist/bundle.js"
check "package.json, config.json, preview.png kept" test -f "$work/out1/@t/tool/package.json" -a -f "$work/out1/@t/tool/config.json" -a -f "$work/out1/@t/tool/preview.png"
check "src, demo and test dropped" test ! -e "$work/out1/@t/tool/src" -a ! -e "$work/out1/@t/tool/demo.html" -a ! -e "$work/out1/@t/tool/test"
check "top-level tar file is skipped" test ! -e "$work/out1/@t/tool/stray.txt" -a ! -e "$work/out1/stray.txt"
check "tools.edn lists the tool" grep -q '"@t/tool" "1.0.0"' "$work/out1/tools.edn"

mkdir -p "$work/out2/@intermine/removed"
check "stale tools are removed on rebuild" bash -c "
  BLUEGENES_TOOL_PINS='$work/good.txt' '$repo/scripts/build-tools-dir.sh' '$work/out2' >/dev/null 2>&1 && test ! -e '$work/out2/@intermine/removed'"

mismatch_rejected() { ! build "$work/bad.txt" "$work/out3" && grep -q "integrity mismatch" "$work/build.log" && [ ! -e "$work/out3/@t/tool" ]; }
check "wrong hash fails and installs nothing" mismatch_rejected

nohash_rejected() { ! build "$work/nohash.txt" "$work/out4" && grep -q "sha512 integrity" "$work/build.log"; }
check "pin without hash fails" nohash_rejected

start_registry 2
check "429 is retried" build "$work/good.txt" "$work/out5"

start_registry 5
failed_download() { ! build "$work/good.txt" "$work/out6" && grep -q "@t/tool: download failed (HTTP 429)" "$work/build.log"; }
check "persistent 429 fails naming the tool" failed_download

host_tree="$work/hosts"
mkdir -p "$host_tree/@intermine/a/dist"
echo "// https://example.org/docs and http://cdn.bad.example/x.js" > "$host_tree/@intermine/a/dist/bundle.js"
printf 'example.org\n' > "$work/allow-short.txt"
printf 'example.org\ncdn.bad.example\n' > "$work/allow-full.txt"
check "audit fails on an unlisted host" bash -c "! '$repo/scripts/audit-tool-hosts.sh' '$host_tree' '$work/allow-short.txt' 2>'$work/audit.log' && grep -q 'unlisted host cdn.bad.example in a' '$work/audit.log'"
check "audit passes when every host is listed" "$repo/scripts/audit-tool-hosts.sh" "$host_tree" "$work/allow-full.txt"

[ "$failures" -eq 0 ] && echo "all passed" || { echo "$failures failed"; exit 1; }
