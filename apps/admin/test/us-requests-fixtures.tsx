import {
  usRequestDetailResponseSchema,
  usRequestRunDetailSchema,
  usRequestSummarySchema,
  type UsRequestDetailResponse,
  type UsRequestRunDetail,
  type UsRequestSummary,
  type TraceabilityLot,
  usRequestValidationHttpResponseSchema,
  type UsRequestValidationHttpResponse,
} from "@markiro/platform-contracts";
import { vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { I18nextProvider } from "react-i18next";
import type { i18n as I18nInstance } from "i18next";
import type { RenderResult } from "@testing-library/react";
import { RequestsView, type RequestsViewProps } from "../src/us/requests/view.js";
import { clientFixture, profile, renderPlanUi } from "./us-plans-fixtures.js";

export function requestsFixture() {
  const { client } = clientFixture();
  vi.spyOn(client, "session").mockResolvedValue({
    user: {
      id: "synthetic-actor",
      name: "Synthetic actor",
      email: "actor@example.test",
      twoFactorEnabled: true,
    },
    activeOrganizationId: "tenant",
  });
  vi.spyOn(client.requests, "list").mockResolvedValue({
    items: [requestSummary()],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  vi.spyOn(client.requests, "get").mockResolvedValue(requestDetail());
  vi.spyOn(client.requests, "create").mockResolvedValue({
    httpRequestId: "b0000000-0000-4000-8000-000000000001",
    requestId: id,
    revision: 1,
    status: "open",
  });
  vi.spyOn(client.requests, "update").mockResolvedValue({
    httpRequestId: "b0000000-0000-4000-8000-000000000001",
    requestId: id,
    revision: 2,
    status: "open",
  });
  vi.spyOn(client.requests, "close").mockResolvedValue({
    httpRequestId: "b0000000-0000-4000-8000-000000000001",
    requestId: id,
    revision: 2,
    status: "closed",
  });
  vi.spyOn(client, "listLots").mockResolvedValue({ items: [], limit: 50, offset: 0 });
  vi.spyOn(client, "getLot").mockResolvedValue(requestLot());
  vi.spyOn(client.requests, "validate").mockResolvedValue(requestValidation());
  vi.spyOn(client.requests, "acknowledgeWarnings").mockResolvedValue({
    httpRequestId: "b0000000-0000-4000-8000-000000000001",
    requestId: id,
    revision: 1,
    status: "open",
  });
  vi.spyOn(client.requests, "prepare").mockResolvedValue({
    httpRequestId: "b0000000-0000-4000-8000-000000000001",
    requestId: id,
    requestRevision: 1,
    runId: requestRun().runId,
    runRevision: 1,
    mode: "export_ready",
    idempotencyKey: "20000000-0000-4000-8000-000000000002",
    scopedContentDigest: "b".repeat(64),
  });
  vi.spyOn(client.requests, "getRun").mockResolvedValue(requestRun());
  vi.spyOn(client.requests, "listRuns").mockResolvedValue({
    items: [],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  vi.spyOn(client.requests, "listAttempts").mockResolvedValue({
    items: [],
    limit: 25,
    offset: 0,
    hasMore: false,
  });
  vi.spyOn(client.requests, "retry");
  vi.spyOn(client.requests, "download");
  return client;
}

export function requestValidation(
  overrides: Partial<UsRequestValidationHttpResponse> = {},
): UsRequestValidationHttpResponse {
  return usRequestValidationHttpResponseSchema.parse({
    httpRequestId: "b0000000-0000-4000-8000-000000000001",
    requestId: id,
    revision: 1,
    digest: "b".repeat(64),
    byteSize: 1024,
    matchedRevisionCount: 1,
    findings: [],
    validatedAt: time,
    ...overrides,
  });
}

export function requestLot(overrides: Partial<TraceabilityLot> = {}): TraceabilityLot {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    productId: "20000000-0000-4000-8000-000000000001",
    tlc: "SYNTHETIC-TLC",
    source: null,
    assignmentBasis: "imported",
    sourceLockedAt: null,
    status: "active",
    revision: 1,
    createdBy: "qa",
    updatedBy: "qa",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

export function renderRequests(
  overrides: Partial<RequestsViewProps> = {},
  locale = "en-US",
): RenderResult & {
  instance: I18nInstance;
  props: RequestsViewProps;
  rerenderRequests: (next: Partial<RequestsViewProps>) => void;
} {
  const props: RequestsViewProps = {
    client: requestsFixture(),
    organizationId: "tenant",
    profile,
    canRead: true,
    canManageQa: false,
    canExport: false,
    authorityPending: false,
    entry: {},
    onEntryChange: vi.fn(),
    onForbidden: vi.fn(async () => {}),
    onSessionLost: vi.fn(),
    onDirtyChange: vi.fn(),
    onMutationPendingChange: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenLot: vi.fn(),
    ...overrides,
  };
  const result = renderPlanUi(<RequestsView {...props} />, locale);
  return {
    ...result,
    props,
    rerenderRequests: (next: Partial<RequestsViewProps>) =>
      result.rerender(
        <ThemeProvider defaultTheme="light">
          <I18nextProvider i18n={result.instance}>
            <RequestsView {...props} {...next} />
          </I18nextProvider>
        </ThemeProvider>,
      ),
  };
}

const id = "a0000000-0000-4000-8000-000000000001";
const time = "2026-10-05T00:00:00.000Z";

export function requestSummary(overrides: Partial<UsRequestSummary> = {}): UsRequestSummary {
  return usRequestSummarySchema.parse({
    id,
    requestNumber: "REQ-1",
    revision: 1,
    status: "open",
    receivedAt: time,
    dueAt: "2026-10-06T00:00:00.000Z",
    createdBy: "synthetic-actor",
    createdAt: time,
    updatedAt: time,
    closedAt: null,
    lastValidatedAt: null,
    ...overrides,
  });
}

export function requestDetail(
  overrides: Partial<UsRequestDetailResponse> = {},
): UsRequestDetailResponse {
  return usRequestDetailResponseSchema.parse({
    ...requestSummary(),
    requesterName: "Synthetic Requester",
    requesterOrganization: null,
    requesterContact: null,
    alternateDeadlineReason: null,
    scope: null,
    savedValidation: null,
    warningAcknowledgement: null,
    latestRun: null,
    availability: { build: "available", packageStorage: "configured" },
    ...overrides,
  });
}

export function requestRun(overrides: Partial<UsRequestRunDetail> = {}): UsRequestRunDetail {
  return usRequestRunDetailSchema.parse({
    runId: "b0000000-0000-4000-8000-000000000002",
    requestId: id,
    requestRevision: 1,
    runRevision: 1,
    mode: "export_ready",
    status: "queued",
    exportReady: false,
    createdBy: "synthetic-actor",
    commandDigest: "a".repeat(64),
    scopedContentDigest: "b".repeat(64),
    inputDigest: null,
    lifecycleVersion: 0,
    retryCycle: 1,
    attemptCount: 0,
    cycleAttemptCount: 0,
    failureCode: null,
    startedAt: time,
    generationStartedAt: null,
    reportRenderedAt: null,
    completedAt: null,
    nextAttemptAt: null,
    provenance: "not_verified",
    request: {
      id,
      revision: 1,
      requestNumber: "REQ-1",
      requesterName: "Synthetic Requester",
      requesterOrganization: null,
      requesterContact: null,
      receivedAt: time,
      dueAt: "2026-10-06T00:00:00.000Z",
      alternateDeadlineReason: null,
    },
    scope: { tlc: "0001-日本" },
    findings: [],
    latestAttempt: null,
    artifacts: [],
    missingFiles: null,
    ...overrides,
  });
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
