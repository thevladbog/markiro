import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { InvitationLookupRateLimiter } from "../src/modules/invitations/invitation-lookup-rate-limiter";

describe("InvitationLookupRateLimiter", () => {
  it("keeps source and invitation overflow budgets independent", () => {
    const limiter = new InvitationLookupRateLimiter();
    const now = Date.now();

    // Each lookup creates one source and one invitation window. Five thousand
    // distinct lookups therefore fill the bounded 10,000-window map exactly.
    for (let index = 0; index < 5_000; index += 1) {
      limiter.assertAllowed(`source-${index}`, `invitation-${index}`, now);
    }

    for (let index = 0; index < 20; index += 1) {
      expect(() =>
        limiter.assertAllowed("overflow-source", `overflow-${index}`, now),
      ).not.toThrow();
    }

    try {
      limiter.assertAllowed("overflow-source", "overflow-limit", now);
      throw new Error("Expected the invitation overflow budget to be exhausted");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
  });
});
