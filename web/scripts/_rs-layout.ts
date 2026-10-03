import { CELLS } from "../src/routes/shared/kit/roadside-layout";
let maxy = 0; for (const [k, c] of Object.entries(CELLS)) { maxy = Math.max(maxy, c.y + c.h); console.log(k, c.x, c.y, c.w, c.h); } console.log("bottom", maxy);
