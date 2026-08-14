import { renderRobotsTxt } from "../lib/seo";

export function GET(): Response {
  return new Response(renderRobotsTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
