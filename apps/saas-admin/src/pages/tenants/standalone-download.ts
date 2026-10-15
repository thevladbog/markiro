/** Saves the signed license line as a `.mklic` file without leaving the page (plan Д16). */
export function saveLicenseFile(fileName: string, compact: string): void {
  const url = URL.createObjectURL(new Blob([compact], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
