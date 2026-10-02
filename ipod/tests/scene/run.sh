#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
exec cargo test --locked \
  --manifest-path "$repo_root/ipod/tests/scene/Cargo.toml" \
  --target-dir "$repo_root/.pocket-build/tests/ipod-scene" "$@"
