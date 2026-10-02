import { z } from "zod";
import {
  receivingCsvPreviewInputSchema,
  receivingCsvPreviewSchema,
  receivingCsvApplyInputSchema,
  receivingCsvApplyResponseSchema,
  decodeReceivingCsvExport,
  matchesReceivingCsvApplyResponse,
  createReceivingDraftSchema,
  finalizeReceivingCommandSchema,
  receivingFinalizeResultSchema,
  receivingCreateResultSchema,
  receivingSaveResultSchema,
  receivingLiveRecordSchema,
  listReceivingLiveRecordsQuerySchema,
  receivingLiveRecordListSchema,
  type receivingReadinessIssueSchema,
  receivingReadinessQuerySchema,
  receivingRevisionReadinessSchema,
  saveReceivingCommandSchema,
  amendReceivingSchema,
  voidReceivingSchema,
  receivingOperationReceiptV2Schema,
  receivingRevisionListQuerySchema,
  receivingRevisionListSchema,
  receivingBasisQuerySchema,
  receivingBasisSchema,
  receivingLifecycleErrorSchema,
  type ReceivingLifecycleError,
  listReceivingDraftsQuerySchema,
  listReferenceDocumentsQuerySchema,
  referenceDocumentInputSchema,
  referenceDocumentListSchema,
  referenceDocumentSchema,
  createTraceabilityLotSchema,
  listTraceabilityLotsQuerySchema,
  patchLotSourceSchema,
  postLotStatusSchema,
  traceabilityLotListSchema,
  traceabilityLotSchema,
  productTraceabilityProfileSchema,
  putProductTraceabilityProfileSchema,
  createUsProductSchema,
  updateUsProductSchema,
  listUsProductsQuerySchema,
  usProductSchema,
  usProductListSchema,
  createUsLocationSchema,
  createUsPartySchema,
  listUsLocationsQuerySchema,
  listUsPartiesQuerySchema,
  platformUuidSchema,
  provisionUsTraceabilityProfileSchema,
  updateUsLocationSchema,
  updateUsPartySchema,
  usLocationListSchema,
  usLocationSchema,
  usPartyListSchema,
  usPartySchema,
  usTraceabilityAccessSchema,
  usTraceabilityProfileSummarySchema,
  type ListUsLocationsQuery,
  usEventListQuerySchema,
  usEventListSchema,
  transformationHttpRecordSchema,
  createTransformationDraftSchema,
  saveTransformationDraftSchema,
  finalizeTransformationSchema,
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
  transformationReadinessSchema,
  amendTransformationSchema,
  voidTransformationSchema,
  transformationLifecycleReceiptSchema,
  transformationRevisionListQuerySchema,
  transformationRevisionListSchema,
  transformationGenealogyRequestSchema,
  transformationGenealogyResultSchema,
  transformationHttpErrorSchema,
  type TransformationHttpError,
  createShippingDraftSchema,
  saveShippingDraftSchema,
  shippingDraftRecordSchema,
  shippingHistoricalRecordSchema,
  shippingFinalizedRecordSchema,
  shippingReadinessSchema,
  shippingBalanceQuerySchema,
  shippingBalanceResponseSchema,
  finalizeShippingSchema,
  amendShippingSchema,
  voidShippingSchema,
  shippingLifecycleReceiptSchema,
  shippingRevisionListQuerySchema,
  shippingRevisionListSchema,
  shippingHttpErrorSchema,
  caseListQuerySchema,
  caseListResultSchema,
  caseLinkCommandSchema,
  caseLinkResultSchema,
  caseUnlinkCommandSchema,
  caseUnlinkResultSchema,
  usReadinessQuerySchema,
  usReadinessResultSchema,
  type UsReadinessResult,
  usTraceSearchQuerySchema,
  usTraceSearchPageSchema,
  usLotCardSchema,
  usLotCardEvidenceQuerySchema,
  usLotCardEvidencePageSchema,
  usCurrentTraceQuerySchema,
  usCurrentTraceResultSchema,
  usTraceHistoryQuerySchema,
  usTraceHistoryPageSchema,
  type UsTraceSearchPage,
  type UsLotCard,
  type UsLotCardEvidencePage,
  type UsCurrentTraceResult,
  type UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import {
  matchesReceivingCreateAcknowledgement,
  matchesReceivingSaveAcknowledgement,
  matchesReceivingFinalizeAcknowledgement,
  matchesReceivingAmendAcknowledgement,
  matchesReceivingVoidAcknowledgement,
} from "./receiving/command-acknowledgement.js";
import { matchesReceivingCsvPreview } from "./receiving/csv-integrity.js";

type ShippingHttpError = z.infer<typeof shippingHttpErrorSchema>;

export type UsClientErrorCode =
  | "receiving_export_stale"
  | "export_value_too_large"
  | "receiving_csv_preview_expired"
  | "receiving_csv_preview_stale"
  | "receiving_csv_preview_conflict"
  | "receiving_csv_preview_not_applicable"
  | "receiving_csv_preview_not_found"
  | ReceivingLifecycleError["code"]
  | TransformationHttpError["code"]
  | ShippingHttpError["code"]
  | "shipping_not_found"
  | "shipping_reference_not_found"
  | "case_not_found"
  | "case_lot_not_found"
  | "case_link_not_found"
  | "case_operation_conflict"
  | "case_disassembled"
  | "case_sscc_inconsistent"
  | "case_link_conflict"
  | "case_origin_not_current"
  | "case_link_stale"
  | "readiness_scope_too_large"
  | "readiness_scope_not_found"
  | "readiness_invalid_scope"
  | "trace_lot_not_found"
  | "invalid_input"
  | "invalid_response"
  | "session_required"
  | "forbidden"
  | "party_archived"
  | "product_gtin_taken"
  | "product_gtin_locked"
  | "lot_duplicate"
  | "lot_source_locked"
  | "lot_revision_conflict"
  | "lot_reference_archived"
  | "receiving_draft_conflict"
  | "receiving_operation_conflict"
  | "receiving_reference_inactive"
  | "receiving_reference_not_found"
  | "receiving_draft_not_found"
  | "receiving_already_finalized"
  | "receiving_readiness_changed"
  | "receiving_lot_conflict"
  | "event_incomplete"
  | "document_duplicate"
  | "conflict"
  | "rate_limited"
  | "profile_not_provisioned"
  | "unavailable"
  | "request_rejected";

type TransformationConflict = Extract<
  TransformationHttpError,
  { code: "event_incomplete" | "traceability_downstream_blocked" }
>;
type ShippingConflict = Extract<
  ShippingHttpError,
  { code: "event_incomplete" | "traceability_downstream_blocked" }
>;

/** Safe translation key only. Never retain a raw response, payload or error cause. */
export class UsClientError extends Error {
  constructor(readonly code: UsClientErrorCode) {
    super(code);
    this.name = "UsClientError";
  }
}

export class UsShippingConflictError extends UsClientError {
  readonly issues?: Extract<ShippingConflict, { code: "event_incomplete" }>["issues"];
  readonly blockers?: Extract<
    ShippingConflict,
    { code: "traceability_downstream_blocked" }
  >["blockers"];
  readonly hasMore?: boolean;

  constructor(detail: ShippingConflict) {
    super(detail.code);
    this.name = "UsShippingConflictError";
    if (detail.code === "event_incomplete") this.issues = detail.issues;
    else {
      this.blockers = detail.blockers;
      this.hasMore = detail.hasMore;
    }
  }
}

/** Parsed, bounded conflict evidence only; no server response or cause is retained. */
export class UsTransformationConflictError extends UsClientError {
  readonly issues?: Extract<TransformationConflict, { code: "event_incomplete" }>["issues"];
  readonly blockers?: Extract<
    TransformationConflict,
    { code: "traceability_downstream_blocked" }
  >["blockers"];
  readonly hasMore?: boolean;

  constructor(detail: TransformationConflict) {
    super(detail.code);
    this.name = "UsTransformationConflictError";
    if (detail.code === "event_incomplete") this.issues = detail.issues;
    else {
      this.blockers = detail.blockers;
      this.hasMore = detail.hasMore;
    }
  }
}

export class UsLotDuplicateError extends UsClientError {
  constructor(readonly existingId: string) {
    super("lot_duplicate");
    this.name = "UsLotDuplicateError";
  }
}

export class UsReceivingIncompleteError extends UsClientError {
  constructor(readonly issues: z.infer<typeof receivingReadinessIssueSchema>[]) {
    super("event_incomplete");
    this.name = "UsReceivingIncompleteError";
  }
}

/** Strict bounded server context only; never a raw error body or cause. */
export class UsReceivingLifecycleError extends UsClientError {
  constructor(readonly detail: ReceivingLifecycleError) {
    super(detail.code);
    this.name = "UsReceivingLifecycleError";
  }
}

const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string(),
  twoFactorEnabled: z.boolean(),
});
const sessionSchema = z
  .object({
    user: userSchema,
    session: z.object({ activeOrganizationId: z.string().min(1).nullish() }),
  })
  .nullable();
const signedInSchema = z.union([
  z
    .object({ twoFactorRedirect: z.literal(true) })
    .transform(() => ({ step: "mfa_required" as const })),
  z
    .object({ token: z.string().min(1), user: userSchema })
    .transform(() => ({ step: "password_session" as const })),
]);
const organizationSchema = z.object({ id: z.string().min(1), name: z.string(), slug: z.string() });
const verificationSchema = z
  .object({ token: z.string().min(1), user: userSchema })
  .transform(() => undefined);
const enrollmentSchema = z.object({
  totpURI: z.string().refine((value) => {
    try {
      const uri = new URL(value);
      return (
        uri.protocol === "otpauth:" &&
        uri.hostname === "totp" &&
        /^[A-Z2-7]+=*$/i.test(uri.searchParams.get("secret") ?? "")
      );
    } catch {
      return false;
    }
  }),
  backupCodes: z.array(z.string().min(1)).min(1),
});
const passwordSchema = z.string().min(1).max(128);
const profilePath = "/api/us/traceability/profile";
const accessPath = "/api/us/traceability/access";
const partiesPath = "/api/us/traceability/parties";
const locationsPath = "/api/us/traceability/locations";
const productsPath = "/api/us/traceability/catalog/products";
const lotsPath = "/api/us/traceability/lots";
const searchPath = "/api/us/traceability/search";
const receivingPath = "/api/us/traceability/receiving";
const eventsPath = "/api/us/traceability/events";
const readinessPath = "/api/us/traceability/readiness";
const transformationPath = "/api/us/traceability/transformation";
const shippingPath = "/api/us/traceability/shipments";
const casesPath = "/api/us/traceability/lots";
const uuidPath = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const lotErrorRoute = new RegExp(`^${lotsPath}/${uuidPath}(?:/(?:source|status))?$`);
const caseErrorRoute = new RegExp(
  `^${casesPath}/${uuidPath}/cases(?:\\?[^#]*|/${uuidPath}/unlink)?$`,
);
const transformationErrorRoute = new RegExp(
  `^${transformationPath}(?:/genealogy/query|/${uuidPath}(?:/(?:finalize|amend|void)|/readiness\\?expectedDraftVersion=[1-9][0-9]*|/revisions\\?limit=[1-9][0-9]*&offset=(?:0|[1-9][0-9]*))?)?$`,
);
const shippingErrorRoute = new RegExp(
  `^${shippingPath}(?:/${uuidPath}(?:/(?:finalize|amend|void)|/readiness\\?expectedDraftVersion=[1-9][0-9]*|/revisions\\?limit=[1-9][0-9]*&offset=(?:0|[1-9][0-9]*))?)?$`,
);
const receivingCsvPath = `${receivingPath}/imports`;
const maxReceivingExportBytes = 16 * 1024 * 1024;
const documentsPath = "/api/us/traceability/reference-documents";
const deploymentSchema = z
  .object({
    edition: z.literal("US"),
    releaseEnabled: z.literal(false),
    interfaceLocales: z.tuple([z.literal("en-US"), z.literal("es-US")]),
    defaultInterfaceLocale: z.literal("en-US"),
  })
  .strict();

function checked<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: UsClientErrorCode,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new UsClientError(code);
  return result.data;
}

/** Serialize validated fields only; repeated roles retain the server's AND semantics. */
function masterDataQuery(query: ListUsLocationsQuery): string {
  const params = new URLSearchParams({
    archived: query.archived,
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.search !== undefined) params.set("search", query.search);
  if (query.partyId !== undefined) params.set("partyId", query.partyId);
  for (const role of query.roles ?? []) params.append("roles", role);
  return params.toString();
}

/** Clone before the first await. A later live GET cannot replace command context. */
function captureReceivingContext(
  eventId: string,
  input: { expectedLifecycleVersion: number; expectedDraftVersion?: number | null },
  captured: unknown,
) {
  const record = checked(receivingLiveRecordSchema, captured, "invalid_input");
  if (
    record.id.toLowerCase() !== eventId ||
    record.lifecycle.lifecycleVersion !== input.expectedLifecycleVersion ||
    (input.expectedDraftVersion !== undefined &&
      input.expectedDraftVersion !== (record.status === "draft" ? record.draftVersion : null))
  )
    throw new UsClientError("invalid_input");
  return record;
}

async function readBoundedReceivingExport(response: Response): Promise<Uint8Array> {
  const length = response.headers.get("Content-Length");
  if (
    length !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxReceivingExportBytes)
  )
    throw new UsClientError("invalid_response");
  if (!response.body) throw new UsClientError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxReceivingExportBytes) throw new UsClientError("invalid_response");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length !== null && Number(length) !== size) throw new UsClientError("invalid_response");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Only fixed same-origin US routes; no RU client imports, retries or persistence.
 * The US browser entry must separately attest edition and configure its proxy.
 * Callers must keep enrollment material out of query caches and persistent stores.
 */
export function createUsBrowserClient(send: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
    method = "GET",
    body?: unknown,
  ): Promise<z.output<S>> {
    let response: Response;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
    try {
      response = await send(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        if (controller.signal.aborted) throw new UsClientError("unavailable");
        if (response.ok) throw new UsClientError("invalid_response");
      }
      if (!response.ok) {
        const pathname = new URL(path, "http://localhost").pathname;
        const traceLotReadPath =
          method === "GET" &&
          new RegExp(`^${lotsPath}/${uuidPath}/(?:card(?:/evidence)?|trace(?:/history)?)$`).test(
            pathname,
          );
        const traceReadPath = traceLotReadPath || (method === "GET" && pathname === searchPath);
        if (response.status === 400 && traceReadPath) throw new UsClientError("invalid_input");
        if (response.status === 404 && traceLotReadPath)
          throw new UsClientError("trace_lot_not_found");
        if (path === readinessPath || path.startsWith(`${readinessPath}?`)) {
          if (response.status === 400) throw new UsClientError("readiness_invalid_scope");
          if (response.status === 404) throw new UsClientError("readiness_scope_not_found");
          if (
            response.status === 503 &&
            z
              .object({ code: z.literal("us_readiness_scope_too_large") })
              .strict()
              .safeParse(value).success
          )
            throw new UsClientError("readiness_scope_too_large");
        }
        if (shippingErrorRoute.test(path) && [404, 409].includes(response.status)) {
          if (response.status === 404) {
            const missing = z
              .object({ code: z.enum(["shipping_not_found", "shipping_reference_not_found"]) })
              .strict()
              .safeParse(value);
            if (missing.success) throw new UsClientError(missing.data.code);
          } else {
            const conflict = shippingHttpErrorSchema.safeParse(value);
            if (conflict.success) {
              if (
                conflict.data.code === "event_incomplete" ||
                conflict.data.code === "traceability_downstream_blocked"
              )
                throw new UsShippingConflictError(conflict.data);
              throw new UsClientError(conflict.data.code);
            }
          }
        }
        if (transformationErrorRoute.test(path)) {
          if ([404, 409].includes(response.status)) {
            const conflict = transformationHttpErrorSchema.safeParse(value);
            if (conflict.success) {
              const notFound =
                conflict.data.code === "transformation_not_found" ||
                conflict.data.code === "transformation_reference_not_found";
              if (response.status === 404 && notFound) throw new UsClientError(conflict.data.code);
              if (response.status === 409 && !notFound) {
                if (
                  conflict.data.code === "event_incomplete" ||
                  conflict.data.code === "traceability_downstream_blocked"
                )
                  throw new UsTransformationConflictError(conflict.data);
                throw new UsClientError(conflict.data.code);
              }
            }
          }
        }
        if (caseErrorRoute.test(path) && [404, 409].includes(response.status)) {
          const safeCaseError = z
            .object({
              code:
                response.status === 404
                  ? z.enum(["case_not_found", "case_lot_not_found", "case_link_not_found"])
                  : z.enum([
                      "case_operation_conflict",
                      "case_disassembled",
                      "case_sscc_inconsistent",
                      "case_link_conflict",
                      "case_origin_not_current",
                      "case_link_stale",
                    ]),
            })
            .strict()
            .safeParse(value);
          if (safeCaseError.success) throw new UsClientError(safeCaseError.data.code);
        }
        if (path.startsWith(`${receivingCsvPath}/`) && [404, 409].includes(response.status)) {
          const issue = z
            .object({
              code:
                response.status === 404
                  ? z.literal("receiving_csv_preview_not_found")
                  : z.enum([
                      "receiving_csv_preview_expired",
                      "receiving_csv_preview_stale",
                      "receiving_csv_preview_conflict",
                      "receiving_csv_preview_not_applicable",
                    ]),
            })
            .strict()
            .safeParse(value);
          if (issue.success) throw new UsClientError(issue.data.code);
        }
        if (path === receivingPath || path.startsWith(`${receivingPath}/`)) {
          if (response.status === 409) {
            const lifecycle = receivingLifecycleErrorSchema.safeParse(value);
            if (lifecycle.success) {
              if (lifecycle.data.code === "event_incomplete")
                throw new UsReceivingIncompleteError(lifecycle.data.issues);
              if (
                lifecycle.data.code === "receiving_lifecycle_conflict" ||
                lifecycle.data.code === "receiving_pending_amendment" ||
                lifecycle.data.code === "lot_identity_locked" ||
                lifecycle.data.code === "receiving_downstream_dependencies"
              )
                throw new UsReceivingLifecycleError(lifecycle.data);
              throw new UsClientError(lifecycle.data.code);
            }
          }
          const safe = (
            response.status === 409
              ? z
                  .object({
                    code: z.enum([
                      "receiving_draft_conflict",
                      "receiving_operation_conflict",
                      "receiving_reference_inactive",
                      "receiving_already_finalized",
                      "receiving_readiness_changed",
                      "receiving_lot_conflict",
                    ]),
                  })
                  .strict()
              : z
                  .object({
                    code: z.enum(["receiving_reference_not_found", "receiving_draft_not_found"]),
                  })
                  .strict()
          ).safeParse(value);
          if ([404, 409].includes(response.status) && safe.success)
            throw new UsClientError(safe.data.code);
        }
        if (
          path === documentsPath &&
          response.status === 409 &&
          z
            .object({ code: z.literal("document_duplicate") })
            .strict()
            .safeParse(value).success
        )
          throw new UsClientError("document_duplicate");
        if (response.status === 409 && (path === lotsPath || lotErrorRoute.test(path))) {
          const duplicate = z
            .object({ code: z.literal("LOT_DUPLICATE"), existingId: platformUuidSchema })
            .strict()
            .safeParse(value);
          if (duplicate.success) throw new UsLotDuplicateError(duplicate.data.existingId);
          const conflict = z
            .object({
              code: z.enum([
                "lot_source_locked",
                "lot_revision_conflict",
                "lot_reference_archived",
              ]),
            })
            .strict()
            .safeParse(value);
          if (conflict.success) throw new UsClientError(conflict.data.code);
        }
        if (
          response.status === 409 &&
          (path === productsPath || path.startsWith(`${productsPath}/`))
        ) {
          const conflict = z
            .object({ code: z.enum(["product_gtin_taken", "product_gtin_locked"]) })
            .safeParse(value);
          if (conflict.success) throw new UsClientError(conflict.data.code);
        }
        if (
          response.status === 503 &&
          path === profilePath &&
          method === "GET" &&
          z.object({ code: z.literal("traceability_profile_not_provisioned") }).safeParse(value)
            .success
        )
          throw new UsClientError("profile_not_provisioned");
        if (
          response.status === 403 &&
          z.object({ code: z.literal("party_archived") }).safeParse(value).success
        )
          throw new UsClientError("party_archived");
        const errors: Record<number, UsClientErrorCode> = {
          401: "session_required",
          403: "forbidden",
          409: "conflict",
          429: "rate_limited",
        };
        throw new UsClientError(
          errors[response.status] ?? (response.status >= 500 ? "unavailable" : "request_rejected"),
        );
      }
      return checked(schema, value, "invalid_response");
    } catch (error) {
      if (error instanceof UsClientError) throw error;
      throw new UsClientError("unavailable");
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  return {
    async searchTraceLots(input: unknown = {}): Promise<UsTraceSearchPage> {
      const query = checked(usTraceSearchQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({ limit: String(query.limit) });
      for (const key of [
        "q",
        "tlc",
        "tlcFrom",
        "tlcTo",
        "lotId",
        "productId",
        "productText",
        "sourceLocationId",
        "sourceReferenceValue",
        "eventType",
        "eventDateFrom",
        "eventDateTo",
        "locationId",
        "documentType",
        "documentNumber",
        "sscc",
        "status",
        "cursor",
      ] as const) {
        const value = query[key];
        if (value !== undefined) params.set(key, value);
      }
      if (query.tlcList !== null) params.set("tlcList", JSON.stringify(query.tlcList));
      return request(`${searchPath}?${params}`, usTraceSearchPageSchema);
    },
    async getLotCard(id: unknown): Promise<UsLotCard> {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${lotsPath}/${lotId}/card`, usLotCardSchema);
      if (result.lot.id !== lotId) throw new UsClientError("invalid_response");
      return result;
    },
    async listLotCardEvidence(id: unknown, input: unknown = {}): Promise<UsLotCardEvidencePage> {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(usLotCardEvidenceQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      return request(`${lotsPath}/${lotId}/card/evidence?${params}`, usLotCardEvidencePageSchema);
    },
    async readCurrentTrace(id: unknown, input: unknown = {}): Promise<UsCurrentTraceResult> {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(usCurrentTraceQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        direction: query.direction,
        maxDepth: String(query.maxDepth),
        maxNodes: String(query.maxNodes),
      });
      const result = await request(
        `${lotsPath}/${lotId}/trace?${params}`,
        usCurrentTraceResultSchema,
      );
      if (result.rootLotId !== lotId) throw new UsClientError("invalid_response");
      return result;
    },
    async listTraceHistory(id: unknown, input: unknown = {}): Promise<UsTraceHistoryPage> {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(usTraceHistoryQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      return request(`${lotsPath}/${lotId}/trace/history?${params}`, usTraceHistoryPageSchema);
    },
    async readReadiness(input: unknown = {}): Promise<UsReadinessResult> {
      const query = checked(usReadinessQuerySchema, input, "invalid_input");
      const params = new URLSearchParams();
      for (const key of ["eventDateFrom", "eventDateTo", "productId", "lotId"] as const) {
        const value = query[key];
        if (value !== undefined) params.set(key, value);
      }
      return request(`${readinessPath}${params.size ? `?${params}` : ""}`, usReadinessResultSchema);
    },
    async listEvents(input: unknown = {}) {
      const query = checked(usEventListQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        type: query.type,
        history: query.history,
        limit: String(query.limit),
        offset: String(query.offset),
      });
      if (query.status !== undefined) params.set("status", query.status);
      if (query.search !== undefined) params.set("search", query.search);
      const result = await request(`${eventsPath}?${params}`, usEventListSchema);
      if (result.limit !== query.limit || result.offset !== query.offset)
        throw new UsClientError("invalid_response");
      return result;
    },
    async listShipping(input: unknown = {}) {
      const query = checked(usEventListQuerySchema.omit({ type: true }), input, "invalid_input");
      const params = new URLSearchParams({
        type: "shipping",
        history: query.history,
        limit: String(query.limit),
        offset: String(query.offset),
      });
      if (query.status !== undefined) params.set("status", query.status);
      if (query.search !== undefined) params.set("search", query.search);
      const result = await request(`${eventsPath}?${params}`, usEventListSchema);
      if (
        result.limit !== query.limit ||
        result.offset !== query.offset ||
        result.items.some((item) => item.type !== "shipping")
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async getShipping(id: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${shippingPath}/${eventId}`, shippingHistoricalRecordSchema);
      if (result.id.toLowerCase() !== eventId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async getShippingBalance(lotIdInput: unknown, context: unknown = {}) {
      const lotId = checked(platformUuidSchema, lotIdInput, "invalid_input");
      const query = checked(shippingBalanceQuerySchema, context, "invalid_input");
      const suffix =
        "contextDraftId" in query
          ? `?contextDraftId=${query.contextDraftId}&expectedDraftVersion=${query.expectedDraftVersion}`
          : "";
      const result = await request(
        `/api/us/traceability/lots/${lotId}/shipping-balance${suffix}`,
        shippingBalanceResponseSchema,
      );
      if (result.lotId.toLowerCase() !== lotId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async createShipping(input: unknown) {
      const body = checked(createShippingDraftSchema, input, "invalid_input");
      return request(shippingPath, shippingDraftRecordSchema, "POST", body);
    },
    async saveShipping(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(saveShippingDraftSchema, input, "invalid_input");
      const result = await request(
        `${shippingPath}/${eventId}`,
        shippingDraftRecordSchema,
        "PUT",
        body,
      );
      if (result.id.toLowerCase() !== eventId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async checkShippingReadiness(id: unknown, expectedDraftVersion: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const version = checked(
        finalizeShippingSchema.shape.expectedDraftVersion,
        expectedDraftVersion,
        "invalid_input",
      );
      const result = await request(
        `${shippingPath}/${eventId}/readiness?expectedDraftVersion=${version}`,
        shippingReadinessSchema,
      );
      if (
        result.eventId.toLowerCase() !== eventId.toLowerCase() ||
        result.expectedDraftVersion !== version
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async finalizeShipping(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(finalizeShippingSchema, input, "invalid_input");
      const result = await request(
        `${shippingPath}/${eventId}/finalize`,
        shippingFinalizedRecordSchema,
        "POST",
        body,
      );
      if (result.id.toLowerCase() !== eventId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async amendShipping(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(amendShippingSchema, input, "invalid_input");
      const result = await request(
        `${shippingPath}/${eventId}/amend`,
        shippingLifecycleReceiptSchema,
        "POST",
        body,
      );
      if (
        result.command !== "shipping.amend" ||
        result.operationKey.toLowerCase() !== body.operationKey.toLowerCase() ||
        result.record.lifecycle?.previousRevisionId?.toLowerCase() !== eventId.toLowerCase() ||
        result.record.lifecycle?.pendingDraftId?.toLowerCase() !== result.eventId.toLowerCase()
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async voidShipping(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(voidShippingSchema, input, "invalid_input");
      const result = await request(
        `${shippingPath}/${eventId}/void`,
        shippingLifecycleReceiptSchema,
        "POST",
        body,
      );
      if (
        result.command !== "shipping.void" ||
        result.operationKey.toLowerCase() !== body.operationKey.toLowerCase() ||
        result.eventId.toLowerCase() !== eventId.toLowerCase()
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async listShippingRevisions(id: unknown, input: unknown = {}) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(shippingRevisionListQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      const result = await request(
        `${shippingPath}/${eventId}/revisions?${params}`,
        shippingRevisionListSchema,
      );
      if (
        result.limit !== query.limit ||
        result.offset !== query.offset ||
        result.items.some(
          (item) =>
            item.rootId.toLowerCase() !==
            (result.items[0]?.rootId.toLowerCase() ?? item.rootId.toLowerCase()),
        )
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async getTransformation(id: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(
        `${transformationPath}/${eventId}`,
        transformationHttpRecordSchema,
      );
      if (result.id.toLowerCase() !== eventId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async createTransformation(input: unknown) {
      const body = checked(createTransformationDraftSchema, input, "invalid_input");
      return request(transformationPath, transformationDraftRecordSchema, "POST", body);
    },
    async saveTransformation(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(saveTransformationDraftSchema, input, "invalid_input");
      const result = await request(
        `${transformationPath}/${eventId}`,
        transformationDraftRecordSchema,
        "PUT",
        body,
      );
      if (result.id.toLowerCase() !== eventId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async checkTransformationReadiness(id: unknown, expectedDraftVersion: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const version = checked(
        finalizeTransformationSchema.shape.expectedDraftVersion,
        expectedDraftVersion,
        "invalid_input",
      );
      const result = await request(
        `${transformationPath}/${eventId}/readiness?expectedDraftVersion=${version}`,
        transformationReadinessSchema,
      );
      if (
        result.eventId.toLowerCase() !== eventId.toLowerCase() ||
        result.expectedDraftVersion !== version
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async finalizeTransformation(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(finalizeTransformationSchema, input, "invalid_input");
      const result = await request(
        `${transformationPath}/${eventId}/finalize`,
        transformationFinalizedRecordSchema,
        "POST",
        body,
      );
      if (result.id.toLowerCase() !== eventId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async amendTransformation(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(amendTransformationSchema, input, "invalid_input");
      const result = await request(
        `${transformationPath}/${eventId}/amend`,
        transformationLifecycleReceiptSchema,
        "POST",
        body,
      );
      if (
        result.record.lifecycle?.previousRevisionId?.toLowerCase() !== eventId.toLowerCase() ||
        result.record.lifecycle?.currentEventId?.toLowerCase() !== eventId.toLowerCase() ||
        result.record.lifecycle?.pendingDraftId?.toLowerCase() !== result.eventId.toLowerCase() ||
        (result.record.revision === 2 &&
          result.record.lifecycle?.rootId.toLowerCase() !== eventId.toLowerCase()) ||
        result.operationKey.toLowerCase() !== body.operationKey.toLowerCase() ||
        result.command !== "transformation.amend"
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async voidTransformation(id: unknown, input: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(voidTransformationSchema, input, "invalid_input");
      const result = await request(
        `${transformationPath}/${eventId}/void`,
        transformationLifecycleReceiptSchema,
        "POST",
        body,
      );
      if (
        result.eventId.toLowerCase() !== eventId.toLowerCase() ||
        result.operationKey.toLowerCase() !== body.operationKey.toLowerCase() ||
        result.command !== "transformation.void"
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async listTransformationRevisions(id: unknown, input: unknown = {}) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(transformationRevisionListQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      const result = await request(
        `${transformationPath}/${eventId}/revisions?${params}`,
        transformationRevisionListSchema,
      );
      if (
        result.limit !== query.limit ||
        result.offset !== query.offset ||
        result.items.some(
          (item) =>
            item.rootId.toLowerCase() !==
            (result.items[0]?.rootId.toLowerCase() ?? item.rootId.toLowerCase()),
        )
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async queryTransformationGenealogy(input: unknown) {
      const body = checked(transformationGenealogyRequestSchema, input, "invalid_input");
      const result = await request(
        `${transformationPath}/genealogy/query`,
        transformationGenealogyResultSchema,
        "POST",
        body,
      );
      if (
        result.startLotId.toLowerCase() !== body.startLotId.toLowerCase() ||
        result.direction !== body.direction ||
        result.mode !== body.mode
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async listLotCases(id: unknown, input: unknown = {}) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(caseListQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        limit: String(query.limit),
        history: String(query.history),
      });
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const result = await request(`${casesPath}/${lotId}/cases?${params}`, caseListResultSchema);
      if (result.lotId.toLowerCase() !== lotId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async linkLotCases(id: unknown, input: unknown) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(caseLinkCommandSchema, input, "invalid_input");
      const result = await request(
        `${casesPath}/${lotId}/cases`,
        caseLinkResultSchema,
        "POST",
        body,
      );
      if (result.lotId.toLowerCase() !== lotId.toLowerCase())
        throw new UsClientError("invalid_response");
      return result;
    },
    async unlinkLotCase(id: unknown, linkId: unknown, input: unknown) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const caseLinkId = checked(platformUuidSchema, linkId, "invalid_input");
      const body = checked(caseUnlinkCommandSchema, input, "invalid_input");
      const result = await request(
        `${casesPath}/${lotId}/cases/${caseLinkId}/unlink`,
        caseUnlinkResultSchema,
        "POST",
        body,
      );
      if (
        result.lotId.toLowerCase() !== lotId.toLowerCase() ||
        result.linkId.toLowerCase() !== caseLinkId.toLowerCase()
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async exportReceivingCsv(captured: unknown) {
      const selected = checked(receivingLiveRecordSchema, captured, "invalid_input");
      const eventId = selected.id.toLowerCase();
      const filename = `markiro-receiving-${eventId}-r${selected.revision}-d${selected.draftVersion}-l${selected.lifecycle.lifecycleVersion}.csv`;
      const path = `${receivingPath}/${eventId}/export.csv?expectedDraftVersion=${selected.draftVersion}&expectedLifecycleVersion=${selected.lifecycle.lifecycleVersion}`;
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await send(path, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 409) throw new UsClientError("receiving_export_stale");
          if (response.status === 422) throw new UsClientError("export_value_too_large");
          const errors: Record<number, UsClientErrorCode> = {
            401: "session_required",
            403: "forbidden",
            429: "rate_limited",
          };
          throw new UsClientError(
            errors[response.status] ??
              (response.status >= 500 ? "unavailable" : "request_rejected"),
          );
        }
        if (
          response.headers.get("Content-Type")?.toLowerCase() !== "text/csv; charset=utf-8" ||
          response.headers.get("Content-Disposition") !== `attachment; filename="${filename}"`
        )
          throw new UsClientError("invalid_response");
        const digest = response.headers.get("X-Markiro-Export-SHA256");
        if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new UsClientError("invalid_response");
        const bytes = await readBoundedReceivingExport(response);
        const digestInput = new Uint8Array(new ArrayBuffer(bytes.byteLength));
        digestInput.set(bytes);
        const actualDigest = Array.from(
          new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", digestInput)),
        )
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        if (actualDigest !== digest) throw new UsClientError("invalid_response");
        const decoded = decodeReceivingCsvExport(bytes);
        if (
          decoded.record.id.toLowerCase() !== eventId ||
          decoded.record.revision !== selected.revision ||
          decoded.record.draftVersion !== selected.draftVersion ||
          decoded.record.lifecycle.lifecycleVersion !== selected.lifecycle.lifecycleVersion
        )
          throw new UsClientError("invalid_response");
        return { bytes, filename };
      } catch (error) {
        if (error instanceof UsClientError) throw error;
        throw new UsClientError(
          controller.signal.aborted || error instanceof TypeError
            ? "unavailable"
            : "invalid_response",
        );
      } finally {
        globalThis.clearTimeout(timeout);
      }
    },
    async previewReceivingCsv(input: unknown) {
      const body = checked(receivingCsvPreviewInputSchema, input, "invalid_input");
      const captured = structuredClone(input);
      const result = await request(
        `${receivingCsvPath}/preview`,
        receivingCsvPreviewSchema,
        "POST",
        captured,
      );
      try {
        if (await matchesReceivingCsvPreview(result, body)) return result;
      } catch {
        /* Sanitized below; no raw bytes or decoder cause retained. */
      }
      throw new UsClientError("invalid_response");
    },
    async getReceivingCsvPreview(id: unknown) {
      const importId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${receivingCsvPath}/${importId}`, receivingCsvPreviewSchema);
      if (result.id.toLowerCase() !== importId) throw new UsClientError("invalid_response");
      return result;
    },
    async applyReceivingCsv(id: unknown, input: unknown) {
      const importId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(receivingCsvApplyInputSchema, input, "invalid_input");
      const result = await request(
        `${receivingCsvPath}/${importId}/apply`,
        receivingCsvApplyResponseSchema,
        "POST",
        body,
      );
      if (!matchesReceivingCsvApplyResponse(result, { importId, ...body }))
        throw new UsClientError("invalid_response");
      return result;
    },
    async finalizeReceiving(id: unknown, input: unknown, captured?: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(finalizeReceivingCommandSchema, input, "invalid_input");
      const before =
        "commandVersion" in body ? captureReceivingContext(eventId, body, captured) : undefined;
      const result = await request(
        `${receivingPath}/${eventId}/finalize`,
        receivingFinalizeResultSchema,
        "POST",
        body,
      );
      if (!(await matchesReceivingFinalizeAcknowledgement(result, eventId, body, before)))
        throw new UsClientError("invalid_response");
      return result;
    },
    async amendReceiving(id: unknown, input: unknown, captured: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(amendReceivingSchema, input, "invalid_input");
      const before = captureReceivingContext(eventId, body, captured);
      const result = await request(
        `${receivingPath}/${eventId}/amend`,
        receivingOperationReceiptV2Schema,
        "POST",
        body,
      );
      if (!(await matchesReceivingAmendAcknowledgement(result, eventId, body, before)))
        throw new UsClientError("invalid_response");
      return result;
    },
    async voidReceiving(id: unknown, input: unknown, captured: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(voidReceivingSchema, input, "invalid_input");
      const before = captureReceivingContext(eventId, body, captured);
      const result = await request(
        `${receivingPath}/${eventId}/void`,
        receivingOperationReceiptV2Schema,
        "POST",
        body,
      );
      if (!(await matchesReceivingVoidAcknowledgement(result, eventId, body, before)))
        throw new UsClientError("invalid_response");
      return result;
    },
    async listReceivingRevisions(id: unknown, input: unknown = {}) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(receivingRevisionListQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      const result = await request(
        `${receivingPath}/${eventId}/revisions?${params}`,
        receivingRevisionListSchema,
      );
      if (result.limit !== query.limit || result.offset !== query.offset)
        throw new UsClientError("invalid_response");
      return result;
    },
    async getLotReceivingBasis(id: unknown, input: unknown = {}) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(receivingBasisQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      const result = await request(
        `${lotsPath}/${lotId}/receiving-basis?${params}`,
        receivingBasisSchema,
      );
      if (
        result.lotId.toLowerCase() !== lotId ||
        result.limit !== query.limit ||
        result.offset !== query.offset
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async listReceivingRecords(input: unknown = {}) {
      const query = checked(listReceivingLiveRecordsQuerySchema, input, "invalid_input");
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return request(`${receivingPath}?${params}`, receivingLiveRecordListSchema);
    },
    async getReceivingRecord(id: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${receivingPath}/${eventId}`, receivingLiveRecordSchema);
      if (result.id.toLowerCase() !== eventId) throw new UsClientError("invalid_response");
      return result;
    },
    async checkReceivingReadiness(id: unknown, expectedDraftVersion: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const query = checked(
        receivingReadinessQuerySchema,
        { expectedDraftVersion },
        "invalid_input",
      );
      const result = await request(
        `${receivingPath}/${eventId}/readiness?${new URLSearchParams({ expectedDraftVersion: String(query.expectedDraftVersion) })}`,
        receivingRevisionReadinessSchema,
      );
      if (
        result.eventId.toLowerCase() !== eventId ||
        result.draftVersion !== query.expectedDraftVersion
      )
        throw new UsClientError("invalid_response");
      return result;
    },
    async listReceivingDrafts(input: unknown = {}) {
      const query = checked(listReceivingDraftsQuerySchema, input, "invalid_input");
      const params = new URLSearchParams({ status: "draft", history: "current" });
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return request(`${receivingPath}?${params}`, receivingLiveRecordListSchema);
    },
    async getReceivingDraft(id: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${receivingPath}/${eventId}`, receivingLiveRecordSchema);
      if (result.id.toLowerCase() !== eventId || result.status !== "draft")
        throw new UsClientError("invalid_response");
      return result;
    },
    async createReceivingDraft(input: unknown) {
      const body = checked(createReceivingDraftSchema, input, "invalid_input");
      const result = await request(receivingPath, receivingCreateResultSchema, "POST", body);
      if (!(await matchesReceivingCreateAcknowledgement(result, body)))
        throw new UsClientError("invalid_response");
      return result;
    },
    async saveReceivingDraft(id: unknown, input: unknown, captured?: unknown) {
      const eventId = checked(platformUuidSchema, id, "invalid_input");
      const body = checked(saveReceivingCommandSchema, input, "invalid_input");
      const before =
        "commandVersion" in body ? captureReceivingContext(eventId, body, captured) : undefined;
      const result = await request(
        `${receivingPath}/${eventId}`,
        receivingSaveResultSchema,
        "PUT",
        body,
      );
      if (!(await matchesReceivingSaveAcknowledgement(result, eventId, body, before)))
        throw new UsClientError("invalid_response");
      return result;
    },
    async listReferenceDocuments(input: unknown = {}) {
      const query = checked(listReferenceDocumentsQuerySchema, input, "invalid_input");
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return request(`${documentsPath}?${params}`, referenceDocumentListSchema);
    },
    async getReferenceDocument(id: unknown) {
      const documentId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${documentsPath}/${documentId}`, referenceDocumentSchema);
      if (result.id.toLowerCase() !== documentId) throw new UsClientError("invalid_response");
      return result;
    },
    async createReferenceDocument(input: unknown) {
      return request(
        documentsPath,
        referenceDocumentSchema,
        "POST",
        checked(referenceDocumentInputSchema, input, "invalid_input"),
      );
    },
    async listLots(input: unknown = {}) {
      const query = checked(listTraceabilityLotsQuerySchema, input, "invalid_input");
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      return request(`${lotsPath}?${params}`, traceabilityLotListSchema);
    },
    async getLot(id: unknown) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(`${lotsPath}/${lotId}`, traceabilityLotSchema);
      if (result.id !== lotId) throw new UsClientError("invalid_response");
      return result;
    },
    async createLot(input: unknown) {
      const body = checked(createTraceabilityLotSchema, input, "invalid_input");
      const result = await request(lotsPath, traceabilityLotSchema, "POST", body);
      if (result.productId !== body.productId || result.tlc !== body.tlc)
        throw new UsClientError("invalid_response");
      return result;
    },
    async changeLotSource(id: unknown, input: unknown) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(
        `${lotsPath}/${lotId}/source`,
        traceabilityLotSchema,
        "PATCH",
        checked(patchLotSourceSchema, input, "invalid_input"),
      );
      if (result.id !== lotId) throw new UsClientError("invalid_response");
      return result;
    },
    async changeLotStatus(id: unknown, input: unknown) {
      const lotId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(
        `${lotsPath}/${lotId}/status`,
        traceabilityLotSchema,
        "POST",
        checked(postLotStatusSchema, input, "invalid_input"),
      );
      if (result.id !== lotId) throw new UsClientError("invalid_response");
      return result;
    },
    async getProductProfile(id: unknown) {
      const productId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(
        `/api/us/traceability/products/${productId}`,
        productTraceabilityProfileSchema,
      );
      if (result.productId !== productId) throw new UsClientError("invalid_response");
      return result;
    },
    async putProductProfile(id: unknown, input: unknown) {
      const productId = checked(platformUuidSchema, id, "invalid_input");
      const result = await request(
        `/api/us/traceability/products/${productId}`,
        productTraceabilityProfileSchema,
        "PUT",
        checked(putProductTraceabilityProfileSchema, input, "invalid_input"),
      );
      if (result.productId !== productId) throw new UsClientError("invalid_response");
      return result;
    },
    async listProducts(input: unknown = {}) {
      const query = checked(listUsProductsQuerySchema, input, "invalid_input");
      return request(`${productsPath}?${masterDataQuery(query)}`, usProductListSchema);
    },
    async getProduct(id: unknown) {
      return request(
        `${productsPath}/${checked(platformUuidSchema, id, "invalid_input")}`,
        usProductSchema,
      );
    },
    async createProduct(input: unknown) {
      return request(
        productsPath,
        usProductSchema,
        "POST",
        checked(createUsProductSchema, input, "invalid_input"),
      );
    },
    async updateProduct(id: unknown, input: unknown) {
      return request(
        `${productsPath}/${checked(platformUuidSchema, id, "invalid_input")}`,
        usProductSchema,
        "PATCH",
        checked(updateUsProductSchema, input, "invalid_input"),
      );
    },
    deployment: () => request("/api/us/deployment", deploymentSchema),
    async session() {
      const data = await request("/api/us-auth/get-session", sessionSchema);
      return data
        ? { user: data.user, activeOrganizationId: data.session.activeOrganizationId ?? null }
        : null;
    },
    async signIn(input: unknown) {
      const body = checked(
        z.object({ email: z.email(), password: passwordSchema }).strict(),
        input,
        "invalid_input",
      );
      return request("/api/us-auth/sign-in/email", signedInSchema, "POST", body);
    },
    async enroll(input: unknown) {
      const body = checked(z.object({ password: passwordSchema }).strict(), input, "invalid_input");
      return request("/api/us-auth/two-factor/enable", enrollmentSchema, "POST", body);
    },
    async verifyTotp(input: unknown) {
      const body = checked(
        z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
        input,
        "invalid_input",
      );
      return request("/api/us-auth/two-factor/verify-totp", verificationSchema, "POST", body);
    },
    async verifyBackupCode(input: unknown) {
      const body = checked(
        z.object({ code: z.string().min(1).max(128) }).strict(),
        input,
        "invalid_input",
      );
      return request(
        "/api/us-auth/two-factor/verify-backup-code",
        verificationSchema,
        "POST",
        body,
      );
    },
    organizations: () => request("/api/us-auth/organization/list", z.array(organizationSchema)),
    async selectOrganization(input: unknown) {
      const body = checked(
        z.object({ organizationId: z.string().min(1).max(256) }).strict(),
        input,
        "invalid_input",
      );
      await request("/api/us-auth/organization/set-active", organizationSchema, "POST", body);
    },
    async signOut() {
      await request("/api/us-auth/sign-out", z.object({ success: z.literal(true) }), "POST", {});
    },
    profile: () => request(profilePath, usTraceabilityProfileSummarySchema),
    access: () => request(accessPath, usTraceabilityAccessSchema),
    async provisionProfile(input: unknown) {
      return request(
        profilePath,
        usTraceabilityProfileSummarySchema,
        "PUT",
        checked(provisionUsTraceabilityProfileSchema, input, "invalid_input"),
      );
    },
    async listParties(input: unknown = {}) {
      const query = checked(listUsPartiesQuerySchema, input, "invalid_input");
      return request(`${partiesPath}?${masterDataQuery(query)}`, usPartyListSchema);
    },
    async getParty(id: unknown) {
      return request(
        `${partiesPath}/${checked(platformUuidSchema, id, "invalid_input")}`,
        usPartySchema,
      );
    },
    async createParty(input: unknown) {
      return request(
        partiesPath,
        usPartySchema,
        "POST",
        checked(createUsPartySchema, input, "invalid_input"),
      );
    },
    async updateParty(id: unknown, input: unknown) {
      return request(
        `${partiesPath}/${checked(platformUuidSchema, id, "invalid_input")}`,
        usPartySchema,
        "PATCH",
        checked(updateUsPartySchema, input, "invalid_input"),
      );
    },
    async listLocations(input: unknown = {}) {
      const query = checked(listUsLocationsQuerySchema, input, "invalid_input");
      return request(`${locationsPath}?${masterDataQuery(query)}`, usLocationListSchema);
    },
    async getLocation(id: unknown) {
      return request(
        `${locationsPath}/${checked(platformUuidSchema, id, "invalid_input")}`,
        usLocationSchema,
      );
    },
    async createLocation(input: unknown) {
      return request(
        locationsPath,
        usLocationSchema,
        "POST",
        checked(createUsLocationSchema, input, "invalid_input"),
      );
    },
    async updateLocation(id: unknown, input: unknown) {
      return request(
        `${locationsPath}/${checked(platformUuidSchema, id, "invalid_input")}`,
        usLocationSchema,
        "PATCH",
        checked(updateUsLocationSchema, input, "invalid_input"),
      );
    },
  };
}

export type UsBrowserClient = ReturnType<typeof createUsBrowserClient>;
