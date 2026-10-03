# XMB artwork

`../Psp.toml` embeds `icon0.png` (144×80 RGB) and `pic1.png` (480×272 RGB) in the EBOOT. These are consumed package assets.

`icon0.svg` is the editable Pocket Atlas globe-and-location mark. Regenerate the PNG from the repository root with the pinned PocketJS canvas package and Inter font, then normalize to the PSP's 24-bit RGB format:

```sh
bun -e 'import { createCanvas, loadImage, GlobalFonts } from "./vendor/pocketjs/node_modules/@napi-rs/canvas/index.js"; GlobalFonts.registerFromPath("vendor/pocketjs/assets/fonts/Inter-Bold.ttf", "Inter"); const c=createCanvas(144,80); c.getContext("2d").drawImage(await loadImage("psp/assets/icon0.svg"),0,0); await Bun.write("psp/assets/icon0.png",c.toBuffer("image/png"));'
magick psp/assets/icon0.png -alpha off -depth 8 PNG24:psp/assets/icon0.png
```

`pic1.png` is the unmodified Konbini camera capture from the PSP renderer at scene t=10 (2026-10-01, renderer commit `26ff1a7`). It represents the device's actual rendering. Raw captures and validation receipts stay in ignored `.pocket-build/validation/psp/`.
