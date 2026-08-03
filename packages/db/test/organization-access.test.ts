import { describe, expect, it } from "vitest";
import { organizationRoles } from "../src/organization-access.js";

describe("Better Auth organization roles", () => {
  it("allows only owner to mutate the organization and members", () => {
    expect(organizationRoles.owner.authorize({ organization: ["update"] }).success).toBe(true);
    expect(organizationRoles.owner.authorize({ member: ["update"] }).success).toBe(true);

    for (const role of [
      organizationRoles.admin,
      organizationRoles.manager,
      organizationRoles.member,
    ]) {
      expect(role.authorize({ organization: ["update"] }).success).toBe(false);
      expect(role.authorize({ member: ["update"] }).success).toBe(false);
      expect(role.authorize({ invitation: ["create"] }).success).toBe(false);
    }
  });

  it("keeps non-mutating access-control discovery for known members", () => {
    expect(organizationRoles.admin.authorize({ ac: ["read"] }).success).toBe(true);
    expect(organizationRoles.manager.authorize({ ac: ["read"] }).success).toBe(true);
    expect(organizationRoles.member.authorize({ ac: ["read"] }).success).toBe(true);
  });

  it("gives only admin and owner the internal permission needed to mint org keys", () => {
    expect(organizationRoles.owner.authorize({ apiKey: ["create"] }).success).toBe(true);
    expect(organizationRoles.admin.authorize({ apiKey: ["create"] }).success).toBe(true);
    expect(organizationRoles.admin.authorize({ apiKey: ["read"] }).success).toBe(false);
    expect(organizationRoles.manager.authorize({ apiKey: ["create"] }).success).toBe(false);
    expect(organizationRoles.member.authorize({ apiKey: ["create"] }).success).toBe(false);
  });
});
