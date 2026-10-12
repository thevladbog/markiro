import { randomUUID } from "node:crypto";
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEnv } from "node:util";
import { createDb } from "@markiro/db";
import { hashPassword } from "better-auth/crypto";
import { onTestFinished } from "vitest";
import { createUsDevelopmentApplication } from "../../src/deployment/us-bootstrap";
import { listenOnLoopback } from "./listen-loopback";
import { currentUsTotp, UsAuthTestClient } from "./us-auth-client";
import { outcome, type OwnCleanup } from "./us-transformation-lock-fixture";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type {
  UsDatasetContext,
  UsDatasetIntent,
} from "../../src/modules/traceability/demo/us-dataset-contract";
import type { UsDemoTransaction } from "../../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import {
  makeUsDatasetCasesInput,
  parseUsDatasetCasesResult,
  usDatasetCasesRecordIds,
  type UsDatasetCasesInput,
} from "../../src/modules/traceability/demo/us-dataset-cases-contract";
import type { CaseLinkResult } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { UsDatasetReferenceSeedStore } from "../../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetTransformationSeedStore } from "../../src/modules/traceability/demo/us-dataset-transformation-seed";
import { makeUsSixMonthRegularChain } from "../../src/modules/traceability/demo/us-six-month-chains";
import type { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { datasetTransformationStores } from "./us-dataset-transformation-fixture";
import { prepareUsDatasetCases } from "../../src/modules/traceability/demo/us-dataset-cases-prepare";
import { verifyUsDatasetCases } from "../../src/modules/traceability/demo/us-dataset-cases-verify";
import { UsCaseStore } from "../../src/modules/traceability/cases/us-case-store";
import { insertUsDatasetCasesSupport } from "../../src/modules/traceability/demo/us-dataset-cases-support";

export async function composeDatasetCases(
  f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>,
  context: UsDatasetContext,
  index = 259,
) {
  const prepared = await prepareDatasetCasesFixture(f, context, index);
  const stores = datasetTransformationStores(f.db);
  const requestId = randomUUID();
  const stage = await stores.journal.runAtomicStage(
    context,
    prepared.datasetId,
    1,
    prepared.intent,
    {
      apply: async (tx, checked, intent) => {
        await prepareUsDatasetCases(
          tx,
          checked,
          prepared.datasetId,
          intent.unitKey,
          { mode: "application" },
          stores,
        );
        await insertUsDatasetCasesSupport(tx, checked, prepared.input);
        const linked = await new UsCaseStore(f.db).linkDemoInTransaction(
          tx,
          checked,
          prepared.datasetId,
          intent.unitKey,
          requestId,
        );
        return datasetCasesFixtureReceipt(tx, checked, prepared.input, intent, linked, requestId);
      },
      verify: (tx, checked, intent, receipt) =>
        verifyUsDatasetCases(tx, checked, intent, receipt, "fresh", stores),
    },
  );
  if (!stage.receipt) throw new Error("Missing composed Cases receipt");
  return {
    ...prepared,
    stores,
    stage,
    receipt: stage.receipt,
    result: parseUsDatasetCasesResult(stage.receipt.result),
  };
}

/** Register before starting the body, so a runner timeout cannot outrun actual DB work. */
export async function runDatasetCasesFixtureBody(work: () => Promise<void>): Promise<void> {
  const running = outcome(Promise.resolve().then(work));
  onTestFinished(async () => {
    await running;
  });
  const result = await running;
  if (result.error !== undefined) throw result.error;
}

export async function datasetCasesHttpClient(
  f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>,
  context: UsDatasetContext,
  own: OwnCleanup,
) {
  const base = process.env.US_TEST_DATABASE_URL;
  if (!base) throw new Error("Missing isolated US URL");
  const url = new URL(base);
  url.pathname = "/" + f.databaseName;
  const app = await createUsDevelopmentApplication(
    parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
    (_url, options) => createDb(url.toString(), options),
  );
  own("HTTP application", () => app.close());
  await app.init();
  await listenOnLoopback(app);
  const serverUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const transport = async (input: Request): Promise<Response> => {
    const body = await input.text(),
      path = new URL(input.url);
    return new Promise((resolve, reject) => {
      const headers = new Headers(input.headers);
      headers.set("host", "localhost:3100");
      headers.set("content-length", String(Buffer.byteLength(body)));
      const request = httpRequest(
        serverUrl + path.pathname + path.search,
        { method: input.method, headers: Object.fromEntries(headers) },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const result = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const entry of value) result.append(key, entry);
              else if (value !== undefined) result.set(key, value);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                headers: result,
              }),
            );
          });
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  };
  const password = "Synthetic-owned-case-HTTP-password-42!";
  await f.db
    .update(schema.account)
    .set({ password: await hashPassword(password) })
    .where(
      and(
        eq(schema.account.userId, context.actorUserId),
        eq(schema.account.providerId, "credential"),
      ),
    );
  const client = new UsAuthTestClient(transport);
  if (
    (
      await client.request("/sign-in/email", {
        email: "owner@us-development.example.test",
        password,
      })
    ).status !== 200
  )
    throw new Error("Owned HTTP sign-in failed");
  const enrollment = await client.request("/two-factor/enable", { password });
  const data: unknown = await enrollment.json();
  if (
    enrollment.status !== 200 ||
    typeof data !== "object" ||
    data === null ||
    !("totpURI" in data) ||
    typeof data.totpURI !== "string"
  )
    throw new Error("Owned HTTP enrollment failed");
  if (
    (await client.request("/two-factor/verify-totp", { code: currentUsTotp(data.totpURI) }))
      .status !== 200
  )
    throw new Error("Owned HTTP MFA failed");
  if (
    (await client.request("/organization/set-active", { organizationId: context.tenantId }))
      .status !== 200
  )
    throw new Error("Owned HTTP organization failed");
  return async (lotId: string, body: unknown) => {
    const headers = client.headers();
    headers.set("origin", "http://localhost:5174");
    headers.set("content-type", "application/json");
    return transport(
      new Request(`http://localhost:3100/traceability/lots/${lotId}/cases`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  };
}

/** Real upstream stores and durable capture; only private support is fixture-owned. */
export async function prepareDatasetCasesFixture(
  f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>,
  context: UsDatasetContext,
  index: number,
): Promise<Readonly<{ datasetId: string; input: UsDatasetCasesInput; intent: UsDatasetIntent }>> {
  await new UsDatasetReferenceSeedStore(f.db).initialize(context);
  await new UsDatasetReceivingSeedStore(f.db).initialize(context, index);
  await new UsDatasetTransformationSeedStore(f.db).initialize(context, index);
  const { journal } = datasetTransformationStores(f.db);
  const header = await journal.read(context);
  if (!header) throw new Error("Missing fixture header");
  const chain = makeUsSixMonthRegularChain(index);
  const references = await journal.readStage(context, header.id, "references", "references");
  const receiving = await journal.readStage(context, header.id, chain.unitKey, "receiving");
  const transformation = await journal.readStage(
    context,
    header.id,
    chain.unitKey,
    "transformation",
  );
  if (!references || !receiving || !transformation) throw new Error("Missing fixture stages");
  const capturedAt = new Date().toISOString();
  const input = makeUsDatasetCasesInput(index, header.id, references, receiving, transformation, {
    capturedAt,
    shiftId: randomUUID(),
    numberMonthKey:
      new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
        .format(new Date(capturedAt))
        .toUpperCase() + capturedAt.slice(2, 4),
    numberSeq: index + 1,
    boxes: chain.cases.map((sscc) => ({ id: randomUUID(), deviceBoxId: randomUUID(), sscc })),
  });
  const intent: UsDatasetIntent = {
    unitKey: chain.unitKey,
    stage: "cases",
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  };
  const saved = await journal.captureIntent(context, header.id, intent);
  return { datasetId: header.id, input, intent: saved.intent };
}

export async function insertDatasetCasesFixtureSupport(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  input: UsDatasetCasesInput,
) {
  await tx.insert(schema.shifts).values({
    id: input.support.shiftId,
    tenantId: context.tenantId,
    productId: input.outputProductId,
    mode: "aggregation",
    numberMonthKey: input.support.numberMonthKey,
    numberSeq: input.support.numberSeq,
  });
  await tx.insert(schema.boxes).values(
    input.support.boxes.map((box) => ({
      ...box,
      tenantId: context.tenantId,
      shiftId: input.support.shiftId,
      terminalId: null,
      operatorId: null,
    })),
  );
  await tx.insert(schema.traceabilitySyntheticCaseOrigins).values(
    input.support.boxes.map((box) => ({
      tenantId: context.tenantId,
      boxId: box.id,
      seedId: input.references.datasetId,
      seedVersion: 1,
    })),
  );
}

/** Test evidence only; never writes service links, audit or operation rows. */
export async function datasetCasesFixtureReceipt(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  input: UsDatasetCasesInput,
  intent: UsDatasetIntent,
  linked: CaseLinkResult,
  requestId: string,
) {
  const [shift] = await tx
    .select()
    .from(schema.shifts)
    .where(
      and(
        eq(schema.shifts.tenantId, context.tenantId),
        eq(schema.shifts.id, input.support.shiftId),
      ),
    );
  const boxes = await tx
    .select()
    .from(schema.boxes)
    .where(
      and(
        eq(schema.boxes.tenantId, context.tenantId),
        eq(schema.boxes.shiftId, input.support.shiftId),
      ),
    );
  const markers = await tx
    .select()
    .from(schema.traceabilitySyntheticCaseOrigins)
    .where(eq(schema.traceabilitySyntheticCaseOrigins.tenantId, context.tenantId));
  if (!shift) throw new Error("Missing fixture support");
  const result = parseUsDatasetCasesResult({
    input,
    operationKey: intent.operationKey,
    requestId,
    linked,
    support: {
      shift: {
        id: shift.id,
        productId: shift.productId,
        status: shift.status,
        mode: shift.mode,
        numberMonthKey: shift.numberMonthKey,
        numberSeq: shift.numberSeq,
        createdAt: shift.createdAt.toISOString(),
      },
      boxes: input.support.boxes.map((binding) => {
        const row = boxes.find((box) => box.id === binding.id);
        if (!row) throw new Error("Missing fixture box");
        return {
          id: row.id,
          shiftId: row.shiftId,
          deviceBoxId: row.deviceBoxId,
          sscc: row.sscc,
          openedAt: row.openedAt.toISOString(),
        };
      }),
      markers: input.support.boxes.map((binding) => {
        const row = markers.find((marker) => marker.boxId === binding.id);
        if (!row) throw new Error("Missing fixture marker");
        return {
          boxId: row.boxId,
          seedId: row.seedId,
          seedVersion: row.seedVersion,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    },
  });
  return {
    result,
    resultDigest: canonicalExportDigest(result),
    recordIds: usDatasetCasesRecordIds(result),
  };
}
