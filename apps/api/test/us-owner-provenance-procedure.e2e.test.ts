import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  readCandidateLockedSeed,
  readPreviousLockedSeed,
} from "./support/us-owner-provenance-reference";

const base = process.env.US_TEST_DATABASE_URL;
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

describe.skipIf(!base)("US owner provenance procedure in an invocation-owned database", () => {
  let fixture: Fixture;
  let tenantId: string;
  let actorId: string;
  const at = new Date("2026-10-02T10:00:00.000Z");

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US test URL");
    fixture = await createUsProfileTestDatabase(base);
    const identity = await fixture.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name,current_user AS owner",
    );
    if (
      !/^markiro_us_profile_[a-f0-9_]+$/.test(identity.rows[0]?.name ?? "") ||
      identity.rows[0]?.owner !== "markiro_us"
    )
      throw new Error("Owned fixture identity invalid");
    console.info("owned owner provenance fixture", identity.rows[0]?.name);
    const owner = await new UsDevelopmentOwnerStore(fixture.db).provision(
      randomUUID() + randomUUID(),
      randomUUID(),
    );
    tenantId = owner.tenantId;
    actorId = owner.userId;
  }, 60_000);

  afterAll(async () => {
    if (!fixture) return;
    const name = (await fixture.pool.query<{ name: string }>("SELECT current_database() AS name"))
      .rows[0]?.name;
    await fixture.close();
    if (!base || !name) throw new Error("Owned fixture cleanup identity missing");
    const admin = createDb(base);
    try {
      expect(
        (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [name])).rows,
      ).toEqual([]);
      expect(
        (await admin.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [name])).rows,
      ).toEqual([]);
      console.info("disposed owner provenance fixture", name, "zero active clients");
    } finally {
      await admin.pool.end();
    }
  });

  it("returns the legacy safe result before calling the versioned candidate", async () => {
    await fixture.db.transaction(async (tx) => {
      const reference = await readPreviousLockedSeed(tx, tenantId, at, actorId);
      expect(reference).toEqual({
        seedId: tenantId,
        verifiedBy: "us-development-owner-v1",
        verifiedAt: at.toISOString(),
      });
      const result = await tx.execute<{ facts: unknown }>(sql`
        SELECT public.us_development_owner_provenance_v1(
          ${tenantId}::pg_catalog.text, ${JSON.stringify(actorId)}::pg_catalog.jsonb
        ) AS facts
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.facts).toMatchObject({ codec: "us-development-owner-provenance-v1" });
      expect(await readCandidateLockedSeed(tx, tenantId, at, actorId)).toEqual(reference);
    });
  });

  it("matches the previous locked reader over exact actor, row and JSON edge cases", async () => {
    class ExpectedRollback extends Error {}
    type Tx = Parameters<Parameters<typeof fixture.db.transaction>[0]>[0];
    const cases: {
      name: string;
      actor?: unknown;
      expected: boolean;
      mutate?: (tx: Tx) => Promise<unknown>;
    }[] = [
      { name: "unchanged", actor: actorId, expected: true },
      { name: "undefined actor", expected: true },
      { name: "wrong actor", actor: randomUUID(), expected: false },
      { name: "empty actor", actor: "", expected: false },
      { name: "null actor", actor: null, expected: false },
      { name: "number actor", actor: 7, expected: false },
      { name: "boolean actor", actor: true, expected: false },
      { name: "bigint actor", actor: 7n, expected: false },
      { name: "symbol actor", actor: Symbol("actor"), expected: false },
      { name: "String object actor", actor: new String(actorId), expected: false },
      { name: "NUL actor", actor: `${actorId}\0`, expected: false },
      { name: "unpaired surrogate actor", actor: `${actorId}\ud800`, expected: false },
      {
        name: "throwing serialization actor",
        actor: {
          toJSON() {
            throw Error("must not serialize");
          },
        },
        expected: false,
      },
      {
        name: "throwing driver coercion actor",
        actor: {
          toPostgres() {
            throw Error("must not coerce");
          },
        },
        expected: false,
      },
      {
        name: "throwing getter actor",
        actor: Object.defineProperty({}, "id", {
          get() {
            throw Error("must not inspect");
          },
        }),
        expected: false,
      },
      {
        name: "organization name",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.organization SET name='Other' WHERE id=${tenantId}`),
      },
      {
        name: "organization metadata SQL null",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.organization SET metadata=NULL WHERE id=${tenantId}`),
      },
      {
        name: "organization metadata spacing",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.organization SET metadata='{"synthetic": true,"seedVersion":"us-development-owner-v1"}' WHERE id=${tenantId}`,
          ),
      },
      {
        name: "organization slug",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.organization SET slug='other' WHERE id=${tenantId}`),
      },
      {
        name: "user name",
        actor: actorId,
        expected: false,
        mutate: (tx) => tx.execute(sql`UPDATE public."user" SET name='Other' WHERE id=${actorId}`),
      },
      {
        name: "user email",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public."user" SET email='other@example.test' WHERE id=${actorId}`),
      },
      {
        name: "membership missing",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`DELETE FROM public.member WHERE organization_id=${tenantId}`),
      },
      {
        name: "membership nonowner",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.member SET role='member' WHERE organization_id=${tenantId}`),
      },
      {
        name: "membership duplicate",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`INSERT INTO public.member(id,organization_id,user_id,role,created_at)
          VALUES(${randomUUID()},${tenantId},${actorId},'member',now())`),
      },
      {
        name: "credential missing",
        actor: actorId,
        expected: false,
        mutate: (tx) => tx.execute(sql`DELETE FROM public.account WHERE user_id=${actorId}`),
      },
      {
        name: "credential duplicate",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`INSERT INTO public.account(id,account_id,provider_id,user_id,password,updated_at)
          VALUES(${randomUUID()},${actorId},'credential',${actorId},'synthetic-local-hash',now())`),
      },
      {
        name: "credential misbound",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.account SET account_id='other' WHERE user_id=${actorId}`),
      },
      {
        name: "credential SQL null password",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.account SET password=NULL WHERE user_id=${actorId}`),
      },
      {
        name: "credential empty password",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.account SET password='' WHERE user_id=${actorId}`),
      },
      {
        name: "credential whitespace password",
        actor: actorId,
        expected: true,
        mutate: (tx) =>
          tx.execute(sql`UPDATE public.account SET password=' ' WHERE user_id=${actorId}`),
      },
      {
        name: "audit missing",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`DELETE FROM public.tenant_audit_events WHERE organization_id=${tenantId}`),
      },
      {
        name: "audit duplicate",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(sql`INSERT INTO public.tenant_audit_events(organization_id,action,outcome,target_type,target_id,request_id)
          VALUES(${tenantId},'us.development.owner.provisioned','failure','tenant',${tenantId},${randomUUID()})`),
      },
      {
        name: "audit actor SQL null",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET actor_user_id=NULL WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit outcome",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET outcome='failure' WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit target type",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET target_type='user' WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit target ID",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET target_id='other' WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit before object",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET "before"='{}'::jsonb WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit before JSON null",
        actor: actorId,
        expected: true,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET "before"='null'::jsonb WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit after SQL null",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET "after"=NULL WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit after JSON null",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET "after"='null'::jsonb WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit after extra key",
        actor: actorId,
        expected: false,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET "after"='{"synthetic":true,"seedVersion":"us-development-owner-v1","extra":1}'::jsonb WHERE organization_id=${tenantId}`,
          ),
      },
      {
        name: "audit after reversed input keys",
        actor: actorId,
        expected: true,
        mutate: (tx) =>
          tx.execute(
            sql`UPDATE public.tenant_audit_events SET "after"='{"seedVersion":"us-development-owner-v1","synthetic":true}'::jsonb WHERE organization_id=${tenantId}`,
          ),
      },
    ];
    for (const testCase of cases) {
      try {
        await fixture.db.transaction(async (tx) => {
          await testCase.mutate?.(tx);
          const actor = testCase.actor as string | undefined;
          const reference = await readPreviousLockedSeed(tx, tenantId, at, actor);
          const candidate = await readCandidateLockedSeed(tx, tenantId, at, actor);
          expect(candidate, testCase.name).toEqual(reference);
          expect(candidate !== null, testCase.name).toBe(testCase.expected);
          throw new ExpectedRollback();
        });
      } catch (error) {
        if (!(error instanceof ExpectedRollback)) throw error;
      }
    }
  });

  for (const isolation of ["read committed", "repeatable read"] as const) {
    for (const kind of ["previous", "candidate"] as const) {
      it(`re-evaluates ${kind} provenance on repeated calls in one ${isolation} transaction`, async () => {
        class ExpectedRollback extends Error {}
        try {
          await fixture.db.transaction(
            async (tx) => {
              const read = () =>
                kind === "previous"
                  ? readPreviousLockedSeed(tx, tenantId, at, actorId)
                  : readCandidateLockedSeed(tx, tenantId, at, actorId);
              expect(await read()).toMatchObject({ seedId: tenantId });
              await tx.execute(
                sql`UPDATE public.organization SET name='Changed' WHERE id=${tenantId}`,
              );
              expect(await read()).toBeNull();
              await tx.execute(
                sql`UPDATE public.organization SET name='Synthetic US development' WHERE id=${tenantId}`,
              );
              expect(await read()).toMatchObject({ seedId: tenantId });
              throw new ExpectedRollback();
            },
            { isolationLevel: isolation },
          );
        } catch (error) {
          if (!(error instanceof ExpectedRollback)) throw error;
        }
      });
    }
  }

  it("does not execute SQL for an invalid verified date", async () => {
    class ExpectedRollback extends Error {}
    try {
      await fixture.db.transaction(async (tx) => {
        await tx.execute(
          sql`DROP FUNCTION public.us_development_owner_provenance_v1(pg_catalog.text,pg_catalog.jsonb)`,
        );
        const invalid = new Date(Number.NaN);
        expect(await readPreviousLockedSeed(tx, tenantId, invalid, actorId)).toBeNull();
        expect(await readCandidateLockedSeed(tx, tenantId, invalid, actorId)).toBeNull();
        throw new ExpectedRollback();
      });
    } catch (error) {
      if (!(error instanceof ExpectedRollback)) throw error;
    }
  });

  it("uses exact builtin casts and public relations despite temporary and path shadows", async () => {
    await fixture.db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE organization(id pg_catalog.text, slug pg_catalog.text, name pg_catalog.text, metadata pg_catalog.text) ON COMMIT DROP`,
      );
      await tx.execute(
        sql`INSERT INTO pg_temp.organization(id,slug,name,metadata) VALUES(${tenantId},'us-development-demo','Forged','forged')`,
      );
      await tx.execute(sql`SET LOCAL search_path=pg_temp,public`);
      const result = await tx.execute<{ facts: unknown }>(sql`
        SELECT public.us_development_owner_provenance_v1(
          ${tenantId}::pg_catalog.text, ${JSON.stringify(actorId)}::pg_catalog.jsonb
        ) AS facts
      `);
      expect(result.rows[0]?.facts).toMatchObject({
        codec: "us-development-owner-provenance-v1",
        organization: { id: tenantId, name: "Synthetic US development" },
      });
      expect(await readCandidateLockedSeed(tx, tenantId, at, actorId)).toMatchObject({
        seedId: tenantId,
      });
    });
  });

  it("keeps SQL NULL actor distinct from supplied JSON null and returns bounded safe facts", async () => {
    const [missingActor, jsonNull, nullTenant] = await Promise.all([
      fixture.db.execute<{ facts: unknown }>(
        sql`SELECT public.us_development_owner_provenance_v1(${tenantId}::pg_catalog.text,NULL::pg_catalog.jsonb) AS facts`,
      ),
      fixture.db.execute<{ facts: unknown }>(
        sql`SELECT public.us_development_owner_provenance_v1(${tenantId}::pg_catalog.text,'null'::pg_catalog.jsonb) AS facts`,
      ),
      fixture.db.execute<{ facts: unknown }>(
        sql`SELECT public.us_development_owner_provenance_v1(NULL::pg_catalog.text,NULL::pg_catalog.jsonb) AS facts`,
      ),
    ]);
    expect(missingActor.rows[0]?.facts).toEqual({
      codec: "us-development-owner-provenance-v1",
      organization: {
        id: tenantId,
        name: "Synthetic US development",
        metadata: '{"synthetic":true,"seedVersion":"us-development-owner-v1"}',
      },
      user: { id: actorId, name: "Synthetic US development owner" },
      memberships: { count: 1, soleRole: "owner" },
      credentials: { count: 1, soleAccountId: actorId, nonemptyPassword: true },
      audits: {
        count: 1,
        sole: {
          actorUserId: actorId,
          outcome: "success",
          targetType: "tenant",
          targetId: tenantId,
          before: null,
          after: { synthetic: true, seedVersion: "us-development-owner-v1" },
        },
      },
    });
    expect(jsonNull.rows).toEqual([{ facts: null }]);
    expect(nullTenant.rows).toEqual([{ facts: null }]);
  });
});
