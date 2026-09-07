import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("receiving draft schema", () => {
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
