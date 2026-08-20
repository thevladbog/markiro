import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { CreateReasonDto, ListReasonsResponseDto, ReasonDto, UpdateReasonDto } from "./dto";

@Injectable()
export class DisaggregationReasonsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** List non-archived reasons for a tenant, ordered by sortOrder then name. */
  async listReasons(tenantId: string): Promise<ListReasonsResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.disaggregationReasons)
      .where(
        and(
          eq(schema.disaggregationReasons.tenantId, tenantId),
          eq(schema.disaggregationReasons.archived, false),
        ),
      )
      .orderBy(asc(schema.disaggregationReasons.sortOrder), asc(schema.disaggregationReasons.name));

    return { items: rows.map((row) => this.rowToDto(row)) };
  }

  /** Create a reason. */
  async createReason(tenantId: string, data: CreateReasonDto): Promise<ReasonDto> {
    const [row] = await this.db
      .insert(schema.disaggregationReasons)
      .values({
        tenantId,
        name: data.name,
        sortOrder: data.sortOrder,
      })
      .returning();

    if (!row) {
      throw new InternalServerErrorException("Failed to create disaggregation reason");
    }

    return this.rowToDto(row);
  }

  /** Update a reason's name/sortOrder (partial update). */
  async updateReason(tenantId: string, id: string, data: UpdateReasonDto): Promise<ReasonDto> {
    const set: Record<string, unknown> = {};
    if (data.name !== undefined) set.name = data.name;
    if (data.sortOrder !== undefined) set.sortOrder = data.sortOrder;

    if (Object.keys(set).length === 0) {
      const [row] = await this.db
        .select()
        .from(schema.disaggregationReasons)
        .where(
          and(
            eq(schema.disaggregationReasons.tenantId, tenantId),
            eq(schema.disaggregationReasons.id, id),
          ),
        );
      if (!row) throw new NotFoundException();
      return this.rowToDto(row);
    }

    const [row] = await this.db
      .update(schema.disaggregationReasons)
      .set(set)
      .where(
        and(
          eq(schema.disaggregationReasons.tenantId, tenantId),
          eq(schema.disaggregationReasons.id, id),
        ),
      )
      .returning();

    if (!row) throw new NotFoundException();
    return this.rowToDto(row);
  }

  /** Soft-archive a reason (documents reference it via FK, so it can't be hard-deleted). */
  async archiveReason(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db
      .update(schema.disaggregationReasons)
      .set({ archived: true })
      .where(
        and(
          eq(schema.disaggregationReasons.tenantId, tenantId),
          eq(schema.disaggregationReasons.id, id),
        ),
      )
      .returning();

    if (!row) throw new NotFoundException();
  }

  private rowToDto(row: typeof schema.disaggregationReasons.$inferSelect): ReasonDto {
    return { id: row.id, name: row.name, sortOrder: row.sortOrder };
  }
}
