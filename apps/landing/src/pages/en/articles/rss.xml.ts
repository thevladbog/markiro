import { renderArticlesRss } from "../../../lib/seo";

export function GET(): Response {
  return new Response(renderArticlesRss("en"), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
