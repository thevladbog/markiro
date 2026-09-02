import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, IndexedColumn } from "drizzle-orm/pg-core";

import * as schema from "../src/schema.js";

function indexColumns(table: Parameters<typeof getTableConfig>[0], name: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  expect(index, `missing ${name}`).toBeDefined();
  return (
    index?.config.columns.map((column) =>
      is(column, IndexedColumn) ? (column.name ?? "unnamed") : "expression",
    ) ?? []
  );
}

describe("integrations schema", () => {
  it("ключует канал парой (тенант, тип) — одна интеграция каждого типа на организацию", () => {
    expect(schema.integrationChannels).toBeDefined();
    const columns = Object.keys(schema.integrationChannels);
    expect(columns).toEqual(
      expect.arrayContaining(["tenantId", "type", "settings", "silentAfterHours", "lastEventAt"]),
    );
  });

  it("держит кандидатов и куски файла отдельными таблицами", () => {
    expect(schema.integrationCandidates).toBeDefined();
    expect(schema.exchangeUploads).toBeDefined();
  });

  it("indexes sessions in tenant, channel, and stable paging order", () => {
    expect(
      indexColumns(
        schema.integrationSessions,
        "integration_sessions_tenant_channel_started_id_idx",
      ),
    ).toEqual(["tenant_id", "channel_type", "started_at", "id"]);
  });

  it("indexes orphan, direction, and per-session event reads", () => {
    expect(
      indexColumns(
        schema.integrationEvents,
        "integration_events_tenant_channel_session_direction_at_id_idx",
      ),
    ).toEqual(["tenant_id", "channel_type", "session_id", "direction", "at", "id"]);
  });
});
