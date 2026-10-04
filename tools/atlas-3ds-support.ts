import type { PlaceDef } from "../web/src/core/types";

// Catalog eligibility is explicit; PlaceIR checks the authored feature set
// before lowering. The interface lists every place and marks the ones whose
// pack is on the SD card (tools/atlas-ui.ts, n3ds/src/main.c).
export function supports3ds(place: Pick<PlaceDef, "targets">): boolean {
  return place.targets?.includes("3ds") ?? false;
}

export function native3dsPlaces(places: readonly PlaceDef[], requested?: string): PlaceDef[] {
  const live = places.filter((p) => p.status === "live" && p.load);
  if (requested) {
    const place = live.find((p) => p.id === requested);
    if (!place) throw new Error(`Unknown live place: ${requested}`);
    if (!supports3ds(place)) throw new Error(`3DS release is unavailable for ${requested} (${place.kind})`);
    return [place];
  }
  return live.filter(supports3ds);
}

export function unsupported3dsPlaces(places: readonly PlaceDef[]) {
  return places.filter((p) => p.status === "live" && p.load && !supports3ds(p))
    .map(({ id, kind }) => ({ id, kind, reason: "This place is not available on Nintendo 3DS" }));
}
