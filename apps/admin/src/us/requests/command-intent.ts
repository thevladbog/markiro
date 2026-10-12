import {
  platformUuidSchema,
  usRequestPrepareHttpBodySchema,
  type UsRequestPrepareHttpBody,
  usRequestRetryHttpBodySchema,
  type UsRequestRetryHttpBody,
} from "@markiro/platform-contracts";

export type RequestPrepareIntent = {
  requestId: string;
  body: Readonly<UsRequestPrepareHttpBody>;
  status: "pending" | "ambiguous" | "accepted";
};
export function makeRequestPrepareIntent(
  requestId: string,
  revision: number,
  digest: string,
  mode: UsRequestPrepareHttpBody["mode"],
  key: string,
): RequestPrepareIntent {
  platformUuidSchema.parse(requestId);
  const body = usRequestPrepareHttpBodySchema.parse({
    mode,
    expectedRevision: revision,
    validationDigest: digest,
    idempotencyKey: key,
  });
  return { requestId, body: Object.freeze(body), status: "pending" };
}

export type RequestRetryIntent = {
  runId: string;
  body: Readonly<UsRequestRetryHttpBody>;
  status: "pending" | "ambiguous" | "accepted";
};
export function makeRequestRetryIntent(
  runId: string,
  lifecycleVersion: number,
  reason: string,
  key: string,
): RequestRetryIntent {
  platformUuidSchema.parse(runId);
  const body = usRequestRetryHttpBodySchema.parse({
    expectedLifecycleVersion: lifecycleVersion,
    reason,
    idempotencyKey: key,
  });
  return { runId, body: Object.freeze(body), status: "pending" };
}
