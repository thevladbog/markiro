import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("landing leads schema (spec 2026-10-20 §15.2)", () => {
  it("keeps one lead per normalized e-mail and lets anonymization clear contacts", () => {
    const config = getTableConfig(schema.landingLeads);
    const column = (name: string) => config.columns.find((candidate) => candidate.name === name);
    expect(column("email")?.notNull).toBe(false);
    expect(column("name")?.notNull).toBe(false);
    expect(column("phone")?.notNull).toBe(false);
    expect(column("company")?.notNull).toBe(true);
    expect(column("status")?.default).toBe("new");
    expect(column("tenant_id")?.notNull).toBe(false);
    expect(column("anonymized_at")?.notNull).toBe(false);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "landing_leads_email_uq",
        "landing_leads_status_idx",
        "landing_leads_next_touch_idx",
      ]),
    );
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "landing_leads_anonymized_check",
      "landing_leads_shape_check",
    ]);
  });

  it("journals events with an idempotent public request id", () => {
    const config = getTableConfig(schema.landingLeadEvents);
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "landing_lead_events_public_request_uq",
    );
    expect(config.checks.map((check) => check.name)).toContain("landing_lead_events_kind_check");
    const lead = config.foreignKeys.find(
      (key) => key.reference().foreignTable === schema.landingLeads,
    );
    expect(lead?.onDelete).toBe("cascade");
  });

  it("keeps the notification outbox with one digest per day", () => {
    const config = getTableConfig(schema.leadNotifications);
    const column = (name: string) => config.columns.find((candidate) => candidate.name === name);
    expect(column("attempts")?.default).toBe(0);
    expect(column("status")?.default).toBe("pending");
    expect(column("lead_id")?.notNull).toBe(false);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining(["lead_notifications_due_idx", "lead_notifications_digest_date_uq"]),
    );
    expect(config.checks.map((check) => check.name)).toContain("lead_notifications_shape_check");
  });

  it("exports the shared vocabularies", () => {
    expect(schema.LANDING_LEAD_STATUSES).toEqual([
      "new",
      "contacted",
      "trial",
      "invoice_sent",
      "won",
      "lost",
    ]);
    expect(schema.LANDING_LEAD_EVENT_KINDS).toEqual([
      "download",
      "invoice_request",
      "demo_request",
      "status_change",
      "touch",
      "note",
      "linked_tenant",
      "activation_request",
      "anonymized",
    ]);
    expect(schema.LEAD_NOTIFICATION_KINDS).toEqual(["new_lead", "invoice_request", "daily_digest"]);
  });
});
