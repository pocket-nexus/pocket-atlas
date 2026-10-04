import { expect, test } from "bun:test";
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { createDefinedStage, defineDayPlace, defineOutdoorPlace, definePlace, describePlace, resolveAuthoring, validateSampling } from "../src/places/shared/authoring";
import { identifySources, source, sourceIds } from "../src/places/shared/provenance";
import { batchStatic } from "../src/places/shared/geo";
import { PLACES } from "../src/places/registry";
import type { PlaceDef, Stage, StageContext } from "../src/core/types";
import { definition as outdoorExample } from "../examples/day-place";
import type { OutdoorAtmosphere } from "../src/places/shared/daylight/DayStage";

const sampling = { startSeconds: 0, durationSeconds: 64, fps: 15 };
const make = () => definePlace({ id: "test-place", kind: "night-street", seed: 10, sampling,
  create: async () => { throw new Error("must remain lazy"); } });

test("all published places can be inspected without DOM, renderer or audio; railway period survives", async () => {
  for (const place of PLACES.filter(p => p.load)) {
    const { definition } = await place.load!();
    expect(definition).toBeDefined();
    const metadata = describePlace(definition!);
    expect(metadata.id).toBe(place.id);
    expect(metadata.kind).toBe(place.kind);
    expect(JSON.stringify(metadata)).not.toContain("create");
    if (place.id === "sangubashi-crossing") expect(metadata.sampling.durationSeconds).toBe(64);
  }
});

test("explicit overrides are validated without mutating default sampling", () => {
  const definition = make();
  expect(resolveAuthoring(definition, "full").sampling).toEqual(sampling);
  const effective = resolveAuthoring(definition, "handheld", { seed: 20, sampling: { durationSeconds: 20 } });
  expect(effective.sampling.durationSeconds).toBe(20);
  expect(effective.seed).toBe(20);
  expect(definition.sampling.durationSeconds).toBe(64);
  for (const invalid of [NaN, Infinity, -1, 0, 0.01, 5000])
    expect(() => validateSampling({ ...sampling, durationSeconds: invalid })).toThrow();
  expect(() => resolveAuthoring(definition, "full", { seed: -1 })).toThrow("seed");
  expect(() => definePlace({ ...definition, resources: [{ path: "../outside", sha256: "a".repeat(64) }] })).toThrow("resource");
});

test("createStage ABI constructs separate instances with effective inputs and rejects registry drift", async () => {
  const contexts: StageContext[] = [];
  const definition = definePlace({ ...make(), async create(ctx) { contexts.push(ctx); return {} as Stage; } });
  const ctx = { params: { geometry: "full", authoring: { sampling: { durationSeconds: 10 } } } } as StageContext;
  const place = { id: "test-place", kind: "night-street" } as PlaceDef;
  const a = await createDefinedStage(definition, ctx, place, async () => {});
  const b = await createDefinedStage(definition, ctx, place, async () => {});
  expect(a).not.toBe(b);
  expect(contexts[0].authoring?.sampling.durationSeconds).toBe(10);
  expect(ctx.authoring).toBeUndefined();
  await expect(createDefinedStage(definition, ctx, { ...place, kind: "interior" }, async () => {})).rejects.toThrow("disagree");
});

test("daytime definition detects ambiguous cameras before any world is built", () => {
  const key = { pos: [0, 1, 2] as [number,number,number], target: [0,0,0] as [number,number,number], fov: 45 };
  const shot = { name: "Hero", from: key, to: key, duration: 4 };
  const input = { ...make(), kind: "daytime-slope" as const, season: "summer" as const,
    shots: [shot, { ...shot, name: "hero" }], walkable: [], focus: [0,0,0,1,1,1] as [number,number,number,number,number,number],
    intro: key, introSeconds: 1, sunDirection: new Vector3(0,1,0), sunIntensity: 1,
    sunCenter: [0,0,0] as [number,number,number], shadowBounds: [0,0,0,1,1,1] as [number,number,number,number,number,number],
    envPosition: [0,0,0] as [number,number,number], envIntensity: 1, fogDensity: 0.1,
    metadata: {}, async build() {} };
  expect(() => defineDayPlace(input)).toThrow("Duplicate");
});

test("batching keeps semantic contributors and stable IDs independent of Three object counters", () => {
  const build = () => {
    const root = new Group(), material = new MeshStandardMaterial();
    const a = source("stairs/main", new Mesh(new BoxGeometry(), material));
    const b = source("stairs/landing", new Mesh(new BoxGeometry(), material));
    b.position.x = 3; root.add(a,b);
    const stats = batchStatic(root);
    expect(stats).toEqual({ before: 2, after: 1 });
    identifySources(root);
    expect(sourceIds(root.children[0])).toEqual(["stairs/landing", "stairs/main"]);
    expect(sourceIds(material)).toEqual(["stairs/landing", "stairs/main"]);
    return JSON.stringify(root.children[0].userData);
  };
  const first = build();
  Array.from({length: 50}, () => new Group());
  expect(build()).toBe(first);
  const root = new Group(); root.add(source("same", new Group()), source("same", new Group()));
  expect(() => identifySources(root)).toThrow("Duplicate");
});

test("outdoor family requires an authored dusk atmosphere and does not accept unsupported night or vista effects", () => {
  // The example definition retains its authored data but constructs no browser resources.
  const base = outdoorExample as unknown as Parameters<typeof defineOutdoorPlace>[0];
  const atmosphere: OutdoorAtmosphere = {
    sky: { zenith: new Color(0.01, 0.02, 0.06), horizon: new Color(0.1, 0.1, 0.2), ground: new Color(0.02, 0.02, 0.02),
      gradientPower: 0.5, groundBlend: 6, sun: new Vector3(1, -0.1, 0).normalize(), sunColor: new Color(1, 0.4, 0.1),
      glow: { intensity: 0.2, wide: [0.3, 8], tight: [1, 36] } },
    hemisphere: { sky: new Color(0.1, 0.15, 0.2), ground: new Color(0.05, 0.04, 0.03), intensity: 0.5 },
    post: { tone: "agx", ao: { radius: 1, intensity: 2, color: [0, 0, 0] },
      bloom: { threshold: 1, smoothing: 0.4, intensity: 0.7, radius: 0.7, levels: 7 },
      grade: { grain: 0, vignette: 0.2, lift: [0, 0, 0], gain: [1, 1, 1], saturation: 1, contrast: 1 } },
  };
  for (const kind of ["dusk-street", "dusk-coast"] as const) {
    expect(() => defineOutdoorPlace({ ...base, kind })).toThrow("explicit atmosphere");
    const place = defineOutdoorPlace({ ...base, kind, atmosphere, sunIntensity: 0 });
    expect(describePlace(place).kind).toBe(kind);
    expect(describePlace(place).cameras?.length).toBe(1);
    expect(() => defineDayPlace({ ...base, kind, atmosphere })).toThrow("daytime");
  }
  for (const kind of ["night-street", "dusk-vista", "interior"] as const)
    expect(() => defineOutdoorPlace({ ...base, kind, atmosphere })).toThrow("daytime or dusk");
});
