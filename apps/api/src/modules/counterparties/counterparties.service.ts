import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { BOX_EXTENSION_DIGIT, deriveIssuerPrefix } from "../sscc/sscc.service";
import type {
  CounterpartyDto,
  CreateCounterpartyDto,
  ListCounterpartiesResponseDto,
  SsccCounterDto,
  UpdateCounterpartyDto,
} from "./dto";

@Injectable()
export class CounterpartiesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** List all counterparties for a tenant. */
  async listCounterparties(tenantId: string): Promise<ListCounterpartiesResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.counterparties)
      .where(eq(schema.counterparties.tenantId, tenantId));

    return {
      items: rows.map((row) => this.rowToDto(row)),
    };
  }

  /** Get a single counterparty by id (must belong to the tenant). */
  async getCounterparty(tenantId: string, id: string): Promise<CounterpartyDto> {
    const [row] = await this.db
      .select()
      .from(schema.counterparties)
      .where(and(eq(schema.counterparties.tenantId, tenantId), eq(schema.counterparties.id, id)));

    if (!row) {
      throw new NotFoundException();
    }

    return this.rowToDto(row);
  }

  /** Create a counterparty. */
  async createCounterparty(
    tenantId: string,
    data: CreateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    const [row] = await this.db
      .insert(schema.counterparties)
      .values({
        tenantId,
        name: data.name,
        gln: data.gln,
        inn: data.inn ?? null,
        gs1Prefixes: data.gs1Prefixes ?? [],
        notes: data.notes ?? null,
      })
      .returning();

    if (!row) {
      throw new InternalServerErrorException("Failed to create counterparty");
    }

    return this.rowToDto(row);
  }

  /** Update a counterparty (partial update, preserves untouched fields). */
  async updateCounterparty(
    tenantId: string,
    id: string,
    data: UpdateCounterpartyDto,
  ): Promise<CounterpartyDto> {
    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) setClause.name = data.name;
    if (data.gln !== undefined) setClause.gln = data.gln;
    if (data.inn !== undefined) setClause.inn = data.inn;
    if (data.gs1Prefixes !== undefined) setClause.gs1Prefixes = data.gs1Prefixes;
    if (data.notes !== undefined) setClause.notes = data.notes;

    const [row] = await this.db
      .update(schema.counterparties)
      .set(setClause)
      .where(and(eq(schema.counterparties.tenantId, tenantId), eq(schema.counterparties.id, id)))
      .returning();

    if (!row) {
      throw new NotFoundException("Counterparty not found or does not belong to this tenant");
    }

    return this.rowToDto(row);
  }

  /** Delete a counterparty. Returns 404 if not found, 409 if referenced. */
  async deleteCounterparty(tenantId: string, id: string): Promise<void> {
    // Verify the counterparty exists and belongs to this tenant
    await this.getCounterparty(tenantId, id);

    try {
      await this.db
        .delete(schema.counterparties)
        .where(and(eq(schema.counterparties.tenantId, tenantId), eq(schema.counterparties.id, id)));
    } catch (error) {
      // Catch PostgreSQL FK violation errors (code 23503)
      // Check both direct code property and nested cause.code
      const err = error as Error & { code?: string; cause?: unknown };
      const errorCode = err?.code || (err?.cause as Record<string, string> | undefined)?.code;
      if (errorCode === "23503") {
        throw new ConflictException("Counterparty is referenced by products or shifts");
      }
      throw error;
    }
  }

  /**
   * A counterparty's box SSCC counter (Task 5) -- kept separate from the
   * tenant's own counter (org-profile.service.ts's getSscc) because it's
   * keyed by the counterparty's own GLN-derived prefix, which is ordinarily
   * a different number space entirely. `getCounterparty` both 404s a
   * cross-tenant id and tenant-scopes the lookup in one place.
   */
  async getSscc(tenantId: string, id: string): Promise<SsccCounterDto> {
    const issuerPrefix = await this.counterpartyIssuerPrefix(tenantId, id);
    const [row] = await this.db
      .select({ nextSerial: schema.ssccCounters.nextSerial })
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, BOX_EXTENSION_DIGIT),
        ),
      );
    return { extensionDigit: BOX_EXTENSION_DIGIT, nextSerial: row ? Number(row.nextSerial) : 0 };
  }

  /** Seeds (or reseeds) a counterparty's box counter. See getSscc's doc comment. */
  async putSscc(tenantId: string, id: string, dto: SsccCounterDto): Promise<SsccCounterDto> {
    const issuerPrefix = await this.counterpartyIssuerPrefix(tenantId, id);
    await this.db
      .insert(schema.ssccCounters)
      .values({
        tenantId,
        issuerPrefix,
        extensionDigit: dto.extensionDigit,
        nextSerial: dto.nextSerial,
      })
      .onConflictDoUpdate({
        target: [
          schema.ssccCounters.tenantId,
          schema.ssccCounters.issuerPrefix,
          schema.ssccCounters.extensionDigit,
        ],
        set: { nextSerial: dto.nextSerial, updatedAt: sql`now()` },
      });
    return { extensionDigit: dto.extensionDigit, nextSerial: dto.nextSerial };
  }

  /** The 9-digit prefix derived from this counterparty's own GLN; 404s if the id isn't this tenant's. */
  private async counterpartyIssuerPrefix(tenantId: string, id: string): Promise<string> {
    const counterparty = await this.getCounterparty(tenantId, id);
    return deriveIssuerPrefix(counterparty.gln, "counterparty");
  }

  private rowToDto(row: typeof schema.counterparties.$inferSelect): CounterpartyDto {
    return {
      id: row.id,
      name: row.name,
      gln: row.gln,
      inn: row.inn,
      gs1Prefixes: row.gs1Prefixes,
      notes: row.notes,
      createdAt: row.createdAt,
    };
  }
}
