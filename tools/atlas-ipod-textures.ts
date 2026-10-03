/** Conservative sampler inventory of emitted GLSL, before driver dead-code
 * elimination. Unused declarations may keep extra textures; none are omitted. */
export function samplerDeclarations(source: string): string[] {
  source = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const names = new Set<string>();
  for (const match of source.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(sampler\w+)\s+([^;]+);/g)) {
    if (!(["sampler2D", "samplerCube"].includes(match[1]))) throw new Error(`Unsupported scene sampler type ${match[1]}`);
    for (const declaration of match[2].split(",")) {
      const name = /^\s*([A-Za-z_]\w*)(?:\s*\[\s*\d+\s*\])?\s*$/.exec(declaration)?.[1];
      if (!name) throw new Error(`Unsupported sampler declaration ${declaration}`);
      names.add(name);
    }
  }
  return [...names].sort();
}

export function textureUsage(
  draws: ({ performance: string[]; wet_response?: string[] | null; water_response?: string[] | null; performance_reflection?: string[] | null } | null)[], sky: string[],
  readShader: (name: string) => string,
) {
  const cache = new Map<string, string[]>();
  const entry = (program: string[], response?: string[] | null, water?: string[] | null, reflection?: string[] | null) => ({
    program,
    ...(response ? { response_program: response } : {}),
    ...(water ? { water_response_program: water } : {}),
    ...(reflection ? { reflection_program: reflection } : {}),
    samplers: [...new Set([...program, ...(response ?? []), ...(water ?? []), ...(reflection ?? [])].flatMap(name => {
      if (!cache.has(name)) cache.set(name, samplerDeclarations(readShader(name)));
      return cache.get(name)!;
    }))].sort(),
  });
  return { version: 1, draws: draws.map(draw => draw ? entry(draw.performance, draw.wet_response, draw.water_response, draw.performance_reflection) : null), sky: entry(sky) };
}
