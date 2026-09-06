import { renderArticlesRss } from "../../lib/seo";

export function GET(): Response {
  return new Response(renderArticlesRss("ru"), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
