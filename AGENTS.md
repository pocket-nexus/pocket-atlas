# Repository instructions

- Pocket City owns the city scenes, the cooker, the pack format and the PS Vita renderer. PocketJS (pinned in `vendor/pocketjs`) owns the Vita dev host, the wired debug transport (`tools/vita-dev.ts`, `tools/vita-usb.ts`) and VPK packaging (`tools/vita-package.ts`).
- Do not edit the submodule to fix application behavior. Send reusable changes to PocketJS, then update the pinned revision here.
- Use Conventional Commits for commits and pull requests (`type(scope): summary`). Publish validated changes as a Draft PR.
- Keep captures, logs, cooked packs, USB-share contents and build receipts in the ignored `.pocket-build/`. Put reproducible commands, results and limits in the PR description instead of committing them.
- Commit an image only when something consumes it (LiveArea art under `vita/assets`, a test fixture).
- Separate evidence kinds when reporting: host build, on-device compile, device GPU timing (`bun tools/city.ts profile`), and what a person saw on the screen.
- Shader programs are compiled on the device by SceShaccCg; `bun tools/city.ts lint` catches syntax and type errors on the host but not SceShaccCg's overload ambiguities (mixing `half` and `float` in `lerp`/`smoothstep`), so cast explicitly.
