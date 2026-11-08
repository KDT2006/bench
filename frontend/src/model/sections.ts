export const directives = ["imports", "globals", "sweep", "setup", "bench", "cleanup"] as const;
export type Directive = typeof directives[number];
export type Sections = Record<Directive, string>;
export const sectionPattern = new RegExp(`^\\s*#(${directives.join("|")})\\s*$`);
export const SCAFFOLD_FORMAT_VERSION = "sections-gemini-v2";

export function parseSections(source: string) {
  const sections = Object.fromEntries(directives.map((name) => [name, ""])) as Sections;
  const errors: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  let current: Directive | undefined;
  source.replaceAll("\r\n", "\n").split("\n").forEach((line, index) => {
    const text = line.trim();
    if (text.startsWith("#")) {
      const match = sectionPattern.exec(line);
      if (!match) { errors.push({ line: index + 1, message: `Unknown directive ${text}.` }); current = undefined; return; }
      const name = match[1] as Directive;
      if (seen.has(name)) errors.push({ line: index + 1, message: `Duplicate directive #${name}.` });
      seen.add(name);
      current = name;
    } else if (current) sections[current] += line + "\n";
    else if (text) errors.push({ line: index + 1, message: "Code must follow a directive." });
  });
  if (!seen.has("bench")) errors.push({ line: 1, message: "Add a #bench section for the measured work." });
  return { sections, errors };
}

export function assembleSections(sections: Partial<Sections>) {
  return directives.map((name) => `#${name}\n${sections[name]?.trim() ?? ""}`).join("\n\n") + "\n";
}
