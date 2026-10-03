/** Older glslang/SPIRV-Cross combinations materialize uniform arrays as
 * local constructor/copy initializers even for GLSL ES 1.00. That language
 * supports arrays and dynamic vertex indexing, but neither array constructors
 * nor whole-array assignment. Expand only initialization, in the original
 * scope and order; expressions and later dynamic accesses remain unchanged. */
export function lowerGlsl100Arrays(source: string): string {
  return source.replace(
    /^([ \t]*)((?:const\s+)?(?:(?:highp|mediump|lowp)\s+)?)(\w+)\s+(\w+)\[(\d+)\]\s*=\s*([^;]+);/gm,
    (declaration, indent: string, qualifiers: string, type: string, name: string, sizeText: string, value: string, offset: number) => {
      // Global initialization would need a different lifetime transformation.
      // Do not silently move it into main or alter const-expression semantics.
      const prefix = source.slice(0, offset).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const depth = [...prefix].reduce((depth, c) => depth + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
      if (!depth || qualifiers.includes("const"))
        throw new Error("GLSL100 array initializer requires a mutable local declaration");
      const size = Number(sizeText);
      if (size < 1 || size > 65536) throw new Error("Invalid GLSL100 array initializer size");
      let elements: string[];
      const constructor = value.trim().match(new RegExp(`^${type}\\s*\\[\\s*(\\d*)\\s*\\]\\s*\\(([\\s\\S]*)\\)$`));
      if (constructor) {
        if (constructor[1] && Number(constructor[1]) !== size)
          throw new Error("GLSL100 array constructor size mismatch");
        elements = [];
        let start = 0, nesting = 0;
        for (let i = 0; i < constructor[2].length; i++) {
          const c = constructor[2][i];
          if (c === "(" || c === "[") nesting++;
          if (c === ")" || c === "]") nesting--;
          if (nesting < 0) throw new Error("Unbalanced GLSL100 array constructor");
          if (c === "," && nesting === 0) {
            elements.push(constructor[2].slice(start, i).trim());
            start = i + 1;
          }
        }
        elements.push(constructor[2].slice(start).trim());
        if (nesting || elements.length !== size || elements.some(value => !value))
          throw new Error("GLSL100 array constructor element count mismatch");
      } else if (/^\w+(?:\.\w+)*$/.test(value.trim())) {
        elements = Array.from({ length: size }, (_, i) => `${value.trim()}[${i}]`);
      } else throw new Error(`Unsupported GLSL100 array initializer: ${value.trim()}`);
      return `${indent}${qualifiers}${type} ${name}[${size}];\n` +
        elements.map((value, i) => `${indent}${name}[${i}] = ${value};`).join("\n");
    },
  );
}
