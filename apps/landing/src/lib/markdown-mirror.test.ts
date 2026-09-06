import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateMarkdownMirrors, htmlToMarkdown, mirrorPathFor } from "./markdown-mirror";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function page({
  route,
  lang = "ru",
  title,
  description,
  body,
  robots = "index,follow",
}: {
  route: string;
  lang?: string;
  title: string;
  description: string;
  body: string;
  robots?: string;
}): string {
  return `<!doctype html><html lang="${lang}"><head><title>${title}</title><meta name="description" content="${description}"><meta name="robots" content="${robots}"><link rel="canonical" href="https://markiro.app${route}"></head><body><header>Header noise</header><main id="main">${body}</main><footer>Footer noise</footer></body></html>`;
}

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "markiro-landing-mirror-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

describe("markdown mirrors", () => {
  it("maps canonical routes to sibling markdown files", () => {
    expect(mirrorPathFor("/")).toBe("/index.md");
    expect(mirrorPathFor("/faq/")).toBe("/faq.md");
    expect(mirrorPathFor("/stati/markirovka-piva-2026/")).toBe("/stati/markirovka-piva-2026.md");
    expect(mirrorPathFor("/en/articles/")).toBe("/en/articles.md");
  });

  it("turns the main content into readable markdown with absolute links", () => {
    const html = page({
      route: "/faq/",
      title: "FAQ — Markiro",
      description: "Answers",
      body:
        '<nav aria-label="Хлебные крошки"><ol><li><a href="/">Markiro</a></li></ol></nav>' +
        "<h1>Вопросы</h1><p>Абзац с <a href=\"/faq/\">ссылкой</a> и <strong>акцентом</strong>.</p>" +
        '<div aria-hidden="true">скрытый текст</div>' +
        "<h2>Раздел</h2><ul><li>первый</li><li>второй</li></ul><ol><li>шаг</li></ol>" +
        '<figure><img alt="Схема" src="/images/schema.svg"><figcaption>Подпись</figcaption></figure>' +
        "<section><h3>Подраздел</h3><p>Текст</p></section>",
    });

    const markdown = htmlToMarkdown(html, "https://markiro.app/faq/");

    expect(markdown).toBe(
      [
        "---",
        "title: FAQ — Markiro",
        "url: https://markiro.app/faq/",
        "lang: ru",
        "description: Answers",
        "---",
        "",
        "# Вопросы",
        "",
        "Абзац с [ссылкой](https://markiro.app/faq/) и акцентом.",
        "",
        "## Раздел",
        "",
        "- первый",
        "- второй",
        "",
        "1. шаг",
        "",
        "![Схема](https://markiro.app/images/schema.svg)",
        "",
        "Подпись",
        "",
        "### Подраздел",
        "",
        "Текст",
        "",
      ].join("\n"),
    );
    expect(markdown).not.toContain("скрытый текст");
    expect(markdown).not.toContain("Header noise");
    expect(markdown).not.toContain("Хлебные крошки");
  });

  it("writes one mirror per indexable page plus a combined llms-full.txt", async () => {
    const root = await fixture({
      "index.html": page({
        route: "/",
        title: "Home — Markiro",
        description: "Home",
        body: "<h1>Главная</h1><p>Текст главной.</p>",
      }),
      "faq/index.html": page({
        route: "/faq/",
        title: "FAQ — Markiro",
        description: "Answers",
        body: "<h1>Вопросы</h1><p>Ответ.</p>",
      }),
      "en/index.html": page({
        route: "/en/",
        lang: "en",
        title: "Home — Markiro (EN)",
        description: "Home EN",
        body: "<h1>Home</h1><p>English text.</p>",
      }),
      "d/MKR-PD-01/2026.08/01/15.08.2026/index.html": page({
        route: "/d/MKR-PD-01/2026.08/01/15.08.2026",
        title: "Verification",
        description: "Verification",
        body: "<h1>Verify</h1>",
        robots: "noindex,follow",
      }),
      "404.html": page({
        route: "/404.html",
        title: "Not found",
        description: "Not found",
        body: "<h1>404</h1>",
        robots: "noindex,follow",
      }),
    });

    const written = await generateMarkdownMirrors(root);

    expect(written).toEqual(["/index.md", "/faq.md", "/en.md", "/llms-full.txt"]);
    expect(await readFile(path.join(root, "faq.md"), "utf8")).toContain("# Вопросы");
    expect(await readFile(path.join(root, "en.md"), "utf8")).toContain("lang: en");
    const full = await readFile(path.join(root, "llms-full.txt"), "utf8");
    expect(full.startsWith("# Markiro\n")).toBe(true);
    expect(full.indexOf("url: https://markiro.app/")).toBeLessThan(full.indexOf("url: https://markiro.app/faq/"));
    expect(full.indexOf("url: https://markiro.app/faq/")).toBeLessThan(
      full.indexOf("url: https://markiro.app/en/"),
    );
    expect(full).not.toContain("Verify");
    expect(full).not.toContain("# 404");
  });
});
