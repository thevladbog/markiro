import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  BoxExceptionDto,
  ListBoxExceptionsQueryDto,
  ListBoxExceptionsResponseDto,
} from "./dto";

@Injectable()
export class BoxExceptionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * One tenant-scoped, shift-scoped select over `box_exceptions`, ordered by
   * `recordedAt DESC` (newest first) and `id DESC` for stable ties. The audit
   * trail a manager reviews reads top-down as "what just happened", same reasoning as
   * BoxesService.listBoxes ordering the still-open box to the top, but here
   * every row is an immutable, already-applied (or already-no-op'd) event
   * rather than a live aggregate.
   */
  async listBoxExceptions(
    tenantId: string,
    query: ListBoxExceptionsQueryDto,
  ): Promise<ListBoxExceptionsResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.boxExceptions)
      .where(
        and(
          eq(schema.boxExceptions.tenantId, tenantId),
          eq(schema.boxExceptions.shiftId, query.shiftId),
        ),
      )
      .orderBy(desc(schema.boxExceptions.recordedAt), desc(schema.boxExceptions.id));
    return {
      items: rows.map((r): BoxExceptionDto => ({
        id: r.id,
        kind: r.kind as BoxExceptionDto["kind"],
        boxId: r.boxId,
        codeHash: r.codeHash,
        terminalId: r.terminalId,
        operatorId: r.operatorId,
        reason: r.reason,
        occurredAt: r.occurredAt,
        recordedAt: r.recordedAt,
      })),
    };
  }
}
