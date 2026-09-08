import { z } from "zod";
import {
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
} from "@markiro/platform-contracts";
import {
  matchesReceivingCreateAcknowledgement,
  matchesReceivingSaveAcknowledgement,
  matchesReceivingFinalizeAcknowledgement,
  matchesReceivingAmendAcknowledgement,
  matchesReceivingVoidAcknowledgement,
} from "./receiving/command-acknowledgement.js";

export type UsClientErrorCode =
  | ReceivingLifecycleError["code"]
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

/** Safe translation key only. Never retain a raw response, payload or error cause. */
export class UsClientError extends Error {
  constructor(readonly code: UsClientErrorCode) {
    super(code);
    this.name = "UsClientError";
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
const receivingPath = "/api/us/traceability/receiving";
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
        if (response.status === 409 && (path === lotsPath || path.startsWith(`${lotsPath}/`))) {
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
