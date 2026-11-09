#!/usr/bin/env bash
# Installs each alliance-tools/* package into $BLUEGENES_TOOL_PATH/@alliance/<name>
# and registers it in $BLUEGENES_TOOL_PATH/tools.edn under :tools.
# Existing tools.edn entries are kept; a package already listed is not duplicated.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_path="${BLUEGENES_TOOL_PATH:-./tools}"
src_root="$repo/alliance-tools"

mkdir -p "$tool_path/@alliance"

for src in "$src_root"/*/; do
  [ -f "$src/package.json" ] || continue
  name="$(basename "$src")"
  dest="$tool_path/@alliance/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$src". "$dest"/
  rm -rf "$dest/test" "$dest/node_modules"
  python3 -I - "$src/package.json" "$tool_path/tools.edn" <<'PY'
import json, re, sys

pkg = json.load(open(sys.argv[1]))
edn_path = sys.argv[2]
entry = '"%s" "%s"' % (pkg["name"], pkg["version"])

try:
    text = open(edn_path).read()
except FileNotFoundError:
    text = ""

if not text.strip():
    text = "{:tools {}}\n"

if re.search(r'"%s"\s+"' % re.escape(pkg["name"]), text):
    # Same package already listed: update its version in place.
    text = re.sub(r'("%s"\s+)"[^"]*"' % re.escape(pkg["name"]),
                  lambda m: m.group(1) + '"%s"' % pkg["version"], text, count=1)
else:
    m = re.search(r':tools\s*\{', text)
    if not m:
        sys.exit("tools.edn has no :tools map: " + edn_path)
    # Find the closing brace of the :tools map.
    depth, i, in_str = 0, m.end() - 1, False
    while i < len(text):
        c = text[i]
        if in_str:
            if c == "\\":
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    head = text[:i].rstrip()
    sep = "" if head.endswith("{") else "\n         "
    text = head + sep + entry + text[i:]

open(edn_path, "w").write(text)
PY
  echo "installed $dest"
done
