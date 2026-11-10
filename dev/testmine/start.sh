#!/bin/bash
# Build and start the AllianceMine test mine with intermine_boot.
#
#   dev/testmine/start.sh            build from scratch and start (about 20 to 40 minutes)
#   dev/testmine/start.sh stop       stop and remove the containers
#
# Service root: http://localhost:9999/alliancetestmine
#
# Environment:
#   INTERMINE_BOOT  path to the intermine_boot executable (default: first on PATH)
#   MEM_OPTS        JVM options for the containers (default: -Xmx2g -Xms1g)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
boot="${INTERMINE_BOOT:-$(command -v intermine_boot || true)}"
service_root="http://localhost:9999/alliancetestmine"

if [ -z "$boot" ] || [ ! -x "$boot" ]; then
    echo "intermine_boot not found. Install it (pip install intermine_boot 'setuptools<81') or set INTERMINE_BOOT." >&2
    exit 1
fi

if [ "${1:-}" = "stop" ]; then
    "$boot" stop local
    exit 0
fi

# intermine_boot names the mine after the last component of --datapath-im, and its
# builder image only finds its bundled data tarball when that name is "biotestmine".
# Stage a copy of mine/ under that name. The web context is set to alliancetestmine
# in data/biotestmine.properties (webapp.path).
stage="$(mktemp -d "${TMPDIR:-/tmp}/alliancetestmine.XXXXXX")"
trap 'rm -rf "${stage:?}"' EXIT
mkdir -p "$stage/biotestmine"
cp -R "$here/mine/." "$stage/biotestmine/"

# The builder image extracts data/malaria-data.tar.gz before the build. It is unused
# here, so ship an empty placeholder.
placeholder="$(mktemp -d "${TMPDIR:-/tmp}/placeholder.XXXXXX")"
mkdir "$placeholder/malaria"
: > "$placeholder/malaria/.keep"
tar -czf "$stage/biotestmine/data/malaria-data.tar.gz" -C "$placeholder" malaria
rm -rf "${placeholder:?}"

export MEM_OPTS="${MEM_OPTS:--Xmx2g -Xms1g}"

"$boot" stop local || true

# Solr sometimes exits at start with "cp: preserving permissions ... zoo.cfg" on a
# macOS bind mount. Restart it for the first 10 minutes of the build.
(
    for _ in $(seq 1 60); do
        sleep 10
        if [ "$(docker inspect -f '{{.State.Status}}' solr 2>/dev/null || true)" = "exited" ]; then
            rm -f "$HOME/.local/share/intermine_boot/docker/data/solr/data/zoo.cfg"
            docker start solr >/dev/null 2>&1 || true
        fi
    done
) &
solr_watch=$!
trap 'kill "$solr_watch" 2>/dev/null || true; rm -rf "${stage:?}"' EXIT

"$boot" start local --rebuild --datapath-im "$stage/biotestmine"

echo "Checking $service_root"
curl -s --max-time 20 "$service_root/service/version"
echo
