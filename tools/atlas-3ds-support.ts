import type { PlaceDef, PlaceKind } from "../web/src/core/types";

// Renderer capabilities, not place IDs. Keep in step with the PICA cooker's
// feature validator; vista haze and point-light fields need a future backend.
const kinds = new Set<PlaceKind>([
  "night-street",
  "daytime-slope",
  "daytime-street",
  "dusk-street",
  "daytime-coast",
]);

export function supports3ds(place: Pick<PlaceDef, "kind">): boolean {
  return kinds.has(place.kind);
}

export function native3dsPlaces(places: readonly PlaceDef[], requested?: string): PlaceDef[] {
  const live = places.filter((p) => p.status === "live" && p.load);
  if (requested) {
    const place = live.find((p) => p.id === requested);
    if (!place) throw new Error(`Unknown live place: ${requested}`);
    if (!supports3ds(place)) throw new Error(`3DS does not support ${place.kind}: ${requested}`);
    return [place];
  }
  return live.filter(supports3ds);
}

export function browser3dsFlags(place: PlaceDef): number {
  const live = place.status === "live" && !!place.load;
  return (live && supports3ds(place) ? 1 : 0)
    | (place.featured ? 2 : 0)
    | (live && !supports3ds(place) ? 4 : 0);
}

export function unsupported3dsPlaces(places: readonly PlaceDef[]) {
  return places.filter((p) => p.status === "live" && p.load && !supports3ds(p))
    .map(({ id, kind }) => ({ id, kind, reason: "This kind is not available on Nintendo 3DS" }));
}

/** Refuse a stale browser pack that would advertise unavailable native scenes. */
export function validate3dsBrowserCatalog(bytes: Buffer, places: readonly PlaceDef[]): void {
  if (bytes.length < 96 || bytes.toString("ascii", 0, 4) !== "AT3B"
    || bytes.readUInt32LE(8) !== places.length)
    throw new Error("3DS browser catalog is stale; run bun tools/atlas-3ds-assets.ts");
  const offset = bytes.readUInt32LE(12);
  if (offset < 96 || offset + places.length * 68 > bytes.length)
    throw new Error("Invalid 3DS browser place table");
  for (const [i, place] of places.entries()) {
    const at = offset + i * 68;
    const start = bytes.readUInt32LE(at);
    const end = bytes.indexOf(0, start);
    if (start >= bytes.length || end < start || bytes.toString("utf8", start, end) !== place.id
      || (bytes.readUInt32LE(at + 56) & 5) !== (browser3dsFlags(place) & 5))
      throw new Error(`3DS browser availability is stale for ${place.id}; run bun tools/atlas-3ds-assets.ts`);
  }
}
