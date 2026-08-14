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
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type {
  CreateLineDto,
  LineDto,
  ListLinePresenceResponseDto,
  ListLinesResponseDto,
  UpdateLineDto,
} from "./dto";
import { stationDeviceLifecycle } from "../station-devices/dto";

@Injectable()
export class LinesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** List all production lines for a tenant. */
  async listLines(tenantId: string): Promise<ListLinesResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.lines)
      .where(eq(schema.lines.tenantId, tenantId));

    return { items: rows.map((row) => this.rowToDto(row)) };
  }

  async listPresence(tenantId: string): Promise<ListLinePresenceResponseDto> {
    const rows = await this.db
      .select({
        lineId: schema.lines.id,
        lineName: schema.lines.name,
        deviceId: schema.stationDevices.id,
        apiKeyId: schema.stationDevices.apiKeyId,
        revokedAt: schema.stationDevices.revokedAt,
        lastSeenAt: schema.stationDevices.lastSeenAt,
      })
      .from(schema.lines)
      .leftJoin(
        schema.stationDevices,
        and(
          eq(schema.stationDevices.tenantId, tenantId),
          eq(schema.stationDevices.lineId, schema.lines.id),
        ),
      )
      .where(eq(schema.lines.tenantId, tenantId));
    const now = new Date();
    const byLine = new Map<string, { lineName: string; assignedStations: number; onlineStations: number; lastSeenAt: Date | null }>();
    for (const row of rows) {
      const current = byLine.get(row.lineId) ?? {
        lineName: row.lineName,
        assignedStations: 0,
        onlineStations: 0,
        lastSeenAt: null,
      };
      if (row.deviceId) {
        current.assignedStations += 1;
        if (stationDeviceLifecycle(row, now) === "online") current.onlineStations += 1;
        if (row.lastSeenAt && (!current.lastSeenAt || row.lastSeenAt > current.lastSeenAt)) current.lastSeenAt = row.lastSeenAt;
      }
      byLine.set(row.lineId, current);
    }
    return { items: [...byLine].map(([lineId, value]) => ({ lineId, ...value })) };
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
    const row = await this.db.transaction((tx) =>
      this.entitlements.withQuotaSlot(tx, tenantId, "lines", async () => {
        const [created] = await tx
          .insert(schema.lines)
          .values({ tenantId, name: data.name })
          .returning();
        return created;
      }),
    );

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
    try {
      await this.db.transaction((tx) =>
        this.entitlements.withQuotaLock(tx, tenantId, "lines", async () => {
          const [line] = await tx
            .select({ id: schema.lines.id })
            .from(schema.lines)
            .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, id)))
            .limit(1);
          if (!line) throw new NotFoundException();
          const deleted = await tx
            .delete(schema.lines)
            .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, id)))
            .returning({ id: schema.lines.id });
          if (deleted.length !== 1) throw new NotFoundException();
        }),
      );
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
