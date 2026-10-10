import { expect, it } from "vitest";
import * as domain from "../src/index.js";
it("strict wrapping preserves explicit five-line names and never ellipsizes overflow", () => {
  expect(
    domain.wrapTextToWidthStrict?.("Один\nДва\nТри\nЧетыре\nПять", (s) => s.length, 20, 5),
  ).toEqual(["Один", "Два", "Три", "Четыре", "Пять"]);
  expect(() => domain.wrapTextToWidthStrict("Один Два Три", (s) => s.length, 5, 1)).toThrow(
    domain.DomainError,
  );
  expect(domain.wrapTextToWidth("Один Два Три", (s) => s.length, 5, 1)).toEqual(["Один…"]);
});
