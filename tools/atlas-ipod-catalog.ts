import type { PlaceDef } from "../web/src/core/types";

type CatalogPlace = Pick<PlaceDef, "id" | "status" | "load" | "targets">;

/** Native publication is explicit opt-in, independent of compiler capability.
 * Keep registry order and never invoke the web scene loader while selecting. */
export function selectIPodPlaces<T extends CatalogPlace>(
  places: readonly T[],
  selected?: string,
): T[] {
  return places.filter((place) =>
    place.status === "live" &&
    typeof place.load === "function" &&
    place.targets?.includes("ipod") &&
    (!selected || place.id === selected)
  );
}

const placeAssetSuffixes = [
  "place", "pipelines.json", "shadow.json", "audio.caf", "preview.png",
  "ipod-color.bin", "ipod-color.json", "ipod-clusters.bin",
] as const;

/** Relative asset paths only. Shared renderer assets are independent of the
 * release catalog; historical or experimental place files are not shipped. */
export function isIPodAsset(path: string, places: readonly Pick<PlaceDef, "id">[]): boolean {
  if (path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))
    return false;
  return path === "effects.json" || path === "globe.pipelines.json" ||
    path.startsWith("globe/") || path.startsWith("shaders/") ||
    places.some((place) => placeAssetSuffixes.some((suffix) => path === `${place.id}.${suffix}`));
}
