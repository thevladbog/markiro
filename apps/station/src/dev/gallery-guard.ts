/**
 * Side-effect-free production boundary. Vite folds the DEV argument to false,
 * allowing the complete gallery import path to disappear from production.
 */
export function shouldRenderGallery(isDevelopment: boolean, search: string): boolean {
  return isDevelopment && new URLSearchParams(search).get("gallery") === "1";
}
