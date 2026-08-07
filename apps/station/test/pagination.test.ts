import { describe, expect, it } from "vitest";
import { paginate } from "../src/lib/pagination.js";

describe("paginate", () => {
  it("returns deterministic one-based slices and page count", () => {
    const values = ["a", "b", "c", "d", "e", "f", "g"];

    expect(paginate(values, 1, 3)).toEqual({
      items: ["a", "b", "c"],
      page: 1,
      pageCount: 3,
    });
    expect(paginate(values, 2, 3)).toEqual({
      items: ["d", "e", "f"],
      page: 2,
      pageCount: 3,
    });
  });

  it("clamps the requested page when the dataset shrinks or the page is invalid", () => {
    expect(paginate(["a", "b"], 4, 3)).toEqual({
      items: ["a", "b"],
      page: 1,
      pageCount: 1,
    });
    expect(paginate(["a", "b", "c", "d"], -2, 3)).toEqual({
      items: ["a", "b", "c"],
      page: 1,
      pageCount: 2,
    });
  });

  it("keeps an empty dataset on a stable first page", () => {
    expect(paginate([], 8, 3)).toEqual({ items: [], page: 1, pageCount: 1 });
  });
});
