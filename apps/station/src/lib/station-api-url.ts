/**
 * Canonicalizes the deployment-supplied station API base. This must be an
 * API origin, never the webview's own origin: packaged Tauri applications do
 * not live on the API host.
 */
export function canonicalStationApiUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
