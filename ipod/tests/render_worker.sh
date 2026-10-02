#!/bin/sh
# Host-only concurrency regression; no SDK, browser or physical device needed.
# Run from any directory: sh ipod/tests/render_worker.sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
out_dir="$repo_dir/.pocket-build/validation/ipod/render-worker-regression"
compiler=${CC:-clang}
mkdir -p "$out_dir"
"$compiler" -std=c11 -D_POSIX_C_SOURCE=200809L -D_DARWIN_C_SOURCE -Wall -Wextra -Werror \
  -Wno-cast-function-type -Dcalloc=worker_test_calloc \
  -I"$repo_dir/ipod/src" -c "$repo_dir/ipod/src/render_worker.c" -o "$out_dir/worker.o"
"$compiler" -std=c11 -D_POSIX_C_SOURCE=200809L -D_DARWIN_C_SOURCE -Wall -Wextra -Werror \
  -I"$repo_dir/ipod/src" "$out_dir/worker.o" "$script_dir/render_worker.c" \
  -o "$out_dir/render-worker-test" -pthread
if "$out_dir/render-worker-test" "$out_dir" >"$out_dir/result.log" 2>&1; then
  cat "$out_dir/result.log"
else
  cat "$out_dir/result.log"
  exit 1
fi
