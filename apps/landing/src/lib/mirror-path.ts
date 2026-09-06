/**
 * Site-relative path of the markdown mirror that the post-build step writes
 * next to a page: `/` -> `/index.md`, `/faq/` -> `/faq.md`.
 */
export function mirrorPathFor(route: string): string {
  if (route === "/") return "/index.md";
  return route.endsWith("/") ? `${route.slice(0, -1)}.md` : `${route}.md`;
}
