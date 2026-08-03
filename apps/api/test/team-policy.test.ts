import { describe, expect, it } from "vitest";
import { canAssignTeamRole, canMutateTeamTarget } from "../src/modules/team/team-policy";

describe("team target policy", () => {
  it("allows an admin to manage another manager or admin", () => {
    expect(
      canMutateTeamTarget({
        actorId: "a",
        actorRole: "admin",
        targetId: "b",
        targetRole: "manager",
      }),
    ).toBe(true);
    expect(
      canMutateTeamTarget({
        actorId: "a",
        actorRole: "admin",
        targetId: "b",
        targetRole: "admin",
      }),
    ).toBe(true);
  });

  it("protects the actor from changing or removing themselves", () => {
    expect(
      canMutateTeamTarget({
        actorId: "a",
        actorRole: "admin",
        targetId: "a",
        targetRole: "admin",
      }),
    ).toBe(false);
  });

  it("protects an owner even from another owner", () => {
    expect(
      canMutateTeamTarget({
        actorId: "a",
        actorRole: "owner",
        targetId: "o",
        targetRole: "owner",
      }),
    ).toBe(false);
  });

  it("never gives a manager team mutation authority", () => {
    expect(
      canMutateTeamTarget({
        actorId: "m",
        actorRole: "manager",
        targetId: "b",
        targetRole: "manager",
      }),
    ).toBe(false);
  });

  it("allows product-facing assignment of admin and manager only", () => {
    expect(canAssignTeamRole("admin", "admin")).toBe(true);
    expect(canAssignTeamRole("admin", "manager")).toBe(true);
    expect(canAssignTeamRole("owner", "admin")).toBe(true);
    expect(canAssignTeamRole("owner", "manager")).toBe(true);
    expect(canAssignTeamRole("owner", "owner" as never)).toBe(false);
    expect(canAssignTeamRole("owner", "member" as never)).toBe(false);
  });
});
