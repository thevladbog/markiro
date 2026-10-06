/**
 * Saves a file through a throwaway `<a download>` and a blob URL: the
 * webview's own download, with no host round trip. The URL is revoked right
 * after the synchronous click, by which time the download has its data.
 */
export function downloadFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
