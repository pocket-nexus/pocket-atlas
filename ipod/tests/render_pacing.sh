#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output="$repo_root/.pocket-build/tests/ipod-pacing"
mkdir -p "$output"
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror "$repo_root/ipod/tests/render_pacing.c" -lm -o "$output/render_pacing"
exec "$output/render_pacing"
