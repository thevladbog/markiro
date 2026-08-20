import { describe, expect, it } from "vitest";

import { formatLabelDate, LABEL_DATE_FORMAT } from "../src/index.js";

/**
 * The format the customer approved on paper and the format the FIRST physical
 * print got wrong (it printed `2026-08-20`). Pinned here so a refactor that
 * "simplifies" the date pipeline back onto the ISO string it is built from
 * cannot ship silently a second time.
 */
describe("formatLabelDate", () => {
  it("renders a YYYY-MM-DD calendar date as дд.мм.гггг", () => {
    expect(LABEL_DATE_FORMAT).toBe("дд.мм.гггг");
    expect(formatLabelDate("2026-08-20")).toBe("20.08.2026");
    expect(formatLabelDate("2026-07-23")).toBe("23.07.2026");
    expect(formatLabelDate("2027-01-19")).toBe("19.01.2027");
  });

  it("keeps the zero padding — a label column is a fixed width", () => {
    expect(formatLabelDate("2026-01-02")).toBe("02.01.2026");
  });

  /**
   * A label must never fail to print because of a date, so nothing here
   * throws: the station passes "" for a product with no shelf life, and
   * `boxLabelFields` passes whatever `localIsoDate` returned for a malformed
   * instant.
   */
  it("passes anything that is not a YYYY-MM-DD date through unchanged", () => {
    expect(formatLabelDate("")).toBe("");
    expect(formatLabelDate("garbage")).toBe("garbage");
    expect(formatLabelDate("2026-08-20T10:00:00.000Z")).toBe("2026-08-20T10:00:00.000Z");
    expect(formatLabelDate("20.08.2026")).toBe("20.08.2026");
  });
});
