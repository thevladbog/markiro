import { createHash, randomUUID } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import {
  captureUsRequestTenantOrigin,
  usRequestTenantOriginSchema,
} from "../src/modules/traceability/requests/us-request-tenant-origin";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const metadata = JSON.stringify({ synthetic: true, seedVersion: "us-development-owner-v1" });
const negative = {
  schemaVersion: 1,
  verificationPolicy: "us-request-tenant-origin-v1",
  result: "not_attested",
  trustedSeed: null,
};

describe.skipIf(!base)("transaction-bound US request tenant origin", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let owner: Awaited<ReturnType<UsDevelopmentOwnerStore["provision"]>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test database");
    f = await createUsProfileTestDatabase(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.pool.query('TRUNCATE TABLE organization, "user" CASCADE');
    owner = await new UsDevelopmentOwnerStore(f.db).provision(
      "Synthetic-local-owner-password-42!",
      randomUUID(),
    );
  });

  const positive = () => ({
    schemaVersion: 1,
    verificationPolicy: "us-request-tenant-origin-v1",
    result: "trusted_synthetic",
    trustedSeed: { seedId: owner.tenantId, verifiedBy: "us-development-owner-v1" },
  });
  const capture = (tenantId = owner.tenantId) =>
    f.db.transaction((tx) => captureUsRequestTenantOrigin(f.db, tx, tenantId), {
      isolationLevel: "repeatable read",
    });
  // Hash entire persisted rows so a failing assertion cannot print credential values.
  async function rowDigests() {
    const rows = await Promise.all([
      f.db.select().from(schema.organization).orderBy(schema.organization.id),
      f.db.select().from(schema.user).orderBy(schema.user.id),
      f.db.select().from(schema.member).orderBy(schema.member.id),
      f.db.select().from(schema.account).orderBy(schema.account.id),
      f.db.select().from(schema.tenantAuditEvents).orderBy(schema.tenantAuditEvents.id),
    ]);
    return rows.map((set) => createHash("sha256").update(JSON.stringify(set)).digest("hex"));
  }
  async function expectInvalid(tenantId = owner.tenantId) {
    const before = await rowDigests();
    const error: unknown = await capture(tenantId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (!(error instanceof ServiceUnavailableException)) throw new Error("Expected origin failure");
    expect(error.getResponse()).toEqual({ code: "us_request_tenant_origin_invalid" });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain("private-origin-text");
    expect(await rowDigests()).toEqual(before);
  }

  it("captures stable positive evidence at different verifier observation times without writes", async () => {
    const before = await rowDigests();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
      const first = await capture();
      vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
      const second = await capture();
      expect(first).toEqual(positive());
      expect(second).toEqual(first);
      expect(JSON.stringify(first)).not.toContain("verifiedAt");
    } finally {
      vi.useRealTimers();
    }
    expect(await rowDigests()).toEqual(before);
  });

  it("keeps an unrelated receiving tenant negative even with a reserved owner and matching names", async () => {
    const other = await seedReceivingTenant(f.db);
    await f.db
      .update(schema.organization)
      .set({ name: "Synthetic US development" })
      .where(eq(schema.organization.id, other.tenant));
    const before = await rowDigests();
    expect(await capture(other.tenant)).toEqual(negative);
    expect(await rowDigests()).toEqual(before);
  });

  const mutations = [
    [
      "reserved slug changed",
      async () => {
        await f.db.update(schema.organization).set({ slug: "changed-seed" });
      },
    ],
    [
      "metadata missing",
      async () => {
        await f.db.update(schema.organization).set({ metadata: null });
      },
    ],
    [
      "metadata altered",
      async () => {
        await f.db.update(schema.organization).set({
          metadata: JSON.stringify({ synthetic: false, seedVersion: "us-development-owner-v1" }),
        });
      },
    ],
    [
      "malformed metadata retains seed identifier",
      async () => {
        await f.db
          .update(schema.organization)
          .set({ slug: "changed-seed", metadata: '{"seedVersion":"us-development-owner-v1"' });
        await f.db.delete(schema.tenantAuditEvents);
      },
    ],
    [
      "organization name altered",
      async () => {
        await f.db.update(schema.organization).set({ name: "Changed organization" });
      },
    ],
    [
      "parsed reserved identifier survives JSON escaping and other marker erasure",
      async () => {
        await f.db.update(schema.organization).set({
          slug: "changed-seed",
          metadata: JSON.stringify({
            synthetic: false,
            seedVersion: "us-development-owner-v1",
          }).replace("us-development", "\\u0075s-development"),
        });
        await f.db.delete(schema.tenantAuditEvents);
      },
    ],
    [
      "actor email altered",
      async () => {
        await f.db.update(schema.user).set({ email: "changed@example.test" });
      },
    ],
    [
      "actor name altered",
      async () => {
        await f.db.update(schema.user).set({ name: "Changed actor" });
      },
    ],
    [
      "membership revoked",
      async () => {
        await f.db.update(schema.member).set({ role: "member" });
      },
    ],
    [
      "membership missing",
      async () => {
        await f.db.delete(schema.member);
      },
    ],
    [
      "membership duplicated",
      async () => {
        await f.db.insert(schema.member).values({
          id: randomUUID(),
          organizationId: owner.tenantId,
          userId: owner.userId,
          role: "owner",
          createdAt: new Date(),
        });
      },
    ],
    [
      "credential missing",
      async () => {
        await f.db.delete(schema.account);
      },
    ],
    [
      "credential duplicated",
      async () => {
        await f.db.insert(schema.account).values({
          id: randomUUID(),
          userId: owner.userId,
          accountId: owner.userId,
          providerId: "credential",
          password: "synthetic-corrupt-credential",
        });
      },
    ],
    [
      "credential identity altered",
      async () => {
        await f.db.update(schema.account).set({ accountId: randomUUID() });
      },
    ],
    [
      "credential password absent",
      async () => {
        await f.db.update(schema.account).set({ password: null });
      },
    ],
    [
      "audit missing",
      async () => {
        await f.db.delete(schema.tenantAuditEvents);
      },
    ],
    [
      "audit altered",
      async () => {
        await f.db
          .update(schema.tenantAuditEvents)
          .set({ after: { synthetic: false, seedVersion: "us-development-owner-v1" } });
      },
    ],
    [
      "audit actor altered",
      async () => {
        const other = await seedReceivingTenant(f.db);
        await f.db.update(schema.tenantAuditEvents).set({ actorUserId: other.actor });
      },
    ],
    [
      "audit duplicated",
      async () => {
        const [audit] = await f.db.select().from(schema.tenantAuditEvents);
        if (!audit) throw new Error("Missing fixture audit");
        await f.db
          .insert(schema.tenantAuditEvents)
          .values({ ...audit, id: randomUUID(), requestId: randomUUID() });
      },
    ],
    [
      "audit remains after slug and metadata erasure",
      async () => {
        await f.db.update(schema.organization).set({ slug: "erased-seed", metadata: null });
      },
    ],
  ] as const;

  it.each(mutations)("fails closed without repairs when %s", async (_name, mutate) => {
    await mutate();
    const verifier = vi.spyOn(UsDevelopmentOwnerStore.prototype, "verifyTrustedSeed");
    try {
      await expectInvalid();
      if (_name.includes("duplicated")) expect(verifier).not.toHaveBeenCalled();
    } finally {
      verifier.mockRestore();
    }
  });

  it("rejects copied reserved metadata on another tenant", async () => {
    const other = await seedReceivingTenant(f.db);
    await f.db
      .update(schema.organization)
      .set({ metadata })
      .where(eq(schema.organization.id, other.tenant));
    await expectInvalid(other.tenant);
  });

  it("rejects another tenant's copied provisioning audit without granting owner authority", async () => {
    const other = await seedReceivingTenant(f.db);
    const [audit] = await f.db.select().from(schema.tenantAuditEvents);
    if (!audit) throw new Error("Missing fixture audit");
    await f.db.insert(schema.tenantAuditEvents).values({
      ...audit,
      id: randomUUID(),
      organizationId: other.tenant,
      requestId: randomUUID(),
    });
    await expectInvalid(other.tenant);
    expect(await capture()).toEqual(positive());
  });

  it("treats complete marker erasure as absence of attestation, never verified real operation", async () => {
    await f.db.update(schema.organization).set({ slug: "erased-seed", metadata: null });
    await f.db.delete(schema.tenantAuditEvents);
    const before = await rowDigests();
    expect(await capture()).toEqual(negative);
    expect(await rowDigests()).toEqual(before);
  });

  it("fails technically for an absent tenant", async () => {
    await expectInvalid(randomUUID());
  });

  it("sanitizes a verifier failure containing private text", async () => {
    const spy = vi
      .spyOn(UsDevelopmentOwnerStore.prototype, "verifyTrustedSeed")
      .mockRejectedValueOnce(new Error("private-origin-text"));
    try {
      await expectInvalid();
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the supplied transaction for every read without opening another snapshot", async () => {
    const before = await rowDigests();
    const result = await f.db.transaction(
      async (tx) => {
        const rootRead = vi.spyOn(f.db, "select").mockImplementation(() => {
          throw new Error("Root read forbidden");
        });
        const rootTransaction = vi.spyOn(f.db, "transaction").mockImplementation(() => {
          throw new Error("Nested transaction forbidden");
        });
        try {
          return await captureUsRequestTenantOrigin(f.db, tx, owner.tenantId);
        } finally {
          rootRead.mockRestore();
          rootTransaction.mockRestore();
        }
      },
      { isolationLevel: "repeatable read" },
    );
    expect(result).toEqual(positive());
    expect(await rowDigests()).toEqual(before);
  });

  it("sanitizes database failures without exposing causes or changing rows", async () => {
    const before = await rowDigests();
    const error: unknown = await f.db
      .transaction(
        async (tx) => {
          const spy = vi.spyOn(tx, "select").mockImplementationOnce(() => {
            throw new Error("private-origin-text");
          });
          try {
            return await captureUsRequestTenantOrigin(f.db, tx, owner.tenantId);
          } finally {
            spy.mockRestore();
          }
        },
        { isolationLevel: "repeatable read" },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (!(error instanceof ServiceUnavailableException)) throw new Error("Expected origin failure");
    expect(error.getResponse()).toEqual({ code: "us_request_tenant_origin_invalid" });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain("private-origin-text");
    expect(await rowDigests()).toEqual(before);
  });

  it("retains established repeatable-read origin while a second connection commits an edit", async () => {
    let signalEstablished = () => {};
    const established = new Promise<void>((resolve) => {
      signalEstablished = resolve;
    });
    let signalEdited = () => {};
    const edited = new Promise<void>((resolve) => {
      signalEdited = resolve;
    });
    const first = f.db.transaction(
      async (tx) => {
        await tx
          .select()
          .from(schema.organization)
          .where(eq(schema.organization.id, owner.tenantId));
        signalEstablished();
        await edited;
        return captureUsRequestTenantOrigin(f.db, tx, owner.tenantId);
      },
      { isolationLevel: "repeatable read" },
    );
    try {
      await established;
      await f.pool.query("UPDATE organization SET metadata = $1 WHERE id = $2", [
        null,
        owner.tenantId,
      ]);
      signalEdited();
      expect(await first).toEqual(positive());
      await expectInvalid();
    } finally {
      signalEdited();
      await first;
      await f.db
        .update(schema.organization)
        .set({ metadata })
        .where(eq(schema.organization.id, owner.tenantId));
    }
  });

  it("rejects unstable or unsupported fields in its strict internal schema", () => {
    expect(usRequestTenantOriginSchema.safeParse(positive()).success).toBe(true);
    expect(usRequestTenantOriginSchema.safeParse(negative).success).toBe(true);
    for (const input of [
      { ...positive(), verifiedAt: "2026-10-04T10:00:00Z" },
      { ...positive(), verificationPolicy: "unsupported" },
      { ...positive(), schemaVersion: 2 },
      { ...positive(), trustedSeed: null },
      { ...positive(), trustedSeed: { seedId: owner.tenantId, verifiedBy: "unsupported" } },
      {
        ...positive(),
        trustedSeed: { seedId: owner.tenantId, verifiedBy: "us-development-owner-v1", extra: true },
      },
      { ...negative, trustedSeed: positive().trustedSeed },
    ])
      expect(usRequestTenantOriginSchema.safeParse(input).success).toBe(false);
  });
});
