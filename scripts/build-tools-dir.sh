#!/usr/bin/env bash
# Builds a complete BlueGenes tools directory without starting the server.
# Downloads the @intermine tools pinned in docker/intermine-tools.txt from the
# npm registry, verifies each tarball against its pinned sha512 integrity, keeps
# only the files the tool store serves, then installs the alliance-tools/*
# packages on top.
# Usage: scripts/build-tools-dir.sh <tool-path>
# BLUEGENES_NPM_REGISTRY overrides https://registry.npmjs.org (used by tests).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_path="${1:?usage: build-tools-dir.sh <tool-path>}"
pins="${BLUEGENES_TOOL_PINS:-$repo/docker/intermine-tools.txt}"

mkdir -p "$tool_path"
rm -rf "$tool_path/@intermine"

python3 -I - "$pins" "$tool_path" "${BLUEGENES_NPM_REGISTRY:-https://registry.npmjs.org}" <<'PY'
import base64, hashlib, io, sys, tarfile, time, urllib.error, urllib.request
from pathlib import Path

MAX_BYTES = 20 * 1024 * 1024
ATTEMPTS = 3
KEEP_FILES = {"package.json", "config.json", "preview.png"}

pins, tool_path, registry = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].rstrip("/")


def download(name, url):
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as res:
                data = res.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                sys.exit(f"{name}: tarball is larger than {MAX_BYTES} bytes")
            return data
        except urllib.error.HTTPError as e:
            retry = e.code == 429 or e.code >= 500
            problem = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError) as e:
            retry, problem = True, str(e)
        if not retry or attempt == ATTEMPTS:
            sys.exit(f"{name}: download failed ({problem}) from {url}")
        wait = 2 ** attempt
        print(f"{name}: {problem}, retrying in {wait}s", file=sys.stderr)
        time.sleep(wait)


def wanted(rel):
    return rel.parts[0] == "dist" or str(rel) in KEEP_FILES


entries = []
for line in pins.read_text().splitlines():
    if not line.strip() or line.startswith("#"):
        continue
    fields = line.split()
    if len(fields) != 3 or not fields[2].startswith("sha512-"):
        sys.exit(f"pin needs name, version and sha512 integrity: {line!r}")
    name, version, integrity = fields
    base = name.split("/")[-1]
    url = f"{registry}/{name}/-/{base}-{version}.tgz"
    data = download(name, url)
    actual = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != integrity:
        sys.exit(f"{name}@{version}: integrity mismatch, expected {integrity} got {actual}")
    dest = tool_path / name
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile() or "/" not in member.name:
                continue
            rel = Path(member.name.split("/", 1)[1])
            if rel.is_absolute() or ".." in rel.parts:
                sys.exit(f"unsafe path {member.name} in {url}")
            if not wanted(rel):
                continue
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
