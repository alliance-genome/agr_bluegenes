#!/usr/bin/env bash
# Lists the http(s) hosts named in each @intermine tool bundle under <tool-path>
# and fails on any host missing from docker/tool-hosts-allowlist.txt, so a
# version bump that adds a new third-party host gets a review.
# Usage: scripts/audit-tool-hosts.sh <tool-path> [allowlist]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_path="${1:?usage: audit-tool-hosts.sh <tool-path> [allowlist]}"
allowlist="${2:-$repo/docker/tool-hosts-allowlist.txt}"

python3 -I - "$tool_path" "$allowlist" <<'PY'
import re, sys
from pathlib import Path

tool_path, allowlist = Path(sys.argv[1]), Path(sys.argv[2])
allowed = {l.strip() for l in allowlist.read_text().splitlines()
           if l.strip() and not l.startswith("#")}
unknown = {}
for bundle in sorted((tool_path / "@intermine").glob("*/dist/*.js")):
    tool = bundle.parts[-3]
    for host in set(re.findall(r"https?://([A-Za-z0-9.-]+)", bundle.read_text(errors="ignore"))):
        if host.lower().rstrip(".") not in allowed:
            unknown.setdefault(host, set()).add(tool)
for host, tools in sorted(unknown.items()):
    print(f"unlisted host {host} in {', '.join(sorted(tools))}", file=sys.stderr)
if unknown:
    sys.exit(f"{len(unknown)} host(s) not in {allowlist}")
print("all hosts are allowlisted")
PY
