export const MAX_SCAFFOLD_CHARACTERS = 250;
export const scaffoldLength = (dsl: string) => Array.from(dsl).length;
export const scaffoldLimitMessage = `Shorten benchmark.perf to ${MAX_SCAFFOLD_CHARACTERS} characters before generating code.`;
