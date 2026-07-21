import { describe, expectTypeOf, it } from "vitest";
import type { Auth, SessionWithActiveOrg } from "../src/auth-config.js";

describe("Auth narrowed typing", () => {
  it("getSession exposes activeOrganizationId", () => {
    type R = Awaited<ReturnType<Auth["api"]["getSession"]>>;
    expectTypeOf<NonNullable<R>>().toExtend<SessionWithActiveOrg>();
    expectTypeOf<NonNullable<R>["session"]["activeOrganizationId"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });
});
