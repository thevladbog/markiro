import { describe, expect, it } from "vitest";
import ru from "../src/i18n/ru.json";

it("uses the single-л spelling of палета throughout the office and station", () => {
  expect(JSON.stringify(ru)).not.toMatch(/палл[еёэ]т/iu);
});

describe("search wording", () => {
  it("keeps the search action short and leaves product names out of search messages", () => {
    expect(ru.office.search.submit).toBe("Найти");
    expect(JSON.stringify(ru.office.search)).not.toMatch(/автоном/iu);
  });
});
