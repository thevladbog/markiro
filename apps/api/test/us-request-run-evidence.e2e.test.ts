import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  parseUsRequestFrozenRun,
  verifyUsRequestRunEvidence,
  type UsRequestFrozenRun,
  type UsTraceExportRunRow,
} from "../src/modules/traceability/requests/us-request-run-evidence";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  finalizeUsRequestPayloadReceiving,
  seedUsRequestPayloadPlan,
} from "./support/us-request-payload-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const build = { apiVersion: "test-us09-payload", gitSha: "a".repeat(40), dirty: false } as const;

describe.skipIf(!url)("shared US frozen-run evidence in disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    f = await createUsProfileTestDatabase(url);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });
  const prepare = async (
    empty = true,
    mode: "available_records_incomplete" | "export_ready" = "available_records_incomplete",
  ) => {
    const request = await new UsRequestStore(f.db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic payload requester",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope: empty ? { tlcs: ["NO-MATCH-PAYLOAD-FIXTURE"] } : { lotId: c.lot },
    });
    await new UsRequestValidationStore(f.db).validate(c.tenant, c.actor, request.id, build);
    return new UsRequestPrepareStore(f.db).prepare(
      c.tenant,
      c.actor,
      request.id,
      { mode, idempotencyKey: randomUUID() },
      build,
    );
  };
  const persisted = async () => ({
    runs: await f.db
      .select()
      .from(schema.traceExportRuns)
      .where(eq(schema.traceExportRuns.tenantId, c.tenant)),
    audits: await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
  });
  const invalid = (run: UsTraceExportRunRow) => {
    expect(() => verifyUsRequestRunEvidence(run, c.tenant)).toThrow(
      expect.objectContaining({
        status: 503,
        response: { code: "us_request_run_stored_invalid" },
      }),
    );
  };
  const changed = (run: UsTraceExportRunRow, edit: (frozen: UsRequestFrozenRun) => void) => {
    const frozen = structuredClone(verifyUsRequestRunEvidence(run, c.tenant));
    edit(frozen);
    return {
      ...run,
      inputSnapshot: frozen,
      scopedContentDigest: canonicalExportDigest(frozen.validationSnapshot),
      inputDigest: frozen.exportInput === null ? null : canonicalExportDigest(frozen.exportInput),
    };
  };

  it("returns the real empty envelope and denies another tenant without writing rows or audits", async () => {
    const run = await prepare();
    const before = await persisted();
    expect(verifyUsRequestRunEvidence(run, c.tenant)).toMatchObject({
      selectionKind: "empty",
      exportInput: null,
      preparedBy: c.actor,
    });
    expect(() => verifyUsRequestRunEvidence(run, randomUUID())).toThrow();
    expect(await persisted()).toEqual(before);
  });

  it("returns real nonempty Receiving input without writing rows or audits", async () => {
    const origin = await finalizeUsRequestPayloadReceiving(f.db, c);
    const run = await prepare(false);
    const before = await persisted();
    expect(verifyUsRequestRunEvidence(run, c.tenant)).toMatchObject({
      selectionKind: "events",
      exportInput: {
        events: [{ eventId: origin.id, revision: 1, type: "receiving" }],
      },
      preparedBy: c.actor,
    });
    expect(await persisted()).toEqual(before);
  });

  it("allows worker lifecycle changes without changing frozen content or persisted rows", async () => {
    const run = await prepare();
    const before = await persisted();
    const later = {
      ...run,
      status: "failed",
      attemptCount: 2,
      failureCode: "synthetic_failure",
      generationStartedAt: new Date("2026-10-05T00:00:00Z"),
      reportRenderedAt: new Date("2026-10-05T00:01:00Z"),
      completedAt: new Date("2026-10-05T00:02:00Z"),
    };
    expect(verifyUsRequestRunEvidence(later, c.tenant)).toEqual(
      verifyUsRequestRunEvidence(run, c.tenant),
    );
    expect(await persisted()).toEqual(before);
  });

  it.each([
    ["malformed saved JSON", (r: UsTraceExportRunRow) => ({ ...r, inputSnapshot: null })],
    [
      "saved extra key",
      (r: UsTraceExportRunRow) => ({
        ...r,
        inputSnapshot: { ...verifyUsRequestRunEvidence(r, c.tenant), unexpected: true },
      }),
    ],
    ["row tenant", (r: UsTraceExportRunRow) => ({ ...r, tenantId: randomUUID() })],
    ["row creator", (r: UsTraceExportRunRow) => ({ ...r, createdBy: randomUUID() })],
    ["request binding", (r: UsTraceExportRunRow) => ({ ...r, requestId: randomUUID() })],
    ["mode binding", (r: UsTraceExportRunRow) => ({ ...r, mode: "export_ready" })],
    [
      "generation instant",
      (r: UsTraceExportRunRow) => ({ ...r, startedAt: new Date("2020-01-01T00:00:00Z") }),
    ],
    ["Plan identity", (r: UsTraceExportRunRow) => ({ ...r, planVersionId: randomUUID() })],
    ["Plan hash", (r: UsTraceExportRunRow) => ({ ...r, planPdfSha256: "0".repeat(64) })],
    ["registry version", (r: UsTraceExportRunRow) => ({ ...r, registryVersion: 2 })],
    ["registry hash", (r: UsTraceExportRunRow) => ({ ...r, registryHash: "0".repeat(64) })],
    ["scoped digest", (r: UsTraceExportRunRow) => ({ ...r, scopedContentDigest: "0".repeat(64) })],
    ["command digest", (r: UsTraceExportRunRow) => ({ ...r, commandDigest: "0".repeat(64) })],
    ["empty input digest", (r: UsTraceExportRunRow) => ({ ...r, inputDigest: "0".repeat(64) })],
  ])("rejects %s with a sanitized error and preserves rows and audits", async (_name, mutate) => {
    const run = await prepare();
    const before = await persisted();
    invalid(mutate(run));
    expect(await persisted()).toEqual(before);
  });

  it.each([
    [
      "frozen preparer",
      (frozen: UsRequestFrozenRun) => {
        frozen.preparedBy = randomUUID();
      },
    ],
    [
      "normalization-only text",
      (frozen: UsRequestFrozenRun) => {
        frozen.validationSnapshot.request.requesterName += " ";
      },
    ],
    [
      "selection/source identities",
      (frozen: UsRequestFrozenRun) => {
        frozen.validationSnapshot.selection.records = [
          { eventId: randomUUID(), revision: 1, reason: "match", rootEventId: randomUUID() },
        ];
      },
    ],
    [
      "warning acknowledgement digest",
      (frozen: UsRequestFrozenRun) => {
        frozen.warningAcknowledgement = {
          digest: "0".repeat(64),
          reason: "Synthetic reason",
          actorId: c.actor,
          acknowledgedAt: "2026-10-04T00:00:00.000Z",
        };
      },
    ],
    [
      "empty selection kind",
      (frozen: UsRequestFrozenRun) => {
        frozen.selectionKind = "events";
      },
    ],
  ])(
    "rejects rehashed %s without allowing parser normalization to hide changes",
    async (_name, edit) => {
      const run = await prepare();
      const before = await persisted();
      invalid(changed(run, edit));
      expect(await persisted()).toEqual(before);
    },
  );

  it("accepts object-key reordering and returns a parsed envelope without mutating its input", async () => {
    const run = await prepare();
    const frozen = verifyUsRequestRunEvidence(run, c.tenant);
    const reversed = {
      ...run,
      inputSnapshot: Object.fromEntries(Object.entries(frozen).reverse()),
    };
    const before = structuredClone(reversed);
    expect(verifyUsRequestRunEvidence(reversed, c.tenant)).toEqual(frozen);
    expect(reversed).toEqual(before);
  });

  it("keeps shape parsing distinct from tenant/digest evidence verification", async () => {
    const run = await prepare();
    const changedRun = changed(run, (frozen) => {
      frozen.preparedBy = randomUUID();
    });
    expect(parseUsRequestFrozenRun(changedRun.inputSnapshot)).toMatchObject({
      selectionKind: "empty",
    });
    expect(parseUsRequestFrozenRun({ schemaVersion: 2 })).toBeNull();
    invalid(changedRun);
  });

  it("rejects nonempty input digest, source-set, content, metadata and null inconsistencies even after rehash", async () => {
    await finalizeUsRequestPayloadReceiving(f.db, c);
    const run = await prepare(false);
    const before = await persisted();
    invalid({ ...run, inputDigest: "0".repeat(64) });
    const edits: Array<(frozen: UsRequestFrozenRun) => void> = [
      (frozen) => {
        frozen.selectionKind = "empty";
        frozen.exportInput = null;
      },
      (frozen) => {
        frozen.validationSnapshot.selection.records = [];
      },
      (frozen) => {
        const source = frozen.validationSnapshot.sources[0];
        if (!source) throw new Error("Missing real Receiving source");
        frozen.validationSnapshot.sources.push(source);
        frozen.validationSnapshot.selection.records.push(
          ...frozen.validationSnapshot.selection.records,
        );
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        const source = frozen.exportInput.events[0];
        if (!source) throw new Error("Missing real Receiving source");
        source.eventId = randomUUID();
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        frozen.exportInput.tenantId = randomUUID();
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        frozen.exportInput.metadata.generatedAt = "2020-01-01T00:00:00.000Z";
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        frozen.exportInput.metadata.scopeLabel = "Changed reference";
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        frozen.exportInput.metadata.timeZone = "America/New_York";
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        frozen.exportInput.metadata.baselineId = "Changed baseline";
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        frozen.exportInput.metadata.build.gitSha = "b".repeat(40);
      },
      (frozen) => {
        if (!frozen.exportInput) throw new Error("Missing real export input");
        const source = frozen.exportInput.events[0];
        if (source?.type !== "receiving" || source.payload.kind !== "frozen")
          throw new Error("Missing real frozen Receiving source");
        source.payload.snapshot.items.reverse();
      },
    ];
    for (const edit of edits) invalid(changed(run, edit));
    expect(await persisted()).toEqual(before);
  });

  it("binds ready input to the current chain using frozen relation seeds", async () => {
    const origin = await finalizeUsRequestPayloadReceiving(f.db, c);
    await seedUsRequestPayloadPlan(f.db, c);
    const run = await prepare(false, "export_ready");
    const before = await persisted();
    expect(verifyUsRequestRunEvidence(run, c.tenant)).toMatchObject({
      exportInput: { events: [{ eventId: origin.id }] },
    });
    invalid(
      changed(run, (frozen) => {
        frozen.validationSnapshot.selection.seeds = [{ kind: "lot", id: randomUUID() }];
      }),
    );
    expect(await persisted()).toEqual(before);
  });
});
