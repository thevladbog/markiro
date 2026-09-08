import {
  receivingLiveRecordSchema,
  receivingRecordSchema,
  receivingRecordListSchema,
  receivingReadinessSchema,
  type ReceivingRecord,
} from "@markiro/platform-contracts";

export function liveFixture(record: ReceivingRecord) {
  const lifecycle = {
    rootId: record.id,
    lifecycleVersion: record.status === "draft" ? 1 : 2,
    previousRevisionId: null,
    supersededByEventId: null,
    currentEventId: record.status === "finalized" ? record.id : null,
    pendingDraftId: record.status === "draft" ? record.id : null,
    amendmentReason: null,
    supersededAt: null,
    supersededBy: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  };
  if (record.status === "draft") {
    const { draft, ...header } = record;
    return receivingLiveRecordSchema.parse({
      ...header,
      recordVersion: 2,
      lifecycle,
      content: { kind: "draft", draft },
    });
  }
  const { snapshot, finalizedAt, finalizedBy, ...header } = record;
  return receivingLiveRecordSchema.parse({
    ...header,
    recordVersion: 2,
    lifecycle,
    content: { kind: "finalized", snapshot, finalizedAt, finalizedBy },
  });
}

/** Migrate only read specimens; frozen historical command acknowledgements stay untouched. */
export async function liveReadFixtureResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
) {
  const url = input instanceof Request ? input.url : String(input);
  if (init?.method !== "GET" || !response.ok || !url.startsWith("/api/us/traceability/receiving"))
    return response;
  const value: unknown = await response.clone().json();
  const record = receivingRecordSchema.safeParse(value);
  if (record.success) return Response.json(liveFixture(record.data));
  const readiness = receivingReadinessSchema.safeParse(value);
  if (readiness.success)
    return Response.json({
      ...readiness.data,
      ruleVersion: "receiving-readiness-v4",
      rootId: readiness.data.eventId,
      expectedLifecycleVersion: 1,
      previousRevisionId: null,
    });
  const list = receivingRecordListSchema.safeParse(value);
  if (list.success)
    return Response.json({
      ...list.data,
      items: list.data.items.map((item) => ({
        ...item,
        recordVersion: 2,
        lifecycle: {
          rootId: item.id,
          lifecycleVersion: item.status === "draft" ? 1 : 2,
          previousRevisionId: null,
          supersededByEventId: null,
          currentEventId: item.status === "finalized" ? item.id : null,
          pendingDraftId: item.status === "draft" ? item.id : null,
          amendmentReason: null,
          supersededAt: null,
          supersededBy: null,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        },
      })),
    });
  return response;
}
