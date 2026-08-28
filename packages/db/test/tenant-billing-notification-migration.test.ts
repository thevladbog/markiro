import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("tenant billing notification delivery migration", () => {
  it("appends one narrowly-scoped recipient uniqueness index after 0072", async () => {
    const [previousText, currentText, journalText, sqlText] = await Promise.all([
      readFile(new URL("../migrations/meta/0072_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0073_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
      readFile(
        new URL("../migrations/0073_tenant_billing_notification_delivery.sql", import.meta.url),
        "utf8",
      ),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as {
      prevId: string;
      tables: Record<string, { indexes: Record<string, unknown> }>;
    };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 73,
      tag: "0073_tenant_billing_notification_delivery",
    });
    expect(
      current.tables["public.email_deliveries"]?.indexes[
        "email_deliveries_tenant_billing_recipient_uq"
      ],
    ).toBeDefined();
    expect(sqlText).toMatch(
      /UNIQUE INDEX "email_deliveries_tenant_billing_recipient_uq"[\s\S]+\("tenant_id", "kind", "source_id", "recipient"\)/,
    );
    expect(sqlText).toContain("\"kind\" = 'tenant-billing-notification'");
  });
});
