import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { PublicApiAuthService } from "./public-api-auth.service";
import {
  PublicApiAdmissionService,
  PUBLIC_API_OPERATIONS,
  type PublicApiOperation,
} from "./public-api-admission.service";
import type { PublicApiPrincipal, PublicApiTransaction } from "./public-api.types";

export function publicRequestDigest(payload: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`;
    throw new BadRequestException("Invalid canonical public request");
  };
  return createHash("sha256").update(canonical(payload)).digest("hex");
}
export interface PublicApiOwnerRequest {
  readonly actor: { domain: "api_key"; keyId: string };
  readonly effectId: string;
  assertBinding(tenantId: string, operation: PublicApiOperation, payload: unknown): void;
  run<T>(
    tx: PublicApiTransaction,
    parse: (value: unknown) => T,
    action: () => Promise<T>,
  ): Promise<T>;
  replay<T>(parse: (value: unknown) => T): Promise<T | null>;
  stageObject(key: string): Promise<void>;
}
type Receipt = typeof schema.publicApiRequestReceipts.$inferSelect;
@Injectable()
export class PublicApiRequestService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: PublicApiAuthService,
    private readonly admission: PublicApiAdmissionService,
  ) {}
  async prepare(
    principal: PublicApiPrincipal,
    operation: PublicApiOperation,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<PublicApiOwnerRequest> {
    if (
      !idempotencyKey ||
      idempotencyKey.length > 200 ||
      [...idempotencyKey].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new BadRequestException("Idempotency-Key required (1-200 printable characters)");
    const payloadDigest = publicRequestDigest(payload);
    const receipt = await this.db.transaction(async (tx) => {
      await this.auth.assertCurrent(tx, principal, PUBLIC_API_OPERATIONS[operation].scope);
      await this.admission.assertAllowed(tx, principal.tenantId, operation);
      await tx
        .insert(schema.publicApiRequestReceipts)
        .values({
          tenantId: principal.tenantId,
          keyId: principal.keyId,
          operation,
          idempotencyKey,
          payloadDigest,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(schema.publicApiRequestReceipts)
        .where(
          and(
            eq(schema.publicApiRequestReceipts.tenantId, principal.tenantId),
            eq(schema.publicApiRequestReceipts.keyId, principal.keyId),
            eq(schema.publicApiRequestReceipts.operation, operation),
            eq(schema.publicApiRequestReceipts.idempotencyKey, idempotencyKey),
          ),
        )
        .for("update");
      if (!row || row.payloadDigest !== payloadDigest)
        throw new ConflictException("Idempotency-Key payload conflict");
      return row;
    });
    const lock = async (tx: PublicApiTransaction) => {
      await this.auth.assertCurrent(tx, principal, PUBLIC_API_OPERATIONS[operation].scope);
      const provenance = await this.admission.assertAllowed(tx, principal.tenantId, operation);
      const row = await this.lockReceipt(tx, receipt);
      return { row, provenance };
    };
    return {
      actor: { domain: "api_key", keyId: principal.keyId },
      effectId: receipt.effectId,
      assertBinding(tenantId, expectedOperation, expectedPayload) {
        if (
          tenantId !== principal.tenantId ||
          operation !== expectedOperation ||
          publicRequestDigest(expectedPayload) !== payloadDigest
        )
          throw new ForbiddenException("Public owner binding mismatch");
      },
      run: async <T>(
        tx: PublicApiTransaction,
        parse: (value: unknown) => T,
        action: () => Promise<T>,
      ) => {
        const { row } = await lock(tx);
        if (row.state === "completed") return parse(row.response);
        const result = parse(await action());
        // Parsing/storage reads inside existing owners can cross an expiry boundary.
        // Revalidate on this same connection before publishing receipt+effect.
        const { provenance } = await lock(tx);
        await tx
          .update(schema.publicApiRequestReceipts)
          .set({
            state: "completed",
            response: result,
            admission: provenance,
            completedAt: new Date(),
          })
          .where(eq(schema.publicApiRequestReceipts.id, row.id));
        return result;
      },
      replay: async <T>(parse: (value: unknown) => T) =>
        this.db.transaction(async (tx) => {
          const { row } = await lock(tx);
          return row.state === "completed" ? parse(row.response) : null;
        }),
      stageObject: async (key: string) =>
        this.db.transaction(async (tx) => {
          const { row } = await lock(tx);
          if (row.stagedObjectKey !== null && row.stagedObjectKey !== key)
            throw new ConflictException("Staged object identity conflict");
          if (row.state === "pending")
            await tx
              .update(schema.publicApiRequestReceipts)
              .set({ stagedObjectKey: key })
              .where(eq(schema.publicApiRequestReceipts.id, row.id));
        }),
    };
  }
  private async lockReceipt(tx: PublicApiTransaction, expected: Receipt): Promise<Receipt> {
    const [row] = await tx
      .select()
      .from(schema.publicApiRequestReceipts)
      .where(
        and(
          eq(schema.publicApiRequestReceipts.id, expected.id),
          eq(schema.publicApiRequestReceipts.tenantId, expected.tenantId),
          eq(schema.publicApiRequestReceipts.keyId, expected.keyId),
        ),
      )
      .for("update");
    if (
      !row ||
      row.payloadDigest !== expected.payloadDigest ||
      row.operation !== expected.operation
    )
      throw new ConflictException("Public request identity changed");
    return row;
  }
}
