# iPod scene host tests

Run from the repository root:

```sh
sh ipod/tests/scene/run.sh
```

This isolated Cargo package loads the production scene loader, GLES declarations
and validators by relative path. It also imports the production effects module to exercise particle visibility, discontinuous lifecycle boundaries and post-processing decisions. The scene tests mock GLES calls to check malformed
containers, semantic validation, HDR uploads, animation and resource cleanup after
injected allocation or upload failures. They do not establish device GPU behavior.
The lockfile pins host dependencies; build output and generated fixtures stay in
the repository's ignored `.pocket-build/` directory.

Two optional tests also load every `.place` file in an existing GLES pack directory:

```sh
POCKET_ATLAS_VALIDATION_PACKS="$PWD/.pocket-build/ipod/assets" \
  sh ipod/tests/scene/run.sh -- --ignored --nocapture
```

Use an absolute directory path because Cargo runs the test binary from this
package's directory. These tests read existing packs and do not recook or modify
them. The scene loader still uses mocked GLES calls.
