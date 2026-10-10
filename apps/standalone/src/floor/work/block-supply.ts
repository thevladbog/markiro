import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { SsccBlock, SsccBlockRequest } from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { BOX_EXTENSION } from "./box-close.js";

export interface BlockContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** The shift's snapshot's issuer prefix: the blocks of a box are of it. */
  issuerPrefix: string;
  /** The link is `online` right now: only then is the host asked. */
  online: () => boolean;
  /** `HostApi.requestSsccBlock`. */
  requestBlock: (request: SsccBlockRequest) => Promise<SsccBlock>;
  /** A failed host call the shell may act on: a refused key, another certificate. */
  onHostError: (error: unknown) => void;
  now: () => Date;
  newId: () => string;
}

/**
 * How a top-up went: `enough` — the newest block still has half its serials,
 * nothing asked; `stored` — a block arrived and is kept; `offline` — a block
 * is needed (or a request waits) and the link is not online; `exhausted` —
 * the host has no serials left for the prefix; `failed` — no answer, or one
 * this station does not keep: a request the host may have answered stays in
 * `floor_block_requests` and is repeated as it is, next time.
 */
export type SupplyResult =
  | { kind: "enough" }
  | { kind: "stored"; blockId: string }
  | { kind: "offline" }
  | { kind: "exhausted" }
  | { kind: "failed" };

const remainingRow = z.object({ n: z.number().int().nonnegative() });

/** The serials this pairing still has for the prefix and the extension, in all its blocks. */
export async function remainingSerials(
  local: LocalExecutor,
  pairing: Pairing,
  issuerPrefix: string,
  extension: number = BOX_EXTENSION,
): Promise<number> {
  const [row] = await local.query(
    "SELECT coalesce(sum(to_serial + 1 - next_serial), 0) AS n FROM floor_sscc_blocks " +
      "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ?",
    [pairing.hostId, pairing.deviceId, issuerPrefix, extension],
    remainingRow,
  );
  return row?.n ?? 0;
}

const newestRow = z.object({
  from_serial: z.number().int(),
  to_serial: z.number().int(),
  next_serial: z.number().int(),
});
const requestRow = z.object({
  request_id: z.string(),
  issuer_prefix: z.string(),
  extension: z.number().int(),
});

/**
 * The half rule (stage 2a spec §5.7.4, decision 9): a block is wanted when
 * the station has none for the prefix, or the newest has less than half of
 * its serials left.
 */
async function blockWanted(context: BlockContext): Promise<boolean> {
  const { local, pairing, issuerPrefix } = context;
  const [newest] = await local.query(
    "SELECT from_serial, to_serial, next_serial FROM floor_sscc_blocks " +
      "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? " +
      "ORDER BY from_serial DESC LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, BOX_EXTENSION],
    newestRow,
  );
  if (newest === undefined) return true;
  const size = newest.to_serial - newest.from_serial + 1;
  const left = newest.to_serial + 1 - newest.next_serial;
  return left * 2 < size;
}

/** The request this pairing keeps for the prefix and has no answer to, oldest first. */
async function waitingRequest(context: BlockContext): Promise<SsccBlockRequest | null> {
  const { local, pairing, issuerPrefix } = context;
  const [row] = await local.query(
    "SELECT request_id, issuer_prefix, extension FROM floor_block_requests " +
      "WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? " +
      "ORDER BY requested_at, request_id LIMIT 1",
    [pairing.hostId, pairing.deviceId, issuerPrefix, BOX_EXTENSION],
    requestRow,
  );
  return row === undefined
    ? null
    : { requestId: row.request_id, issuerPrefix: row.issuer_prefix, extension: row.extension };
}

const sharedRow = z.object({ n: z.literal(1) });

/**
 * Whether a block this pairing keeps for the prefix and extension, other than
 * this one, has a serial in common with it. The host numbers its blocks from
 * a counter that only grows, so the answer is no; if it ever is yes (a host
 * restored from a backup, a counter set back) the new block would hand out
 * serials a box may already carry.
 */
async function sharesSerials(context: BlockContext, block: SsccBlock): Promise<boolean> {
  const { pairing } = context;
  const [row] = await context.local.query(
    "SELECT 1 AS n FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
      "AND issuer_prefix = ? AND extension = ? AND block_id <> ? " +
      "AND from_serial <= ? AND to_serial >= ? LIMIT 1",
    [
      pairing.hostId,
      pairing.deviceId,
      block.issuerPrefix,
      block.extension,
      block.id,
      block.toSerial,
      block.fromSerial,
    ],
    sharedRow,
  );
  return row !== undefined;
}

/** A new request, kept before it is sent: a retry after a failure or a restart repeats it. */
async function keepRequest(context: BlockContext): Promise<SsccBlockRequest> {
  const request: SsccBlockRequest = {
    requestId: context.newId(),
    issuerPrefix: context.issuerPrefix,
    extension: BOX_EXTENSION,
  };
  await context.local.transaction([
    {
      sql:
        "INSERT INTO floor_block_requests (request_id, host_id, device_id, issuer_prefix, " +
        "extension, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
      values: [
        request.requestId,
        context.pairing.hostId,
        context.pairing.deviceId,
        request.issuerPrefix,
        request.extension,
        context.now().toISOString(),
      ],
      expectedChanges: 1,
    },
  ]);
  return request;
}

async function dropRequest(context: BlockContext, requestId: string): Promise<void> {
  await context.local.transaction([
    { sql: "DELETE FROM floor_block_requests WHERE request_id = ?", values: [requestId] },
  ]);
}

/**
 * The block, kept in the transaction that removes its request: a request is
 * never gone without its block, and a block is filed only under the prefix
 * and extension the request named.
 */
async function storeBlock(
  context: BlockContext,
  request: SsccBlockRequest,
  block: SsccBlock,
): Promise<void> {
  await context.local.transaction([
    {
      sql:
        "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, " +
        "from_serial, to_serial, next_serial, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (block_id) DO NOTHING",
      values: [
        block.id,
        context.pairing.hostId,
        context.pairing.deviceId,
        request.issuerPrefix,
        request.extension,
        block.fromSerial,
        block.toSerial,
        block.fromSerial,
        context.now().toISOString(),
      ],
    },
    {
      sql: "DELETE FROM floor_block_requests WHERE request_id = ?",
      values: [request.requestId],
      expectedChanges: 1,
    },
  ]);
}

/**
 * The supply of SSCC serials for a shift's boxes (stage 2a spec §5.7.4): when
 * the work screen opens, after every close and when the link comes back, a
 * block is asked for by the half rule, while the link is online. A request
 * is kept before it is sent and repeated whole until its block is kept, so
 * the host never issues a second block for one need. One top-up runs at a
 * time; a call while one runs shares it. A request the host refuses as
 * another prefix's (`validation_failed` on `requestId`, plan 2a1's final
 * wave) is dropped and a new one sent, once; `sscc_exhausted` drops it. A
 * failed write of this computer rejects.
 */
export function createBlockSupply(context: BlockContext): { topUp: () => Promise<SupplyResult> } {
  const attempt = async (fresh: boolean): Promise<SupplyResult> => {
    const waiting = await waitingRequest(context);
    if (waiting === null && !(await blockWanted(context))) return { kind: "enough" };
    if (!context.online()) return { kind: "offline" };
    const request = waiting ?? (await keepRequest(context));
    let block: SsccBlock;
    try {
      block = await context.requestBlock(request);
    } catch (error) {
      if (error instanceof HostError && error.kind === "api") {
        if (error.code === "sscc_exhausted") {
          await dropRequest(context, request.requestId);
          return { kind: "exhausted" };
        }
        if (error.code === "validation_failed") {
          // The host will never answer this request otherwise.
          await dropRequest(context, request.requestId);
          if (error.field === "requestId" && fresh) return attempt(false);
          return { kind: "failed" };
        }
      }
      context.onHostError(error);
      return { kind: "failed" };
    }
    if (
      block.issuerPrefix !== request.issuerPrefix ||
      block.extension !== request.extension ||
      block.toSerial < block.fromSerial ||
      (await sharesSerials(context, block))
    ) {
      // Not the block asked for, or one that shares serials with a block kept
      // (a serial would label two boxes): never filed, and never asked for again.
      await dropRequest(context, request.requestId);
      return { kind: "failed" };
    }
    await storeBlock(context, request, block);
    return { kind: "stored", blockId: block.id };
  };
  let running: Promise<SupplyResult> | null = null;
  return {
    topUp: () => {
      if (running !== null) return running;
      const run = attempt(true).finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
  };
}
