import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("tenant team schema", () => {
  it("creates composite identity keys before foreign keys reference them", () => {
    const migration = readFileSync(
      new URL("../migrations/0027_tenant_team_mail_media.sql", import.meta.url),
      "utf8",
    );
    const memberUnique = migration.indexOf('ADD CONSTRAINT "member_organization_id_uq"');
    const memberReference = migration.indexOf(
      'ADD CONSTRAINT "cabinet_employee_links_tenant_member_fk"',
    );
    const invitationUnique = migration.indexOf('ADD CONSTRAINT "invitation_organization_id_uq"');
    const invitationReference = migration.indexOf(
      'ADD CONSTRAINT "cabinet_employee_links_tenant_invitation_fk"',
    );

    expect(memberUnique).toBeGreaterThan(-1);
    expect(invitationUnique).toBeGreaterThan(-1);
    expect(memberUnique).toBeLessThan(memberReference);
    expect(invitationUnique).toBeLessThan(invitationReference);
  });

  it("keeps global and tenant-local profile data in separate tables", () => {
    expect(getTableName(schema.userProfiles)).toBe("user_profiles");
    expect(getTableName(schema.tenantMemberProfiles)).toBe("tenant_member_profiles");
    expect(getTableName(schema.tenantInvitationProfiles)).toBe("tenant_invitation_profiles");
    expect(Object.keys(schema.userProfiles)).toEqual(
      expect.arrayContaining(["userId", "firstName", "lastName", "middleName", "avatarAssetId"]),
    );
    expect(schema.userProfiles.firstName.notNull).toBe(true);
    expect(schema.userProfiles.lastName.notNull).toBe(true);
    expect(schema.userProfiles.middleName.notNull).toBe(false);
    expect(Object.keys(schema.tenantMemberProfiles)).toEqual(
      expect.arrayContaining(["memberId", "organizationId", "position"]),
    );
  });

  it("makes one employee claim cover pending invitations and active members", () => {
    const config = getTableConfig(schema.cabinetEmployeeLinks);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "cabinet_employee_links_target_xor",
    );
    expect(config.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "cabinet_employee_links_tenant_employee_uq",
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "cabinet_employee_links_tenant_member_uq",
        "cabinet_employee_links_tenant_invitation_uq",
      ]),
    );
  });

  it("enforces same-tenant member, invitation, and employee references", () => {
    const foreignKeys = getTableConfig(schema.cabinetEmployeeLinks).foreignKeys;
    const names = foreignKeys.map((foreignKey) => foreignKey.getName());
    expect(names).toEqual(
      expect.arrayContaining([
        "cabinet_employee_links_tenant_employee_fk",
        "cabinet_employee_links_tenant_member_fk",
        "cabinet_employee_links_tenant_invitation_fk",
      ]),
    );
    for (const name of names.filter((value) =>
      value.startsWith("cabinet_employee_links_tenant_"),
    )) {
      const reference = foreignKeys
        .find((foreignKey) => foreignKey.getName() === name)!
        .reference();
      expect(reference.columns[0]?.name).toBe("organization_id");
      expect(reference.foreignColumns[0]?.name).toMatch(/organization_id|tenant_id/);
    }
  });

  it("stores immutable tenant audit events without recipient or message columns", () => {
    expect(getTableName(schema.tenantAuditEvents)).toBe("tenant_audit_events");
    expect(Object.keys(schema.tenantAuditEvents)).toEqual(
      expect.arrayContaining(["organizationId", "actorUserId", "action", "outcome", "targetId"]),
    );
    const auditColumns = Object.keys(schema.tenantAuditEvents);
    for (const forbidden of ["recipient", "message", "payload"]) {
      expect(auditColumns).not.toContain(forbidden);
    }
  });
});
