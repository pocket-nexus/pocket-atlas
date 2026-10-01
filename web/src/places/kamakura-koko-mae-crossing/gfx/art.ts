import { Rng } from "../../../core/random";
import { JP_SANS, LATIN, type Ctx } from "../../shared/canvas";

/**
 * Canvas art for the place's ground: the crossing deck, spike mats, tactile
 * paving, road markings and the station name board, drawn into the shared
 * atlas by key. The crossing equipment, signs and boards paint into the
 * equipment atlas (gfx/equip.ts, gfx/roadsigns.ts), the train livery into
 * gfx/livery.ts, the facades into gfx/facade.ts and the leaf cards into
 * gfx/foliage.ts. Lettering is generic or the real wording of public signs;
 * no logos are traced.
 */

// ------------------------------------------------------------ crossing

/** Anti-slip crossing deck: ochre panels with joints, the rails' flangeways and the green pedestrian strip on the west end. */
export function crossingDeck(g: Ctx, cw: number, ch: number, stripFrac: number, rails: number[]): void {
  const r = new Rng(41);
  // Green pedestrian strip (west = left end).
  const sx = cw * stripFrac;
  g.fillStyle = "#4f8a52";
  g.fillRect(0, 0, sx, ch);
  // Ochre panels, slightly different batches.
  const panels = 9;
  for (let i = 0; i < panels; i++) {
    const x0 = sx + ((cw - sx) * i) / panels;
    const w = (cw - sx) / panels;
    const tone = r.range(-14, 14);
    g.fillStyle = `rgb(${206 + tone}, ${146 + tone * 0.7}, ${62 + tone * 0.4})`;
    g.fillRect(x0, 0, w, ch);
    // Grit speckle.
    for (let k = 0; k < 900; k++) {
      g.fillStyle = r.chance(0.5) ? "rgba(255,230,190,0.25)" : "rgba(80,50,20,0.25)";
      g.fillRect(x0 + r.next() * w, r.next() * ch, 1.5, 1.5);
    }
    // Tyre wear in the lanes.
    g.fillStyle = "rgba(60,50,40,0.14)";
    g.fillRect(x0, ch * 0.05, w, ch * 0.9);
  }
  // Panel joints along the road and the flangeway grooves along the track.
  g.fillStyle = "rgba(40,30,20,0.85)";
  for (let i = 0; i <= panels; i++) g.fillRect(sx + ((cw - sx) * i) / panels - 1.5, 0, 3, ch);
  for (const v of rails) {
    g.fillStyle = "rgba(25,20,15,0.95)";
    g.fillRect(0, v * ch - 5, cw, 10);
  }
  // Worn white edge lines at both ends of the deck.
  g.fillStyle = "rgba(230,228,220,0.85)";
  g.fillRect(sx, 0, cw - sx, ch * 0.025);
  g.fillRect(sx, ch * 0.975, cw - sx, ch * 0.025);
}

/** Yellow anti-trespass spike mat (the cones drawn lit from the south-west). */
export function spikeMat(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#c79a10";
  g.fillRect(0, 0, cw, ch);
  const n = 6;
  const m = Math.round((n * ch) / cw);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5 + (j % 2) * 0.5) * cw) / n;
      const y = ((j + 0.5) * ch) / m;
      const rr = cw / n / 2.3;
      g.fillStyle = "rgba(60,40,0,0.45)";
      g.beginPath();
      g.ellipse(x + rr * 0.5, y + rr * 0.2, rr * 1.1, rr * 0.7, 0, 0, Math.PI * 2);
      g.fill();
      const grd = g.createRadialGradient(x - rr * 0.3, y - rr * 0.3, 1, x, y, rr);
      grd.addColorStop(0, "#fff28a");
      grd.addColorStop(0.5, "#f2c51a");
      grd.addColorStop(1, "#9a7408");
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fill();
    }
}

/** Tactile paving (点字ブロック): yellow tiles with dots. */
export function tactile(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#e4b318";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "rgba(120,80,0,0.4)";
  for (let i = 0; i <= 4; i++) {
    g.fillRect((i * cw) / 4 - 1, 0, 2, ch);
    g.fillRect(0, (i * ch) / 4 - 1, cw, 2);
  }
  g.fillStyle = "rgba(255,240,170,0.7)";
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    g.beginPath();
    g.arc(((x + 0.5) * cw) / 20, ((y + 0.5) * ch) / 20, cw / 70, 0, Math.PI * 2);
    g.fill();
  }
}

/** Station name board (teal, white lettering). */
export function stationBoard(g: Ctx, cw: number, ch: number): void {
  g.fillStyle = "#e8eef0";
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = "#1f7d8c";
  g.fillRect(cw * 0.02, ch * 0.04, cw * 0.96, ch * 0.92);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${ch * 0.16}px ${JP_SANS}`;
  g.fillText("江ノ島電鉄", cw / 2, ch * 0.18);
  g.font = `900 ${ch * 0.34}px ${JP_SANS}`;
  g.fillText("鎌倉高校前駅", cw / 2, ch * 0.5, cw * 0.92);
  g.font = `700 ${ch * 0.13}px ${LATIN}`;
  g.fillText("KAMAKURAKŌKŌMAE STATION", cw / 2, ch * 0.8, cw * 0.9);
}

/** Road marking cell: worn paint (solid with a little asphalt showing through). */
export function marking(color: string, seed: number) {
  return (g: Ctx, cw: number, ch: number) => {
    const r = new Rng(seed);
    g.fillStyle = color;
    g.fillRect(0, 0, cw, ch);
    for (let i = 0; i < (cw * ch) / 60; i++) {
      g.fillStyle = r.chance(0.6) ? "rgba(60,58,54,0.35)" : "rgba(255,255,255,0.15)";
      g.fillRect(r.next() * cw, r.next() * ch, 2, 2);
    }
  };
}
