import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe.skipIf(!databaseUrl)("working device replacement forward migration", () => {
  const name = `markiro_replacement_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  const sourceA = randomUUID();
  const secondSourceA = randomUUID();
  const cancellationSourceA = randomUUID();
  const sourceB = randomUUID();
  let temporaryRoot = "";
  let created = false;
  let beforeDevices: unknown;
  let beforeAssignments: unknown;
  let beforeEvents: unknown;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-replacement-"));

    const throughAssignments = join(temporaryRoot, "through-assignments");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: throughAssignments,
      lastIncludedIndex: 132,
    });
    await migrate(drizzle(pool), { migrationsFolder: throughAssignments });
    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ('replacement-a','A','replacement-a',now()),('replacement-b','B','replacement-b',now())",
    );
    await pool.query(
      `INSERT INTO station_devices (id,tenant_id,name,kind,paired_at,api_key_id)
       VALUES ($1,'replacement-a','Source A','station',now(),'credential-a'),
              ($2,'replacement-a','Second source A','handheld',now(),'credential-a2'),
              ($3,'replacement-a','Cancellation source A','station',now(),'credential-a3'),
              ($4,'replacement-b','Source B','station',now(),'credential-b')`,
      [sourceA, secondSourceA, cancellationSourceA, sourceB],
    );

    const throughActorIdentity = join(temporaryRoot, "through-actor-identity");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: throughActorIdentity,
      lastIncludedIndex: 134,
    });
    await migrate(drizzle(pool), { migrationsFolder: throughActorIdentity });
    beforeDevices = (await pool.query("SELECT * FROM station_devices ORDER BY id")).rows;
    beforeAssignments = (await pool.query("SELECT * FROM working_device_assignments ORDER BY id"))
      .rows;
    beforeEvents = (await pool.query("SELECT * FROM working_device_events ORDER BY id")).rows;

    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  const insertPreview = async (input: {
    tenantId?: string;
    deviceId?: string;
    actorDomain?: string;
    actorId?: string;
    requestId?: string;
  }) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO working_device_replacement_previews
        (id,tenant_id,device_id,actor_domain,actor_id,request_id,payload,payload_hash,
         facts_fingerprint,observation,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,'{}',now(),now()+interval '5 minutes')`,
      [
        id,
        input.tenantId ?? "replacement-a",
        input.deviceId ?? sourceA,
        input.actorDomain ?? "cabinet",
        input.actorId ?? "cabinet-user-a",
        input.requestId ?? randomUUID(),
        hashA,
        hashB,
      ],
    );
    return id;
  };

  const insertPreparation = async (input: {
    previewId: string;
    tenantId?: string;
    deviceId?: string;
    actorDomain?: string;
    actorId?: string;
  }) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO working_device_replacement_preparations
        (id,tenant_id,device_id,preview_id,revision,state,actor_domain,actor_id,
         observation,facts_fingerprint,prepared_at)
       VALUES ($1,$2,$3,$4,1,'prepared',$5,$6,'{}',$7,now())`,
      [
        id,
        input.tenantId ?? "replacement-a",
        input.deviceId ?? sourceA,
        input.previewId,
        input.actorDomain ?? "cabinet",
        input.actorId ?? "cabinet-user-a",
        hashB,
      ],
    );
    return id;
  };

  it("adds empty replacement storage without changing 0134 device facts or journals", async () => {
    expect((await pool.query("SELECT * FROM station_devices ORDER BY id")).rows).toEqual(
      beforeDevices,
    );
    expect((await pool.query("SELECT * FROM working_device_assignments ORDER BY id")).rows).toEqual(
      beforeAssignments,
    );
    expect((await pool.query("SELECT * FROM working_device_events ORDER BY id")).rows).toEqual(
      beforeEvents,
    );
    expect((await pool.query("SELECT * FROM working_device_replacement_previews")).rows).toEqual(
      [],
    );
    expect(
      (await pool.query("SELECT * FROM working_device_replacement_preparations")).rows,
    ).toEqual([]);
    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect((await pool.query("SELECT * FROM station_devices ORDER BY id")).rows).toEqual(
      beforeDevices,
    );
    expect((await pool.query("SELECT * FROM working_device_assignments ORDER BY id")).rows).toEqual(
      beforeAssignments,
    );
    expect((await pool.query("SELECT * FROM working_device_events ORDER BY id")).rows).toEqual(
      beforeEvents,
    );
  });

  it("rejects cross-tenant source devices and cross-tenant preview references", async () => {
    await expect(
      insertPreview({ tenantId: "replacement-a", deviceId: sourceB }),
    ).rejects.toMatchObject({ code: "23503" });

    const previewA = await insertPreview({ deviceId: secondSourceA });
    await expect(
      insertPreparation({
        previewId: previewA,
        tenantId: "replacement-b",
        deviceId: sourceB,
        actorDomain: "platform",
        actorId: "platform-user-b",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("requires real cabinet/platform actors, valid time windows and complete confirmation results", async () => {
    await expect(insertPreview({ actorId: " " })).rejects.toMatchObject({ code: "23514" });
    await expect(insertPreview({ actorDomain: "device" })).rejects.toMatchObject({ code: "23514" });

    const previewId = await insertPreview({});
    await expect(
      pool.query("UPDATE working_device_replacement_previews SET confirmed_at=now() WHERE id=$1", [
        previewId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE working_device_replacement_previews SET expires_at=created_at WHERE id=$1",
        [previewId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO working_device_replacement_previews
          (tenant_id,device_id,actor_domain,actor_id,request_id,payload,payload_hash,
           facts_fingerprint,observation,created_at,expires_at)
         VALUES ('replacement-a',$1,'cabinet','cabinet-user-a',$2,'{}',$3,$4,'{}',
                 now(),now()+interval '5 minutes 1 millisecond')`,
        [sourceA, randomUUID(), hashA, hashB],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a prepared-to-cancelled transition without its actor domain", async () => {
    const previewId = await insertPreview({ deviceId: cancellationSourceA });
    const preparationId = await insertPreparation({
      previewId,
      deviceId: cancellationSourceA,
    });
    await expect(
      pool.query(
        `UPDATE working_device_replacement_preparations
         SET state='cancelled',revision=revision+1,cancelled_at=now(),
             cancelled_actor_domain=null,cancelled_actor_id='cabinet-user-a'
         WHERE id=$1`,
        [preparationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    {
      label: "a NULL request hash",
      action: "replacement_prepared",
      before: null,
      after: { id: randomUUID(), state: "prepared" },
      requestHash: null,
      responsePatch: {},
    },
    {
      label: "a missing receipt preparation ID",
      action: "replacement_prepared",
      before: null,
      after: { id: randomUUID(), state: "prepared" },
      requestHash: hashA,
      responsePatch: { omitPreparationId: true },
    },
    {
      label: "a missing receipt preparation state",
      action: "replacement_prepared",
      before: null,
      after: { id: randomUUID(), state: "prepared" },
      requestHash: hashA,
      responsePatch: { omitPreparationState: true },
    },
    {
      label: "a missing cancellation before-state",
      action: "replacement_cancelled",
      before: null,
      after: { id: randomUUID(), state: "cancelled" },
      requestHash: hashA,
      responsePatch: {},
    },
  ])("rejects replacement journal rows with $label", async (fixture) => {
    const requestId = randomUUID();
    const preparation = {
      ...(!fixture.responsePatch.omitPreparationId && { id: fixture.after.id }),
      ...(!fixture.responsePatch.omitPreparationState && { state: fixture.after.state }),
    };
    await expect(
      pool.query(
        `INSERT INTO working_device_events
          (tenant_id,device_id,actor_domain,actor_id,action,before,"after",request_id,request_hash,response)
         VALUES ('replacement-a',$1,'cabinet','cabinet-user-a',$2,$3,$4,$5,$6,$7)`,
        [
          sourceA,
          fixture.action,
          fixture.before,
          fixture.after,
          requestId,
          fixture.requestHash,
          { requestId, preparation },
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects duplicate prepared replacements and retains cancelled history before recreate", async () => {
    const firstPreview = await insertPreview({});
    const firstPreparation = await insertPreparation({ previewId: firstPreview });
    const secondPreview = await insertPreview({});
    await expect(insertPreparation({ previewId: secondPreview })).rejects.toMatchObject({
      code: "23505",
    });

    await pool.query(
      `UPDATE working_device_replacement_preparations
       SET state='cancelled',revision=revision+1,cancelled_at=now(),
           cancelled_actor_domain='cabinet',cancelled_actor_id='cabinet-user-a'
       WHERE id=$1`,
      [firstPreparation],
    );
    const secondPreparation = await insertPreparation({ previewId: secondPreview });
    expect(secondPreparation).not.toBe(firstPreparation);
    expect(
      (
        await pool.query(
          `SELECT id,state,revision,cancelled_actor_domain,cancelled_actor_id
           FROM working_device_replacement_preparations
           WHERE tenant_id='replacement-a' AND device_id=$1 ORDER BY prepared_at,id`,
          [sourceA],
        )
      ).rows,
    ).toEqual([
      {
        id: firstPreparation,
        state: "cancelled",
        revision: 2,
        cancelled_actor_domain: "cabinet",
        cancelled_actor_id: "cabinet-user-a",
      },
      {
        id: secondPreparation,
        state: "prepared",
        revision: 1,
        cancelled_actor_domain: null,
        cancelled_actor_id: null,
      },
    ]);
    await expect(
      pool.query(
        "UPDATE working_device_replacement_preparations SET actor_id='rewritten' WHERE id=$1",
        [firstPreparation],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("preserves exact confirmation and cancellation receipts in immutable journal rows", async () => {
    const mismatchedPreviewId = await insertPreview({
      tenantId: "replacement-b",
      deviceId: sourceB,
      actorDomain: "platform",
      actorId: "platform-user-b",
    });
    const mismatchedPreparationId = await insertPreparation({
      previewId: mismatchedPreviewId,
      tenantId: "replacement-b",
      deviceId: sourceB,
      actorDomain: "platform",
      actorId: "platform-user-b",
    });
    await expect(
      pool.query(
        `UPDATE working_device_replacement_previews
         SET confirmed_at=now(),result_preparation_id=$2,response=$3
         WHERE id=$1`,
        [
          mismatchedPreviewId,
          mismatchedPreparationId,
          { requestId: randomUUID(), preparation: { id: mismatchedPreparationId } },
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const confirmRequestId = randomUUID();
    const previewId = await insertPreview({ deviceId: secondSourceA, requestId: confirmRequestId });
    const preparationId = await insertPreparation({
      previewId,
      deviceId: secondSourceA,
    });
    const prepared = { id: preparationId, state: "prepared" };
    const preparedReceipt = {
      requestId: confirmRequestId,
      preparation: prepared,
    };

    await expect(
      pool.query(
        `INSERT INTO working_device_events
          (tenant_id,device_id,actor_domain,actor_id,action,before,"after",request_id,request_hash,response)
         VALUES ('replacement-a',$1,'cabinet','cabinet-user-a','replacement_prepared',null,$2,$3,$4,null)`,
        [secondSourceA, prepared, confirmRequestId, hashA],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const preparedEventId = (
      await pool.query<{ id: string }>(
        `INSERT INTO working_device_events
          (tenant_id,device_id,actor_domain,actor_id,action,before,"after",request_id,request_hash,response)
         VALUES ('replacement-a',$1,'cabinet','cabinet-user-a','replacement_prepared',null,$2,$3,$4,$5)
         RETURNING id`,
        [secondSourceA, prepared, confirmRequestId, hashA, preparedReceipt],
      )
    ).rows[0]?.id;
    expect(preparedEventId).toBeDefined();

    await pool.query(
      `UPDATE working_device_replacement_previews
       SET confirmed_at=now(),result_preparation_id=$2,response=$3
       WHERE id=$1`,
      [previewId, preparationId, preparedReceipt],
    );
    await expect(
      pool.query("UPDATE working_device_replacement_previews SET response='{}' WHERE id=$1", [
        previewId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE working_device_events SET response='{}' WHERE id=$1", [preparedEventId]),
    ).rejects.toMatchObject({ code: "23514" });

    const cancelRequestId = randomUUID();
    const cancelled = { id: preparationId, state: "cancelled" };
    const cancelledReceipt = { requestId: cancelRequestId, preparation: cancelled };
    await pool.query(
      `UPDATE working_device_replacement_preparations
       SET state='cancelled',revision=revision+1,cancelled_at=now(),
           cancelled_actor_domain='platform',cancelled_actor_id='platform-user-a'
       WHERE id=$1`,
      [preparationId],
    );
    await pool.query(
      `INSERT INTO working_device_events
        (tenant_id,device_id,actor_domain,actor_id,action,before,"after",request_id,request_hash,response)
       VALUES ('replacement-a',$1,'platform','platform-user-a','replacement_cancelled',$2,$3,$4,$5,$6)`,
      [secondSourceA, prepared, cancelled, cancelRequestId, hashB, cancelledReceipt],
    );
    expect(
      (
        await pool.query(
          `SELECT action,response FROM working_device_events
           WHERE action IN ('replacement_prepared','replacement_cancelled') ORDER BY created_at,id`,
        )
      ).rows,
    ).toEqual([
      { action: "replacement_prepared", response: preparedReceipt },
      { action: "replacement_cancelled", response: cancelledReceipt },
    ]);
    expect(
      (
        await pool.query("SELECT response FROM working_device_replacement_previews WHERE id=$1", [
          previewId,
        ])
      ).rows,
    ).toEqual([{ response: preparedReceipt }]);
    expect(
      (
        await pool.query("SELECT response FROM working_device_events WHERE id=$1", [
          preparedEventId,
        ])
      ).rows,
    ).toEqual([{ response: preparedReceipt }]);
  });
});
