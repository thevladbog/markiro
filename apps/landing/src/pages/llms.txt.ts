import { renderLlmsTxt } from "../lib/seo";

export function GET(): Response {
  return new Response(renderLlmsTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
