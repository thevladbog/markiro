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
        '<h1>Вопросы</h1><p>Абзац с <a href="/faq/">ссылкой</a> и <strong>акцентом</strong>.</p>' +
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

  it("keeps blocks and neighbouring elements apart when the build left no whitespace", () => {
    // The built site has no whitespace between tags, so these shapes from the home page, the
    // article hubs and the articles used to come out as "Проверка на местеКоды проверяются…".
    const html = page({
      route: "/faq/",
      title: "FAQ — Markiro",
      description: "Answers",
      body:
        '<ul><li><span aria-hidden="true">01</span><div><h3>Проверка на месте</h3><p>Коды проверяются на станции.</p></div></li></ul>' +
        "<ol><li><h3>Открыть смену</h3><p>Станция знает продукт.</p></li></ol>" +
        '<a href="/stati/dubl/"><span>11 мин чтения</span><span>Дубликат кода</span><span><time datetime="2026-08-27">27.08.2026</time></span><span aria-hidden="true">→</span></a>' +
        '<p><a href="/instruktsii/">Все инструкции</a><a href="/legal/">Договор и регламенты</a></p>' +
        '<ul><li><figure><img alt="Обложка" src="/cover.png"><figcaption>MKR-INS-01</figcaption></figure></li></ul>' +
        '<ul><li><a href="#line"><span aria-hidden="true"></span><span>Линия</span></a><div role="tooltip"><p>Линия</p><p>Станция проверяет код.</p></div></li></ul>' +
        "<p>H<sub>2</sub>O и <strong>вода</strong>.</p>",
    });

    const markdown = htmlToMarkdown(html, "https://markiro.app/faq/");

    const blocks = [
      "- **Проверка на месте** Коды проверяются на станции.",
      "1. **Открыть смену** Станция знает продукт.",
      "[11 мин чтения Дубликат кода 27.08.2026](https://markiro.app/stati/dubl/)",
      "[Все инструкции](https://markiro.app/instruktsii/) [Договор и регламенты](https://markiro.app/legal/)",
      "- ![Обложка](https://markiro.app/cover.png) MKR-INS-01",
      "- [Линия](https://markiro.app/faq/#line) Линия Станция проверяет код.",
      "H2O и вода.",
    ];
    expect(markdown.split("---\n\n")[1]).toBe(`${blocks.join("\n\n")}\n`);
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
    expect(full.indexOf("url: https://markiro.app/")).toBeLessThan(
      full.indexOf("url: https://markiro.app/faq/"),
    );
    expect(full.indexOf("url: https://markiro.app/faq/")).toBeLessThan(
      full.indexOf("url: https://markiro.app/en/"),
    );
    expect(full).not.toContain("Verify");
    expect(full).not.toContain("# 404");
  });
});
