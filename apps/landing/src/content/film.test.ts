import { describe, expect, it } from "vitest";

import { FILM_PAGES, FILM_SEARCH_PAGES, findFilmPage } from "./film";

const DASHES = /[–—]/u;
const ARROWS = /[↓→]/u;

function visibleStrings(locale: "ru" | "en"): string[] {
  const page = findFilmPage(locale);
  return [
    page.title,
    page.description,
    page.navigationLabel,
    page.socialImageAlt,
    page.railLabel,
    page.scrollHint,
    page.heroSecondary.label,
    page.finalSecondary.label,
    ...page.chapters.flatMap((chapter) => [
      chapter.railLabel,
      chapter.kicker,
      chapter.title,
      chapter.body,
      ...chapter.tags,
      ...(chapter.status === undefined ? [] : [chapter.status]),
    ]),
  ];
}

describe("film page copy", () => {
  it.each(["ru", "en"] as const)("tells seven chapters in %s", (locale) => {
    expect(findFilmPage(locale).chapters).toHaveLength(7);
  });

  it("keeps both locales in step", () => {
    const ru = findFilmPage("ru").chapters;
    const en = findFilmPage("en").chapters;
    expect(en.map((chapter) => chapter.id)).toEqual(ru.map((chapter) => chapter.id));
    expect(en.map((chapter) => chapter.span)).toEqual(ru.map((chapter) => chapter.span));
    expect(en.map((chapter) => chapter.theme)).toEqual(ru.map((chapter) => chapter.theme));
    expect(en.map((chapter) => chapter.tags.length)).toEqual(
      ru.map((chapter) => chapter.tags.length),
    );
    expect(en.map((chapter) => chapter.status === undefined)).toEqual(
      ru.map((chapter) => chapter.status === undefined),
    );
  });

  it.each(["ru", "en"] as const)("writes the %s copy without dashes", (locale) => {
    for (const text of visibleStrings(locale)) expect(text, text).not.toMatch(DASHES);
  });

  it.each(["ru", "en"] as const)(
    "keeps the %s decorative arrows out of the visible labels",
    (locale) => {
      const page = findFilmPage(locale);
      for (const text of [page.heroSecondary.label, page.finalSecondary.label, page.scrollHint]) {
        expect(text, text).not.toMatch(ARROWS);
      }
    },
  );

  it("numbers the kickers of chapters two to seven", () => {
    for (const page of FILM_PAGES) {
      page.chapters.slice(1).forEach((chapter, index) => {
        expect(chapter.kicker.startsWith(`0${index + 2} / `), chapter.kicker).toBe(true);
      });
    }
  });

  it("gives every chapter 130 to 160 % of the viewport in scroll", () => {
    const { chapters } = findFilmPage("ru");
    // Chapter 1 also holds the first screen, which is read before the camera moves.
    const scroll = chapters.map((chapter, index) =>
      index === 0 ? chapter.span - 1 : chapter.span,
    );
    for (const length of scroll) {
      expect(length).toBeGreaterThanOrEqual(1.3);
      expect(length).toBeLessThanOrEqual(1.6);
    }
    expect(scroll[0]).toBeCloseTo(1.6);
    expect(scroll.at(-1)).toBeCloseTo(1.6);
  });

  it("starts in daylight and ends at night", () => {
    expect(findFilmPage("ru").chapters.map((chapter) => chapter.theme)).toEqual([
      "light",
      "light",
      "light",
      "light",
      "light",
      "dark",
      "dark",
    ]);
  });

  it("links the locales to each other and publishes both for search", () => {
    const ru = findFilmPage("ru");
    const en = findFilmPage("en");
    expect(ru.path).toBe("/kak-rabotaet/");
    expect(en.path).toBe("/en/how-it-works/");
    expect(ru.alternatePath).toBe(en.path);
    expect(en.alternatePath).toBe(ru.path);
    expect(FILM_SEARCH_PAGES).toEqual(
      FILM_PAGES.map((page) => ({
        path: page.path,
        alternatePath: page.alternatePath,
        locale: page.locale,
        navigationLabel: page.navigationLabel,
        description: page.description,
        lastModified: page.reviewedAt,
      })),
    );
  });

  it("keeps titles and descriptions within snippet limits", () => {
    for (const page of FILM_PAGES) {
      expect(page.title.length, page.title).toBeLessThanOrEqual(70);
      expect(page.description.length, page.description).toBeGreaterThanOrEqual(120);
      expect(page.description.length, page.description).toBeLessThanOrEqual(170);
    }
  });

  it("uses the reviewed Russian copy", () => {
    const [district, line] = findFilmPage("ru").chapters;
    expect(district?.title).toBe("Маркировка и агрегация. Линия идёт.");
    expect(line?.title).toBe("Каждый код проверяем до короба.");
    expect(line?.body).toBe(
      "Станция не пустит в короб повторный код, код чужого товара или код с ошибкой. Оператор видит причину на экране.",
    );
  });
});
