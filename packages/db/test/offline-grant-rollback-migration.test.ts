import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsFolder = join(__dirname, "../migrations");

describe("offline grant rollback migration", () => {
  it("installs rollback persistence without changing existing activation rows", async () => {
    const sql = await readFile(join(migrationsFolder, "0155_offline_grant_rollback.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "offline_grant_rollback_preparations"');
    expect(sql).toContain('CREATE TABLE "offline_grant_rollback_members"');
    expect(sql).toContain("offline_grant_rollback_confirm_actor_check");
    expect(sql).toContain("offline_grant_rollback_members_active_reservation_uq");
    expect(sql).toMatch(
      /ADD CONSTRAINT "offline_grant_device_activations_rollback_check" CHECK[\s\S]*NOT VALID/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "offline_grant_device_activations_rollback_preparation_fk"[\s\S]*NOT VALID/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "offline_grant_device_activations_observe_policy_fk"[\s\S]*NOT VALID/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "offline_grant_device_activations_rolled_back_by_fk"[\s\S]*NOT VALID/,
    );
    expect(sql).not.toMatch(/UPDATE\s+"?offline_grant_device_activations/i);
  });

  it("validates activation rollback foreign keys after the additive migration", async () => {
    const sql = await readFile(
      join(migrationsFolder, "0156_validate_offline_grant_rollback.sql"),
      "utf8",
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "offline_grant_device_activations_rollback_preparation_fk"',
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "offline_grant_device_activations_observe_policy_fk"',
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "offline_grant_device_activations_rolled_back_by_fk"',
    );
    expect(sql).toContain('VALIDATE CONSTRAINT "offline_grant_device_activations_rollback_check"');
  });
});
