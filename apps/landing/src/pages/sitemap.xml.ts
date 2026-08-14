import { renderSitemapXml } from "../lib/seo";

export function GET(): Response {
  return new Response(renderSitemapXml(), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
