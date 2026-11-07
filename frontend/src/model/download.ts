export function download(filename: string, blob: Blob | string) {
  const link = document.createElement("a");
  const source = typeof blob === "string" ? blob : URL.createObjectURL(blob);
  link.href = source;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  if (typeof blob !== "string") setTimeout(() => URL.revokeObjectURL(source), 1000);
}
