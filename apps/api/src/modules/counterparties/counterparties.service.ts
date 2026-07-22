import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  CounterpartyDto,
  CreateCounterpartyDto,
  ListCounterpartiesResponseDto,
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
    // First verify the counterparty exists and belongs to this tenant
    await this.getCounterparty(tenantId, id);

    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) setClause.name = data.name;
    if (data.gln !== undefined) setClause.gln = data.gln;
    if (data.inn !== undefined) setClause.inn = data.inn;
    if (data.gs1Prefixes !== undefined) setClause.gs1Prefixes = data.gs1Prefixes;
    if (data.notes !== undefined) setClause.notes = data.notes;

    // Note: drizzle doesn't support WHERE in UPDATE with returning() easily,
    // but we already verified ownership above, so we can safely update by id
    const [row] = await this.db
      .update(schema.counterparties)
      .set(setClause)
      .where(eq(schema.counterparties.id, id))
      .returning();

    if (!row) {
      throw new InternalServerErrorException("Failed to update counterparty");
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
