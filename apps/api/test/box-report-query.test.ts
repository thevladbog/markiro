import { describe, expect, it } from "vitest";

import { boxReportQuerySchema } from "../src/modules/code-search/dto";

describe("boxReportQuerySchema", () => {
  it("retains UTC for existing report URLs without a viewer timezone", () => {
    expect(boxReportQuerySchema.parse({})).toEqual({ timeZone: "UTC" });
  });

  it.each(["Not/A_Time_Zone", "", "<script>", ["UTC", "Europe/Moscow"]])(
    "rejects invalid or repeated timezone values: %s",
    (timeZone) => {
      expect(boxReportQuerySchema.safeParse({ timeZone }).success).toBe(false);
    },
  );
});
