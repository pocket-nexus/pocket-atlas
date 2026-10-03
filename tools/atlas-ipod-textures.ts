/** Conservative sampler inventory of emitted GLSL, before driver dead-code
 * elimination. Unused declarations may keep extra textures; none are omitted. */
export function samplerDeclarations(source: string): string[] {
  source = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const names = new Set<string>();
  for (const match of source.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(sampler\w+)\s+([^;]+);/g)) {
    if (match[1] !== "sampler2D") throw new Error(`Unsupported scene sampler type ${match[1]}`);
    for (const declaration of match[2].split(",")) {
      const name = /^\s*([A-Za-z_]\w*)(?:\s*\[\s*\d+\s*\])?\s*$/.exec(declaration)?.[1];
      if (!name) throw new Error(`Unsupported sampler declaration ${declaration}`);
      names.add(name);
    }
  }
  return [...names].sort();
}

export function textureUsage(
  draws: ({ performance: string[] } | null)[], sky: string[],
  readShader: (name: string) => string,
) {
  const cache = new Map<string, string[]>();
  const entry = (program: string[]) => ({
    program,
    samplers: [...new Set(program.flatMap(name => {
      if (!cache.has(name)) cache.set(name, samplerDeclarations(readShader(name)));
      return cache.get(name)!;
    }))].sort(),
  });
  return { version: 1, draws: draws.map(draw => draw ? entry(draw.performance) : null), sky: entry(sky) };
}
