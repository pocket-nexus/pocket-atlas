# XMB artwork

`../Psp.toml` and `tools/atlas-psp.ts` embed `pic1.png` (480×272 RGB) in the EBOOT as `PIC1.PNG`, the picture the XMB shows behind the icon. It is a consumed package asset.

`pic1.png` is the unmodified Konbini camera capture from the PSP renderer at scene t=10 (2026-10-01, renderer commit `26ff1a7`). It represents the device's actual rendering. Raw captures and validation receipts stay in ignored `.pocket-build/validation/psp/`.

`ICON0.PNG` is not in this directory. Both builds read the Pocket3D icon from `vendor/pocketjs/engine/pocket3d/icon/psp/ICON0.PNG` (144×80); this repository holds no icon file.
