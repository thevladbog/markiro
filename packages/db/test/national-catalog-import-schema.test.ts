import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";

import { schema } from "../src/index.js";

function table(name: string): AnyPgTable {
  const candidate = (schema as Record<string, unknown>)[name];
  expect(candidate, `schema.${name}`).toBeDefined();
  return candidate as AnyPgTable;
}

it("scopes a product link to the product tenant and snapshots to the same product", () => {
  const keys = getTableConfig(table("nationalCatalogProductLinks")).foreignKeys;
  expect(
    keys.map((key) =>
      key
        .reference()
        .columns.map((c) => c.name)
        .join(","),
    ),
  ).toEqual(
    expect.arrayContaining([
      "tenant_id,product_id",
      "tenant_id,product_id,latest_snapshot_id",
      "tenant_id,product_id,reviewed_snapshot_id",
    ]),
  );
  expect(
    keys.some(
      (key) => getTableName(key.reference().foreignTable) === "product_regulatory_profiles",
    ),
  ).toBe(false);
});

it("allows one current link per tenant product without globally reserving a card", () => {
  const config = getTableConfig(table("nationalCatalogProductLinks"));
  const current = config.indexes.find(
    (index) => index.config.name === "national_catalog_product_links_current",
  );
  expect(current?.config.unique).toBe(true);
  expect(current?.config.columns.map((column) => ("name" in column ? column.name : null))).toEqual([
    "tenant_id",
    "product_id",
  ]);
  expect(current?.config.where && new PgDialect().sqlToQuery(current.config.where).sql).toContain(
    '"closed_at" is null',
  );
  expect(
    config.uniqueConstraints.some((key) => key.columns.some((column) => column.name === "card_id")),
  ).toBe(false);
});

it("exports durable tenant identities without cascading deletion of receipts or links", () => {
  for (const name of [
    "nationalCatalogImportSessions",
    "nationalCatalogImportItems",
    "nationalCatalogImportPreviews",
    "nationalCatalogImportOperations",
    "nationalCatalogImportOperationItems",
    "nationalCatalogProductLinks",
    "nationalCatalogImportImages",
  ]) {
    const config = getTableConfig(table(name));
    expect(config.columns.find((column) => column.name === "id")?.dataType).toBe("string");
    expect(
      config.uniqueConstraints.some(
        (key) => key.columns.map((column) => column.name).join(",") === "tenant_id,id",
      ),
    ).toBe(true);
    expect(config.foreignKeys.some((key) => key.onDelete === "cascade")).toBe(false);
  }
  const lease = getTableConfig(table("nationalCatalogRequestLeases"));
  expect(lease.columns.find((column) => column.name === "tenant_id")?.primary).toBe(true);
  expect(lease.columns.find((column) => column.name === "fence")?.columnType).toBe("PgBigInt64");
});

it("retains session ownership and an accepted candidate reference throughout the receipt chain", () => {
  for (const [name, expected] of [
    ["nationalCatalogImportPreviews", ["tenant_id,session_id,item_id"]],
    ["nationalCatalogImportOperations", ["tenant_id,session_id"]],
    [
      "nationalCatalogImportOperationItems",
      [
        "tenant_id,session_id,operation_id",
        "tenant_id,session_id,preview_id",
        "tenant_id,session_id,preview_id,accepted_image_id",
      ],
    ],
    [
      "nationalCatalogImportImages",
      ["tenant_id,session_id,preview_id,source_hash", "tenant_id,staged_asset_id"],
    ],
  ] as const) {
    const keys = getTableConfig(table(name)).foreignKeys.map((key) =>
      key
        .reference()
        .columns.map((column) => column.name)
        .join(","),
    );
    expect(keys).toEqual(expect.arrayContaining([...expected]));
  }
});

it("persists preparation identity and repair state scoped to its session", () => {
  const config = getTableConfig(table("nationalCatalogImportPreparations"));
  expect(config.uniqueConstraints.map((key) => key.columns.map((c) => c.name).join(","))).toContain(
    "tenant_id,session_id,request_id",
  );
  expect(
    config.foreignKeys.map((key) =>
      key
        .reference()
        .columns.map((c) => c.name)
        .join(","),
    ),
  ).toContain("tenant_id,session_id");
  expect(config.columns.map((c) => c.name)).toEqual(
    expect.arrayContaining(["request_hash", "request", "checkpoint", "actor_id", "expires_at"]),
  );
});

it("retains optional immutable application evidence separately from the canonical decision and image outcome", () => {
  const config = getTableConfig(table("nationalCatalogImportOperationItems"));
  const evidence = config.columns.find((column) => column.name === "applied_evidence");
  expect(evidence?.dataType).toBe("json");
  expect(evidence?.notNull).toBe(false);
});

it("persists actual photo preparation initiator and repair checkpoint without inventing historical actors", () => {
  const config = getTableConfig(table("nationalCatalogImportImages"));
  for (const name of ["preparation_actor_id", "preparation_checkpoint"]) {
    const column = config.columns.find((c) => c.name === name);
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
  }
});

it("retains observation review and resumable refresh independently of temporary previews", () => {
  const columns = getTableConfig(table("nationalCatalogProductLinks")).columns;
  for (const name of [
    "reviewed_projection",
    "observed_projection",
    "refresh_checkpoint",
    "refresh_error_code",
  ]) {
    const column = columns.find((entry) => entry.name === name);
    expect(column, name).toBeDefined();
    expect(column?.notNull).toBe(false);
  }
});

it("records dispatch fairness independently from work receipts with a tenant cascading key", () => {
  const config = getTableConfig(table("nationalCatalogImportDispatchAttempts"));
  expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
    "kind",
    "tenant_id",
    "work_id",
    "step_id",
  ]);
  expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
  expect(config.columns.map((column) => column.name)).toEqual([
    "kind",
    "tenant_id",
    "work_id",
    "step_id",
    "attempted_at",
  ]);
});
