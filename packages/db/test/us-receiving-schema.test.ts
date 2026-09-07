import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("receiving draft schema", () => {
  it("anchors each revision to a mandatory tenant-owned root", () => {
    const events = getTableConfig(schema.traceabilityEvents);
    expect(events.columns.find((c) => c.name === "root_event_id")?.notNull).toBe(true);
    const reference = events.foreignKeys
      .find((k) => k.getName() === "traceability_events_root_fk")
      ?.reference();
    expect(reference?.columns.map((c) => c.name)).toEqual(["tenant_id", "root_event_id"]);
    expect(reference?.foreignColumns.map((c) => c.name)).toEqual(["tenant_id", "id"]);
  });
  it("uses tenant composite foreign keys for every business reference", () => {
    for (const table of [
      schema.traceabilityEvents,
      schema.receivingEventItems,
      schema.receivingEventDocuments,
      schema.receivingOperations,
    ]) {
      const config = getTableConfig(table);
      const references = config.foreignKeys
        .map((key) => key.reference())
        .filter((key) => key.foreignTable !== schema.organization);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference.columns[0]?.name).toBe("tenant_id");
        expect(reference.foreignColumns[0]?.name).toBe("tenant_id");
      }
    }
  });
  it("scopes both revision links to the tenant and root and keeps line bindings nullable", () => {
    const events = getTableConfig(schema.traceabilityEvents);
    for (const [name, column] of [
      ["receiving_previous_revision_fk", "previous_revision_id"],
      ["receiving_superseded_by_fk", "superseded_by_event_id"],
    ]) {
      const ref = events.foreignKeys.find((key) => key.getName() === name)?.reference();
      expect(ref?.columns.map((c) => c.name)).toEqual(["tenant_id", "root_event_id", column]);
      expect(ref?.foreignColumns.map((c) => c.name)).toEqual(["tenant_id", "root_event_id", "id"]);
    }
    expect(schema.receivingEventItems.previousLineNo.notNull).toBe(false);
    expect(
      events.indexes.filter((index) => index.config.where).map((index) => index.config.name),
    ).toEqual(expect.arrayContaining(["receiving_one_current_uq", "receiving_one_pending_uq"]));
  });
  it("keeps civil dates, exact quantities and separate versions", () => {
    expect(schema.receivingEventItems.exemptReceipt.getSQLType()).toBe("jsonb");
    expect(schema.receivingEventItems.exemptReceipt.notNull).toBe(false);
    expect(schema.traceabilityEvents.dateReceived.getSQLType()).toBe("date");
    expect(schema.receivingEventItems.quantity.getSQLType()).toBe("text");
    expect(schema.traceabilityEvents.draftVersion.notNull).toBe(true);
    expect(schema.traceabilityEvents.revision.notNull).toBe(true);
    expect(getTableConfig(schema.traceabilityEvents).checks.map((check) => check.name)).toContain(
      "traceability_events_lifecycle_valid",
    );
  });
});
