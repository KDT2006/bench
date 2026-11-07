export const editorFlushes = new Set<() => void>();
export function flushEditors() { for (const flush of editorFlushes) flush(); }
