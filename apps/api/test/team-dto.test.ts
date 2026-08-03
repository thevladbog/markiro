import { describe, expect, it } from "vitest";
import { createTeamInvitationSchema } from "../src/modules/team/dto";

describe("team DTO schemas", () => {
  it("trims an invitation email before validation and normalizes its casing", () => {
    expect(
      createTeamInvitationSchema.parse({
        email: "  Manager@Example.COM  ",
        role: "manager",
      }).email,
    ).toBe("manager@example.com");
  });
});
