import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { listJournalQuerySchema } from "../src/modules/integrations/dto.js";
import { resolveJournalQuery } from "../src/modules/integrations/journal-query.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("integration journal query", () => {
  it("defaults to the first 20 chronological rows from the last 30 days", () => {
    const parsed = listJournalQuerySchema.parse({});

    expect(resolveJournalQuery(parsed, NOW)).toEqual({
      page: 1,
      pageSize: 20,
      outcome: "all",
      direction: "all",
      from: new Date("2026-08-03T12:00:00.000Z"),
      to: NOW,
      // The repository uses the database clock for this upper bound so
      // process/database clock skew cannot hide a just-committed event.
      toIsImplicit: true,
    });
  });

  it("preserves explicit paging, filters, and dates", () => {
    const parsed = listJournalQuerySchema.parse({
      page: "2",
      pageSize: "50",
      outcome: "error",
      direction: "local",
      from: "2026-08-26T12:00:00.000Z",
      to: "2026-09-02T12:00:00.000Z",
    });

    expect(resolveJournalQuery(parsed, NOW)).toEqual({
      page: 2,
      pageSize: 50,
      outcome: "error",
      direction: "local",
      from: new Date("2026-08-26T12:00:00.000Z"),
      to: new Date("2026-09-02T12:00:00.000Z"),
      toIsImplicit: false,
    });
  });

  it.each([
    ["zero page", { page: 0 }],
    ["oversized page", { pageSize: 51 }],
    ["unknown outcome", { outcome: "failed" }],
    ["unknown direction", { direction: "sideways" }],
    ["malformed from date", { from: "not-a-date" }],
    ["malformed to date", { to: "not-a-date" }],
  ])("rejects %s", (_name, query) => {
    expect(listJournalQuerySchema.safeParse(query).success).toBe(false);
  });

  it("rejects a reversed date window", () => {
    const parsed = listJournalQuerySchema.parse({
      from: "2026-09-03T00:00:00.000Z",
      to: "2026-09-02T00:00:00.000Z",
    });

    expect(() => resolveJournalQuery(parsed, NOW)).toThrow(BadRequestException);
  });

  it("rejects a window longer than 90 days", () => {
    const parsed = listJournalQuerySchema.parse({
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-09-02T00:00:00.000Z",
    });

    expect(() => resolveJournalQuery(parsed, NOW)).toThrow(BadRequestException);
  });
});
