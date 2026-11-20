#!/usr/bin/env bash
# Builds a complete BlueGenes tools directory without starting the server.
# Downloads the @intermine tools pinned in docker/intermine-tools.txt from the
# npm registry, then installs the alliance-tools/* packages on top.
# Usage: scripts/build-tools-dir.sh <tool-path>
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_path="${1:?usage: build-tools-dir.sh <tool-path>}"
pins="$repo/docker/intermine-tools.txt"

mkdir -p "$tool_path"

python3 -I - "$pins" "$tool_path" <<'PY'
import io, sys, tarfile, urllib.request
from pathlib import Path

pins, tool_path = Path(sys.argv[1]), Path(sys.argv[2])
entries = []
for line in pins.read_text().splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    name, version = line.split()
    base = name.split("/")[-1]
    url = f"https://registry.npmjs.org/{name}/-/{base}-{version}.tgz"
    data = urllib.request.urlopen(url, timeout=60).read()
    dest = tool_path / name
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            rel = Path(member.name.split("/", 1)[1])
            if rel.is_absolute() or ".." in rel.parts:
                sys.exit(f"unsafe path {member.name} in {url}")
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tar.extractfile(member).read())
    if not (dest / "dist" / "bundle.js").exists():
        sys.exit(f"{name}@{version} has no dist/bundle.js")
    entries.append(f'"{name}" "{version}"')
    print(f"installed {dest}")

(tool_path / "tools.edn").write_text(
    "{:tools {" + "\n         ".join(entries) + "}}\n")
PY

BLUEGENES_TOOL_PATH="$tool_path" "$repo/scripts/install-alliance-tools.sh"
