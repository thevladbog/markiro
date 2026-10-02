import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  parseUsLotCardEvidenceQuery,
  parseUsTraceSearchQuery,
} from "../src/modules/traceability/trace/us-trace-search-query";

const lotId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("US search and card HTTP query parsing", () => {
  it("returns normalized filters and decoded stable keyset cursors", () => {
    const search = parseUsTraceSearchQuery({
      q: "007",
      tlcList: '["A,B","007"]',
      cursor: encoded({ createdAt: "2026-09-27T10:00:00.000Z", lotId }),
    });
    expect(search).toMatchObject({
      q: "007",
      tlcList: ["A,B", "007"],
      limit: 50,
      cursor: { createdAt: "2026-09-27T10:00:00.000Z", lotId },
    });
    expect(
      parseUsLotCardEvidenceQuery({
        cursor: encoded({ eventDate: "2026-09-27", eventId }),
      }),
    ).toEqual({ limit: 20, cursor: { eventDate: "2026-09-27", eventId } });
  });

  it("maps malformed values and noncanonical or oversized cursors to safe 400s", () => {
    for (const query of [
      { limit: "101" },
      { tenantId: lotId },
      { cursor: encoded({ createdAt: "2026-09-27", lotId }) },
      { cursor: encoded({ createdAt: "2026-09-27T10:00:00.000Z", lotId, tenantId: lotId }) },
      { cursor: "a" },
      { cursor: `${encoded({ createdAt: "2026-09-27T10:00:00.000Z", lotId })}=` },
      {
        cursor: Buffer.from(
          ` ${" ".repeat(384)}${JSON.stringify({ createdAt: "2026-09-27T10:00:00.000Z", lotId })}`,
        ).toString("base64url"),
      },
    ]) {
      try {
        parseUsTraceSearchQuery(query);
        throw new Error("Expected search query rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: "us_invalid_query",
        });
      }
    }
    expect(() =>
      parseUsLotCardEvidenceQuery({ cursor: encoded({ eventDate: "2026-02-30", eventId }) }),
    ).toThrow(BadRequestException);
  });
});
