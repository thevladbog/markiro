import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  parseProvisionPlatformAdminArgs,
  runProvisionPlatformAdminCli,
} from "../src/cli/provision-platform-admin";

const ready = Boolean(
  process.env.DATABASE_URL &&
  process.env.PLATFORM_AUTH_SECRET &&
  process.env.PLATFORM_AUTH_URL &&
  process.env.SAAS_ADMIN_ORIGIN,
);

describe("provision platform admin CLI", () => {
  it("rejects every password argument before configuration or database access", async () => {
    expect(() =>
      parseProvisionPlatformAdminArgs(["--email", "admin@example.invalid", "--password", "x"]),
    ).toThrow("Password arguments are forbidden");
    const stderr: string[] = [];
    await expect(
      runProvisionPlatformAdminCli({
        argv: ["--email", "admin@example.invalid", "--password=x"],
        env: {},
        stdout: { write: () => undefined },
        stderr: { write: (value) => stderr.push(value) },
      }),
    ).resolves.toBe(1);
    expect(stderr.join("")).toContain("Password arguments are forbidden");
  });

  it.skipIf(!ready)("is idempotent and writes only user and delivery identifiers", async () => {
    const email = `bootstrap-${randomUUID()}@example.invalid`;
    const firstStdout: string[] = [];
    const secondStdout: string[] = [];
    const stderr: string[] = [];
    const firstExit = await runProvisionPlatformAdminCli({
      argv: ["--email", email],
      env: process.env,
      stdout: { write: (value) => firstStdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    });
    const secondExit = await runProvisionPlatformAdminCli({
      argv: ["--email", email],
      env: process.env,
      stdout: { write: (value) => secondStdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    });
    expect({ firstExit, secondExit, stderr }).toEqual({ firstExit: 0, secondExit: 0, stderr: [] });

    const first = JSON.parse(firstStdout.join("")) as Record<string, unknown>;
    const second = JSON.parse(secondStdout.join("")) as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["deliveryId", "userId"]);
    expect(second).toEqual(first);

    const connection = createDb(process.env.DATABASE_URL!);
    try {
      const users = await connection.db
        .select({ id: schema.platformUsers.id, role: schema.platformUsers.role })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.email, email));
      expect(users).toEqual([{ id: first.userId, role: "platform_admin" }]);
      const deliveries = await connection.db
        .select({ id: schema.emailDeliveries.id })
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.platformUserId, first.userId as string));
      expect(deliveries).toEqual([{ id: first.deliveryId }]);
    } finally {
      await connection.pool.end();
    }
  });
});
