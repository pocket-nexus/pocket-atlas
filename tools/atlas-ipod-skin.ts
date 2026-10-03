/** SGX performance skinning: retain all four slots and the original guarded
 * accumulation order, but expose constant attribute components to the ES2
 * compiler. No assumption about how many weights are nonzero is made here.
 * Bone-palette indexing remains dynamic because joints vary by vertex. */
export function unrollSkinVertex(source: string): string {
  const header = "    for (int k = 0; k < 4; k++) {";
  const start = source.indexOf(header);
  if (start < 0 || source.indexOf(header, start + header.length) >= 0)
    throw new Error("SGX skin contract changed: expected one four-slot loop");
  const bodyStart = start + header.length;
  let depth = 1, end = bodyStart;
  for (; end < source.length && depth; end++) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
  }
  if (depth) throw new Error("SGX skin contract changed: unclosed loop");
  const body = source.slice(bodyStart, end - 1);
  if (!body.includes("if (w > 0.0) {") ||
      (body.match(/aWeights\[k\]/g) ?? []).length !== 1 ||
      (body.match(/aJoints\[k\]/g) ?? []).length !== 1)
    throw new Error("SGX skin contract changed: weight/joint guard");
  const blocks = [..."xyzw"].map(component => {
    const constant = body.replace("aWeights[k]", `aWeights.${component}`)
      .replace("aJoints[k]", `aJoints.${component}`);
    if (/\bk\b/.test(constant)) throw new Error("SGX skin contract changed: unknown slot use");
    return `    { // Skin slot ${component}; preserve source accumulation order.${constant}}`;
  });
  return source.slice(0, start) + blocks.join("\n") + source.slice(end);
}
