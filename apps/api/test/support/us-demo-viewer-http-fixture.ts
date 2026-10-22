import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import type { ShippingDraft, TransformationDraft } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { createUsDevelopmentApplication } from "../../src/deployment/us-bootstrap";
import { UsDevelopmentOwnerStore } from "../../src/deployment/us-development-owner";
import { UsDevelopmentViewerStore } from "../../src/deployment/us-development-viewer";
import { UsProfileStore } from "../../src/modules/traceability/profile/us-profile-store";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./us-profile-database";
import { currentUsTotp, UsAuthTestClient } from "./us-auth-client";
import { listenOnLoopback } from "./listen-loopback";
import { localBuildEnv } from "./us-request-build-fixture";
import {
  emptyReceivingDraft,
  seedCompleteReceiving,
  seedReceivingTenant,
} from "./us-receiving-fixture";
import { UsTransformationStore } from "../../src/modules/traceability/transformation/us-transformation-store";
import { UsShippingStore } from "../../src/modules/traceability/shipping/us-shipping-store";
import { UsPlanStore } from "../../src/modules/traceability/plans/us-plan-store";
import { UsRequestStore } from "../../src/modules/traceability/requests/us-request-store";
import { UsCaseStore } from "../../src/modules/traceability/cases/us-case-store";
import { UsRequestValidationStore } from "../../src/modules/traceability/requests/us-request-validation";
import { UsRequestPrepareStore } from "../../src/modules/traceability/requests/us-request-prepare";
import { finalizeUsRequestPayloadReceiving } from "./us-request-payload-fixture";
import { bindUsRequestWorkerFixture, prepareUsWorkerSource } from "./us-request-worker-fixture";
import { storageEnvironment } from "./us-request-worker-storage-fixture";

export const viewerHttpDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const authTables = [
  "user",
  "account",
  "session",
  "verification",
  "us_two_factors",
  "us_session_assurances",
];
type TableSnapshot = Record<string, { count: number; sha256: string }>;
interface ViewerHttpAuth {
  client: UsAuthTestClient;
  signIn(): Promise<Response>;
  enroll(): Promise<void>;
  verify(): Promise<Response>;
  trustDevice(): Promise<Response>;
  replaceFactor(): Promise<Response>;
  select(tenantId?: string): Promise<Response>;
  signOut(): Promise<Response>;
}
export interface UsDemoViewerHttpFixture {
  app: INestApplication;
  database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  ownerUserId: string;
  viewerUserId: string;
  tenantId: string;
  context: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  receiving: Awaited<ReturnType<typeof finalizeUsRequestPayloadReceiving>>;
  corrected: Awaited<ReturnType<UsReceivingStore["finalizeRevision"]>>;
  receivingDraft: Awaited<ReturnType<UsReceivingStore["createDraft"]>>;
  finalizedTransformation: Awaited<ReturnType<UsTransformationStore["finalize"]>>;
  transformation: Awaited<ReturnType<UsTransformationStore["createDraft"]>>;
  shipping: Awaited<ReturnType<UsShippingStore["createDraft"]>>;
  transformationDraft: TransformationDraft;
  shippingDraft: ShippingDraft;
  foreign: Awaited<ReturnType<typeof seedReceivingTenant>>;
  foreignPlan: Awaited<ReturnType<UsPlanStore["createDraft"]>>;
  foreignRequest: Awaited<ReturnType<UsRequestStore["create"]>>;
  foreignRunId: string;
  draftPlan: Awaited<ReturnType<UsPlanStore["createDraft"]>>;
  plan: { id: string; pdf_sha256: string; pdf_byte_size: number };
  source: Awaited<ReturnType<typeof prepareUsWorkerSource>>;
  artifacts: readonly (typeof schema.traceExportArtifacts.$inferSelect)[];
  outputLotId: string;
  boxId: string;
  sscc: string;
  caseLinks: Awaited<ReturnType<UsCaseStore["link"]>>;
  viewer: ViewerHttpAuth;
  owner: ViewerHttpAuth;
  transport(input: Request): Promise<Response>;
  close(): Promise<void>;
  serverUrl: string;
  request(
    path: string,
    method?: string,
    body?: unknown,
    client?: UsAuthTestClient | null,
    extra?: HeadersInit,
  ): Promise<Response>;
  businessSnapshot(): Promise<TableSnapshot>;
  authSnapshot(): Promise<Record<string, { count: number; sha256: string } | undefined>>;
  identitySnapshot(): Promise<{ otherUsers: string; viewerCore: string; credentials: string }>;
  auditSnapshot(): Promise<(typeof schema.tenantAuditEvents.$inferSelect)[]>;
  privateSnapshot(): {
    plans: { key: string; sha256: string }[];
    packages: { key: string; sha256: string }[];
  };
  providerSnapshot(): {
    active: number;
    failures: number;
    package: ("put" | "get" | "head" | "delete")[];
    plan: string[];
    openStreams: number;
  };
  artifactBytes(kind: string): Buffer;
  planBytes(): Buffer;
}

const acquisitionPhases = [
  "url",
  "inventory-pool",
  "base-identity",
  "catalog-baseline",
  "child-acquire",
  "child-identity",
  "owner-provision",
  "profile-provision",
  "viewer-provision",
  "native-data",
  "application-create",
  "application-init",
  "listener",
] as const;
type AcquisitionPhase = (typeof acquisitionPhases)[number];
const cleanupPhases = [
  "application",
  "private-stores",
  "child-database",
  "child-absence",
  "catalog",
  "listener",
  "inventory-pool",
] as const;
type CleanupPhase = (typeof cleanupPhases)[number];

/** Finite diagnostic projection: never accepts or retains an underlying exception. */
export function usViewerHttpFixtureFailure(phase: unknown, cleanupFailed = false): Error {
  const known =
    typeof phase === "string" && acquisitionPhases.some((entry) => entry === phase)
      ? phase
      : "unknown";
  return new Error(
    `Viewer HTTP fixture acquisition failed: ${known}${cleanupFailed ? "; cleanup failed" : ""}`,
  );
}

/** Shared failure-only disposal boundary; callbacks cannot grant identity/session success. */
export async function disposeUsViewerHttpFixtureResources(
  stages: readonly { phase: CleanupPhase; dispose(): void | Promise<void> }[],
): Promise<void> {
  const failures: Error[] = [];
  for (const stage of stages) {
    try {
      await stage.dispose();
    } catch {
      const known = cleanupPhases.some((phase) => phase === stage.phase) ? stage.phase : "unknown";
      failures.push(new Error(`Viewer HTTP fixture cleanup failed: ${known}`));
    }
  }
  if (failures.length) throw new AggregateError(failures, "Viewer HTTP fixture cleanup failed");
}

/** Actual owned DB and loopback app; only private object IO is fixture-owned. */
export async function startUsDemoViewerHttpFixture(
  rawUrl: string,
): Promise<UsDemoViewerHttpFixture> {
  let input: URL;
  try {
    input = new URL(rawUrl);
  } catch {
    throw usViewerHttpFixtureFailure("url");
  }
  if (
    input.protocol !== "postgres:" ||
    !["127.0.0.1", "localhost"].includes(input.hostname) ||
    input.port !== "55432" ||
    input.pathname !== "/markiro_us_dev" ||
    input.username !== "markiro_us" ||
    input.search ||
    input.hash
  )
    throw new Error("Viewer HTTP tests require the isolated loopback database");
  let admin: ReturnType<typeof createDb>;
  try {
    admin = createDb(rawUrl, { connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  } catch {
    throw usViewerHttpFixtureFailure("inventory-pool");
  }
  let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>> | undefined;
  let app: INestApplication | undefined;
  let published: ReturnType<typeof bindUsRequestWorkerFixture> | undefined;
  let closing: Promise<void> | undefined;
  let phase: AcquisitionPhase = "base-identity";
  let ownedName = "";
  const providerOperations = { active: 0, failures: 0 };
  async function providerOperation<T>(operation: () => Promise<T>): Promise<T> {
    providerOperations.active += 1;
    try {
      return await operation();
    } catch {
      providerOperations.failures += 1;
      throw new Error("Owned private byte transport failed");
    } finally {
      providerOperations.active -= 1;
    }
  }
  const catalog = async () =>
    (
      await admin.pool.query<{ datname: string }>(
        "SELECT datname FROM pg_database ORDER BY datname",
      )
    ).rows.map((row) => row.datname);
  let beforeCatalog: string[] = [];
  function close(): Promise<void> {
    closing ??= disposeUsViewerHttpFixtureResources([
      {
        phase: "application",
        dispose: async () => {
          await app?.close();
        },
      },
      { phase: "private-stores", dispose: () => published?.destroy() },
      {
        phase: "child-database",
        dispose: async () => {
          await database?.close();
        },
      },
      {
        phase: "child-absence",
        dispose: async () => {
          if (ownedName && (await catalog()).includes(ownedName))
            throw new Error("Owned viewer DB remains");
        },
      },
      {
        phase: "catalog",
        dispose: async () => {
          if (
            beforeCatalog.length &&
            viewerHttpDigest(await catalog()) !== viewerHttpDigest(beforeCatalog)
          )
            throw new Error("Owned DB catalog changed");
        },
      },
      {
        phase: "listener",
        dispose: () => {
          if (app?.getHttpServer().listening) throw new Error("Owned listener remains open");
        },
      },
      { phase: "inventory-pool", dispose: () => admin.pool.end() },
    ]).then(() => {
      if (ownedName)
        console.info(`[viewer-http-owned-db] normal DROP/catalog absence ${ownedName}`);
    });
    return closing;
  }
  try {
    const identity = await admin.pool.query<{
      name: string;
      owner: string;
      database_owner: string;
      rolcreatedb: boolean;
    }>(
      "SELECT current_database() AS name, current_user AS owner, pg_get_userbyid(d.datdba) AS database_owner, r.rolcreatedb FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()",
    );
    const row = identity.rows[0];
    if (
      row?.name !== "markiro_us_dev" ||
      row.owner !== "markiro_us" ||
      row.database_owner !== "markiro_us" ||
      !row.rolcreatedb
    )
      throw new Error("Isolated viewer DB prerequisite identity mismatch");
    phase = "catalog-baseline";
    beforeCatalog = await catalog();
    phase = "child-acquire";
    database = await createUsProfileTestDatabase(rawUrl);
    phase = "child-identity";
    ownedName =
      (await database.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
        ?.name ?? "";
    if (!/^markiro_us_profile_[a-f0-9_]{36}$/.test(ownedName))
      throw new Error("Unexpected owned viewer database identity");
    console.info(
      `[viewer-http-owned-db] migrated ${ownedName}; base identity verified; catalog before ${beforeCatalog.length}`,
    );
    const db = database.db;
    const ownedDatabase = database;
    const ownerPassword = `Synthetic-owner-${randomUUID()}!`;
    const viewerPassword = `Synthetic-viewer-${randomUUID()}!`;
    phase = "owner-provision";
    const owner = await new UsDevelopmentOwnerStore(db).provision(ownerPassword, randomUUID());
    phase = "profile-provision";
    await new UsProfileStore(db).provision(
      owner.tenantId,
      owner.userId,
      { code: "US_FSMA204_PROCESSOR", retentionYears: 2, timeZone: "America/Los_Angeles" },
      randomUUID(),
    );
    phase = "viewer-provision";
    const { viewerUserId } = await new UsDevelopmentViewerStore(db).provision(
      { tenantId: owner.tenantId, originalOwnerId: owner.userId, requestId: randomUUID() },
      viewerPassword,
    );
    phase = "native-data";
    const [ownerMember] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, owner.userId));
    const isUuid = (value: string): value is ReturnType<typeof randomUUID> =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
    if (!isUuid(owner.tenantId) || !isUuid(owner.userId) || !ownerMember || !isUuid(ownerMember.id))
      throw new Error("Trusted fixture owner UUID or membership missing");
    const c = {
      tenant: owner.tenantId,
      actor: owner.userId,
      member: ownerMember.id,
      party: randomUUID(),
      location: randomUUID(),
      product: randomUUID(),
      lot: randomUUID(),
      document: randomUUID(),
    };
    await db
      .insert(schema.traceabilityParties)
      .values({ id: c.party, tenantId: c.tenant, name: "Synthetic supplier" });
    await db.insert(schema.traceabilityLocations).values({
      id: c.location,
      tenantId: c.tenant,
      partyId: c.party,
      name: "Dock",
      businessName: "Synthetic supplier",
    });
    await db
      .insert(schema.products)
      .values({ id: c.product, tenantId: c.tenant, name: "Synthetic apples" });
    await db.insert(schema.traceabilityLots).values({
      id: c.lot,
      tenantId: c.tenant,
      productId: c.product,
      tlc: "00001",
      assignmentBasis: "imported",
      createdBy: c.actor,
      updatedBy: c.actor,
    });
    await db.insert(schema.referenceDocuments).values({
      id: c.document,
      tenantId: c.tenant,
      type: "bol",
      number: "00001",
      partyId: c.party,
      createdBy: c.actor,
    });
    const context = await seedCompleteReceiving(db, c);
    const receiving = await finalizeUsRequestPayloadReceiving(db, context);
    const receivings = new UsReceivingStore(db);
    const originalLive = await receivings.getLiveRecord(c.tenant, c.actor, receiving.id);
    const amended = await receivings.amend(
      c.tenant,
      c.actor,
      receiving.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: originalLive.lifecycle.lifecycleVersion,
        reason: "Correct synthetic office note",
      },
      randomUUID(),
    );
    if (amended.record.content.kind !== "draft") throw new Error("Native amendment draft missing");
    const savedAmendment = await receivings.saveAmendment(
      c.tenant,
      c.actor,
      amended.record.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: amended.record.lifecycle.lifecycleVersion,
        expectedDraftVersion: amended.record.draftVersion,
        draft: { ...amended.record.content.draft, notes: "Corrected compact HTTP fixture note" },
      },
      randomUUID(),
    );
    const correctionReady = await receivings.checkRevisionReadiness(
      c.tenant,
      c.actor,
      amended.record.id,
      { expectedDraftVersion: String(savedAmendment.record.draftVersion) },
    );
    const corrected = await receivings.finalizeRevision(
      c.tenant,
      c.actor,
      amended.record.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: correctionReady.expectedLifecycleVersion,
        expectedDraftVersion: savedAmendment.record.draftVersion,
        previousRevisionId: correctionReady.previousRevisionId,
        expectedInputDigest: correctionReady.inputDigest,
        reviewedExemptLines: correctionReady.exemptReviewRequiredLines,
      },
      randomUUID(),
    );
    const receivingDraft = await new UsReceivingStore(db).createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: emptyReceivingDraft },
      randomUUID(),
    );
    const transformationDraft = {
      eventDate: null,
      processorLocationId: null,
      reason: null,
      reasonNote: null,
      notes: null,
      inputs: [],
      outputs: [],
      documentIds: [],
    };
    const shippingDraft = {
      eventDate: null,
      shipFromLocationId: null,
      recipientLocationId: null,
      carrierReference: null,
      notes: null,
      items: [],
      documentIds: [],
    };
    const transformation = await new UsTransformationStore(db).createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: transformationDraft },
      randomUUID(),
    );
    await db
      .update(schema.traceabilityLocations)
      .set({ roles: ["processor", "receive_at", "tlc_source"] })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await db
      .update(schema.productTraceabilityProfiles)
      .set({
        coverageStatus: "covered",
        ftlCategory: "Fresh-cut fruits",
        ftlSourceUrl:
          "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
        ftlSourceVersion: "Synthetic HTTP fixture",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const transformations = new UsTransformationStore(db);
    const savedTransformation = await transformations.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: "2026-09-08",
          processorLocationId: c.location,
          reason: "processing",
          reasonNote: "Synthetic compact HTTP fixture",
          notes: null,
          inputs: [{ kind: "ftl_lot", lotId: c.lot, quantity: "0.250", unitOfMeasure: "kg" }],
          outputs: [
            {
              productId: c.product,
              tlc: "HTTP-OUTPUT-001",
              quantity: "0.100",
              unitOfMeasure: "kg",
            },
          ],
          documentIds: [c.document],
        },
      },
      randomUUID(),
    );
    const transformationReady = await transformations.checkReadiness(
      c.tenant,
      c.actor,
      savedTransformation.id,
      { expectedDraftVersion: 1 },
    );
    const finalizedTransformation = await transformations.finalize(
      c.tenant,
      c.actor,
      savedTransformation.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: transformationReady.inputDigest,
      },
      randomUUID(),
    );
    const outputLotId = finalizedTransformation.snapshot.outputs[0]?.lotId;
    if (!outputLotId) throw new Error("Native transformation output missing");
    const shiftId = randomUUID(),
      boxId = randomUUID(),
      sscc = "012345670000000015";
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId: c.tenant,
      productId: c.product,
      mode: "aggregation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
    });
    await db
      .insert(schema.boxes)
      .values({ id: boxId, tenantId: c.tenant, shiftId, deviceBoxId: "owned-http-fixture", sscc });
    const caseLinks = await new UsCaseStore(db).link(
      c.tenant,
      c.actor,
      outputLotId,
      { operationKey: randomUUID(), ssccs: [sscc] },
      randomUUID(),
    );
    const shipping = await new UsShippingStore(db).createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: shippingDraft },
      randomUUID(),
    );
    // A generic foreign tenant is solely negative-test data, never trusted seed provenance.
    const foreign = await seedReceivingTenant(db);
    const foreignRequest = await new UsRequestStore(db).create(foreign.tenant, foreign.actor, {
      requestNumber: "foreign",
      requesterName: "Foreign",
      requesterOrganization: null,
      requesterContact: null,
      receivedAt: "2026-10-04T00:00:00Z",
      scope: { lotId: foreign.lot },
    });
    const source = await prepareUsWorkerSource(db, c, "available_records_incomplete", {
      lotId: c.lot,
    });
    const sections = (await db.select().from(schema.traceabilityPlanVersions))[0]?.sections;
    const foreignPlan = await new UsPlanStore(db).createDraft(
      foreign.tenant,
      foreign.actor,
      { sections, changeSummary: "Foreign draft" },
      randomUUID(),
    );
    const draftPlan = await new UsPlanStore(db).createDraft(
      c.tenant,
      c.actor,
      { sections, changeSummary: "Next draft" },
      randomUUID(),
    );
    published = bindUsRequestWorkerFixture(db, source);
    await published.worker.runOne();
    const { state } = await published.verifyReady();
    const foreignBuild = { apiVersion: "test-us09-package", gitSha: "a".repeat(40), dirty: false };
    await new UsRequestValidationStore(db).validate(
      foreign.tenant,
      foreign.actor,
      foreignRequest.id,
      foreignBuild,
    );
    const foreignRun = await new UsRequestPrepareStore(db).prepare(
      foreign.tenant,
      foreign.actor,
      foreignRequest.id,
      { mode: "available_records_incomplete", idempotencyKey: randomUUID() },
      foreignBuild,
    );
    const planRows = await database.pool.query<{
      id: string;
      pdf_sha256: string;
      pdf_byte_size: number;
    }>(
      "SELECT id,pdf_sha256,pdf_byte_size FROM traceability_plan_versions WHERE tenant_id=$1 AND status='effective'",
      [c.tenant],
    );
    const plan = planRows.rows[0];
    if (!plan) throw new Error("Native Plan publication missing");
    const target = new URL(rawUrl);
    target.pathname = `/${ownedName}`;
    const env = {
      ...(await localBuildEnv()),
      ...storageEnvironment(),
      US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
      US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
      US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-request-plan-test",
      US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic",
      US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic",
      US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    };
    const ownedPublished = published;
    phase = "application-create";
    app = await createUsDevelopmentApplication(
      env,
      (_url, options) => createDb(target.toString(), options),
      { send: (...args) => providerOperation(() => source.planFixture.transport.send(...args)) },
      {
        packageTransport: {
          send: (...args) =>
            providerOperation(() => ownedPublished.storage.transport.send(...args)),
        },
      },
    );
    phase = "application-init";
    await app.init();
    phase = "listener";
    await listenOnLoopback(app);
    const serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const transport = async (input: Request): Promise<Response> => {
      const body = await input.text();
      return new Promise((resolve, reject) => {
        let completed: Response | undefined;
        let failure: Error | undefined;
        const headers = new Headers(input.headers);
        headers.set("host", "localhost:3100");
        headers.set("content-length", String(Buffer.byteLength(body)));
        const url = new URL(input.url);
        const request = httpRequest(
          `${serverUrl}${url.pathname}${url.search}`,
          { method: input.method, headers: Object.fromEntries(headers), agent: false },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("error", () => {
              failure = new Error("Owned HTTP response failed");
              request.destroy();
            });
            response.on("aborted", () => {
              failure = new Error("Owned HTTP response aborted");
              request.destroy();
            });
            response.on("end", () => {
              const resultHeaders = new Headers();
              for (const [key, value] of Object.entries(response.headers)) {
                if (Array.isArray(value))
                  for (const entry of value) resultHeaders.append(key, entry);
                else if (value !== undefined) resultHeaders.set(key, value);
              }
              completed = new Response(
                response.statusCode === 204 || input.method === "HEAD"
                  ? null
                  : Buffer.concat(chunks),
                { status: response.statusCode ?? 500, headers: resultHeaders },
              );
            });
          },
        );
        const deadline = setTimeout(() => {
          failure = new Error("Owned HTTP request/drain exceeded 5000ms");
          request.destroy();
        }, 5000);
        request.on("error", () => {
          failure ??= new Error("Owned HTTP request failed");
          request.destroy();
        });
        request.once("close", () => {
          clearTimeout(deadline);
          if (failure) reject(failure);
          else if (completed) resolve(completed);
          else reject(new Error("Owned HTTP request closed before complete response"));
        });
        request.end(body);
      });
    };
    const viewerClient = new UsAuthTestClient(transport);
    const ownerClient = new UsAuthTestClient(transport);
    const authClient = (client: UsAuthTestClient, email: string, password: string) => {
      let totpUri = "";
      return {
        client,
        signIn: () => client.request("/sign-in/email", { email, password }),
        async enroll() {
          const response = await client.request("/two-factor/enable", { password });
          const data: unknown = await response.json();
          if (
            response.status !== 200 ||
            !data ||
            typeof data !== "object" ||
            !("totpURI" in data) ||
            typeof data.totpURI !== "string"
          )
            throw new Error("Normal viewer HTTP MFA enrollment failed");
          totpUri = data.totpURI;
        },
        verify: () => client.request("/two-factor/verify-totp", { code: currentUsTotp(totpUri) }),
        trustDevice: () =>
          client.request("/two-factor/verify-totp", {
            code: currentUsTotp(totpUri),
            trustDevice: true,
          }),
        replaceFactor: () => client.request("/two-factor/enable", { password }),
        select: (tenantId = c.tenant) =>
          client.request("/organization/set-active", { organizationId: tenantId }),
        signOut: () => client.request("/sign-out", {}),
      };
    };
    async function tableDigests(excluded: string[]) {
      const tables = (
        await ownedDatabase.pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((r) => r.tablename);
      const statements = tables
        .filter((name) => !excluded.includes(name))
        .map((table) => {
          if (!/^[a-z_][a-z0-9_]*$/.test(table))
            throw new Error("Unexpected test schema identifier");
          return `SELECT '${table}' AS name, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${table}" t`;
        });
      const snapshot = await ownedDatabase.pool.query<{ name: string; rows: unknown[] }>(
        statements.join(" UNION ALL "),
      );
      return Object.fromEntries(
        snapshot.rows.map((row) => [
          row.name,
          { count: row.rows.length, sha256: viewerHttpDigest(row.rows) },
        ]),
      );
    }
    const activePublished = published;
    return {
      app,
      database,
      ownerUserId: owner.userId,
      viewerUserId,
      tenantId: c.tenant,
      context,
      receiving,
      corrected,
      receivingDraft,
      finalizedTransformation,
      outputLotId,
      boxId,
      sscc,
      caseLinks,
      transformation,
      shipping,
      transformationDraft,
      shippingDraft,
      foreign,
      foreignPlan,
      foreignRequest,
      foreignRunId: foreignRun.id,
      draftPlan,
      plan,
      source,
      artifacts: state.artifacts,
      viewer: authClient(viewerClient, "viewer@us-development.example.test", viewerPassword),
      owner: authClient(ownerClient, "owner@us-development.example.test", ownerPassword),
      transport,
      close,
      serverUrl,
      request(
        path: string,
        method = "GET",
        body?: unknown,
        client: UsAuthTestClient | null = viewerClient,
        extra: HeadersInit = {},
      ) {
        const headers = client?.headers() ?? new Headers();
        headers.set("origin", "http://localhost:5174");
        headers.set("content-type", "application/json");
        for (const [key, value] of new Headers(extra)) headers.set(key, value);
        return transport(
          new Request(`http://localhost:3100${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      },
      businessSnapshot: () => tableDigests([...authTables, "tenant_audit_events"]),
      async authSnapshot() {
        const all = await tableDigests([]);
        return Object.fromEntries(authTables.map((name) => [name, all[name]]));
      },
      async identitySnapshot() {
        const others = await ownedDatabase.pool.query(
          'SELECT to_jsonb(u) AS row FROM "user" u WHERE id<>$1 ORDER BY id',
          [viewerUserId],
        );
        const viewer = await ownedDatabase.pool.query(
          "SELECT to_jsonb(u)-'updated_at'-'two_factor_enabled' AS row FROM \"user\" u WHERE id=$1",
          [viewerUserId],
        );
        const credentials = await ownedDatabase.pool.query(
          "SELECT to_jsonb(a) AS row FROM account a ORDER BY id",
        );
        return {
          otherUsers: viewerHttpDigest(others.rows),
          viewerCore: viewerHttpDigest(viewer.rows),
          credentials: viewerHttpDigest(credentials.rows),
        };
      },
      auditSnapshot: () =>
        db.select().from(schema.tenantAuditEvents).orderBy(schema.tenantAuditEvents.id),
      privateSnapshot() {
        return {
          plans: [...source.planFixture.objects]
            .map(([key, bytes]) => ({
              key: viewerHttpDigest(key),
              sha256: viewerHttpDigest(bytes),
            }))
            .sort((a, b) => a.key.localeCompare(b.key)),
          packages: [...activePublished.storage.objects]
            .map(([key, object]) => ({
              key: viewerHttpDigest(key),
              sha256: viewerHttpDigest(object),
            }))
            .sort((a, b) => a.key.localeCompare(b.key)),
        };
      },
      providerSnapshot() {
        return {
          ...providerOperations,
          package: activePublished.storage.calls.map((call) => call.kind),
          plan: source.planFixture.transport.calls.map((call) => call.command),
          openStreams:
            activePublished.storage.bodies.filter((body) => !body.destroyed && !body.readableEnded)
              .length +
            (source.planFixture.transport.lastBody &&
            !source.planFixture.transport.lastBody.destroyed &&
            !source.planFixture.transport.lastBody.readableEnded
              ? 1
              : 0),
        };
      },
      artifactBytes(kind: string) {
        const artifact = state.artifacts.find((item) => item.kind === kind);
        if (!artifact) throw new Error("Missing fixture publication descriptor");
        const object = activePublished.storage.objects.get(artifact.objectKey);
        if (!object) throw new Error("Missing fixture publication bytes");
        return Buffer.from(object.bytes);
      },
      planBytes() {
        const object = [...source.planFixture.objects.values()][0];
        if (!object) throw new Error("Missing fixture Plan bytes");
        return Buffer.from(object);
      },
    };
  } catch {
    let cleanupFailed = false;
    try {
      await close();
    } catch {
      cleanupFailed = true;
    }
    throw usViewerHttpFixtureFailure(phase, cleanupFailed);
  }
}
