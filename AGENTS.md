# Repository instructions

- Pocket Atlas owns the places (`web/src/places/<id>`), the cooker, the `.place` pack format and the PS Vita renderer. PocketJS (pinned in `vendor/pocketjs`) owns the Vita dev host, the wired debug transport (`tools/vita-dev.ts`, `tools/vita-usb.ts`) and VPK packaging (`tools/vita-package.ts`).
- Do not edit the submodule to fix application behavior. Send reusable changes to PocketJS, then update the pinned revision here.
- Use Conventional Commits for commits and pull requests (`type(scope): summary`). Publish validated changes as a Draft PR.
- Keep captures, logs, cooked packs, USB-share contents and build receipts in the ignored `.pocket-build/`. Put reproducible commands, results and limits in the PR description instead of committing them.
- Commit an image only when something consumes it (LiveArea art under `vita/assets`, a test fixture).
- Separate evidence kinds when reporting: host build, on-device compile, device GPU timing (`bun tools/atlas.ts profile`), and what a person saw on the screen.
- Shader programs are compiled on the device by SceShaccCg; `bun tools/atlas.ts lint` catches syntax and type errors on the host but not SceShaccCg's overload ambiguities (mixing `half` and `float` in `lerp`/`smoothstep`), so cast explicitly.
- Upload uniform arrays at the program's declared length: `sceGxmSetUniformDataF` writes past a shorter parameter into the rest of the uniform buffer (it crashed the device).
- After the app dies on the device, restart `bun tools/atlas.ts serve`: the kernel driver reconnects, but the old host session stays dead and Devkit cannot report status.
- A place's rendering work goes into the shared renderer, cooker and web materials, keyed by the kind of place (night street, daytime slope, interior, …), not into code that only one place can use.
- Places built from film or anime stills recreate the real location only: no characters from the source. Take geometry and details from photographs and pilgrimage records of the real spot.
- To make, rebuild, polish or review a place, follow the `pocket-atlas-place` skill (`.claude/skills/pocket-atlas-place/`): research, scene, fidelity pass, device loop, budgets and the traps the first four places hit.
