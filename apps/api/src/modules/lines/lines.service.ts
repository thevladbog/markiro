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
import type { CreateLineDto, LineDto, ListLinesResponseDto, UpdateLineDto } from "./dto";

@Injectable()
export class LinesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** List all production lines for a tenant. */
  async listLines(tenantId: string): Promise<ListLinesResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.lines)
      .where(eq(schema.lines.tenantId, tenantId));

    return { items: rows.map((row) => this.rowToDto(row)) };
  }

  /** Get a single line by id (must belong to the tenant). */
  async getLine(tenantId: string, id: string): Promise<LineDto> {
    const [row] = await this.db
      .select()
      .from(schema.lines)
      .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, id)));

    if (!row) {
      throw new NotFoundException();
    }
    return this.rowToDto(row);
  }

  /** Create a production line. */
  async createLine(tenantId: string, data: CreateLineDto): Promise<LineDto> {
    const [row] = await this.db
      .insert(schema.lines)
      .values({ tenantId, name: data.name })
      .returning();

    if (!row) {
      throw new InternalServerErrorException("Failed to create line");
    }
    return this.rowToDto(row);
  }

  /** Rename a production line. */
  async updateLine(tenantId: string, id: string, data: UpdateLineDto): Promise<LineDto> {
    const [row] = await this.db
      .update(schema.lines)
      .set({ name: data.name })
      .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, id)))
      .returning();

    if (!row) {
      throw new NotFoundException("Line not found or does not belong to this tenant");
    }
    return this.rowToDto(row);
  }

  /** Delete a production line. Returns 404 if not found, 409 if referenced by a shift. */
  async deleteLine(tenantId: string, id: string): Promise<void> {
    await this.getLine(tenantId, id);

    try {
      await this.db
        .delete(schema.lines)
        .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, id)));
    } catch (error) {
      // Catch PostgreSQL FK violation errors (code 23503); check both direct
      // code property and nested cause.code (node-postgres wraps it either way).
      const err = error as Error & { code?: string; cause?: unknown };
      const errorCode = err?.code || (err?.cause as Record<string, string> | undefined)?.code;
      if (errorCode === "23503") {
        throw new ConflictException("Line is referenced by shifts");
      }
      throw error;
    }
  }

  private rowToDto(row: typeof schema.lines.$inferSelect): LineDto {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
    };
  }
}
