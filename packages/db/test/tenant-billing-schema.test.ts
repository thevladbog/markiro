import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

function constraintNames(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table);
  return {
    checks: config.checks.map((constraint) => constraint.name),
    foreignKeys: config.foreignKeys.map((constraint) => constraint.getName()),
    indexes: config.indexes.map((constraint) => constraint.config.name),
    uniqueConstraints: config.uniqueConstraints.map((constraint) => constraint.name),
  };
}

describe("tenant billing workflow schema", () => {
  it("stores the workflow and invoice provenance without a circular request column", () => {
    expect(getTableName(schema.tenantBillingRequests)).toBe("tenant_billing_requests");
    expect(getTableName(schema.tenantBillingRequestEvents)).toBe("tenant_billing_request_events");
    expect(getTableName(schema.tenantBillingRequestAttachments)).toBe(
      "tenant_billing_request_attachments",
    );
    expect(getTableName(schema.tenantBillingRequestLinks)).toBe("tenant_billing_request_links");
    expect(getTableName(schema.commercialOfferDecisions)).toBe("commercial_offer_decisions");
    expect(getTableName(schema.billingActs)).toBe("billing_acts");
    expect(getTableName(schema.billingActDocuments)).toBe("billing_act_documents");
    expect(schema.invoiceStatus.enumValues).toContain("partially_paid");
    expect(schema.invoices.sourceOfferId).toBeDefined();
    expect("sourceRequestId" in schema.invoices).toBe(false);
  });

  it("uses the approved immutable workflow values", () => {
    expect(schema.BILLING_REQUEST_TYPES).toEqual([
      "renewal",
      "capacity_change",
      "additional_service",
      "documents",
      "other",
    ]);
    expect(schema.BILLING_REQUEST_STATUSES).toEqual([
      "new",
      "under_review",
      "clarification_required",
      "offer_prepared",
      "awaiting_payment",
      "in_progress",
      "completed",
      "cancelled",
    ]);
    expect(schema.BILLING_REQUEST_EVENT_KINDS).toEqual([
      "created",
      "status_changed",
      "tenant_reply",
      "platform_comment",
      "offer_linked",
      "offer_accepted",
      "offer_changes_requested",
      "invoice_linked",
      "payment_confirmed",
      "service_linked",
      "act_linked",
    ]);
    expect(schema.BILLING_ACT_STATUSES).toEqual(["draft", "issued", "cancelled"]);
    expect(schema.BILLING_RESPONSIBLE_SIDES).toEqual(["tenant", "markiro", "none"]);
  });

  it("enforces tenant ownership and idempotency at every workflow boundary", () => {
    expect(constraintNames(schema.tenantBillingRequests).uniqueConstraints).toEqual(
      expect.arrayContaining([
        "tenant_billing_requests_tenant_id_uq",
        "tenant_billing_requests_tenant_idempotency_uq",
      ]),
    );
    expect(constraintNames(schema.tenantBillingRequestEvents).foreignKeys).toContain(
      "tenant_billing_request_events_tenant_request_fk",
    );
    expect(constraintNames(schema.tenantBillingRequestEvents).uniqueConstraints).toContain(
      "tenant_billing_request_events_tenant_idempotency_uq",
    );
    expect(constraintNames(schema.tenantBillingRequestAttachments).foreignKeys).toContain(
      "tenant_billing_request_attachments_tenant_request_fk",
    );
    expect(constraintNames(schema.tenantBillingRequestLinks).foreignKeys).toEqual(
      expect.arrayContaining([
        "tenant_billing_request_links_tenant_request_fk",
        "tenant_billing_request_links_tenant_offer_fk",
        "tenant_billing_request_links_tenant_invoice_fk",
        "tenant_billing_request_links_tenant_payment_fk",
        "tenant_billing_request_links_tenant_act_fk",
        "tenant_billing_request_links_tenant_service_fk",
        "tenant_billing_request_links_tenant_subscription_event_fk",
      ]),
    );
    expect(constraintNames(schema.commercialOfferDecisions).foreignKeys).toContain(
      "commercial_offer_decisions_tenant_offer_fk",
    );
    expect(constraintNames(schema.commercialOfferDecisions).uniqueConstraints).toContain(
      "commercial_offer_decisions_tenant_idempotency_uq",
    );
    expect(constraintNames(schema.billingActDocuments).foreignKeys).toContain(
      "billing_act_documents_tenant_act_fk",
    );
  });

  it("constrains actors, file sizes, accepted decisions, current act documents, and payments", () => {
    expect(constraintNames(schema.tenantBillingRequestEvents).checks).toContain(
      "tenant_billing_request_events_actor_shape_check",
    );
    expect(constraintNames(schema.tenantBillingRequestAttachments).checks).toContain(
      "tenant_billing_request_attachments_byte_size_positive",
    );
    expect(constraintNames(schema.commercialOfferDecisions).indexes).toContain(
      "commercial_offer_decisions_accepted_offer_uq",
    );
    expect(constraintNames(schema.billingActDocuments).indexes).toContain(
      "billing_act_documents_current_act_uq",
    );

    const paymentConstraints = constraintNames(schema.billingPayments);
    expect(paymentConstraints.uniqueConstraints).not.toContain("billing_payments_invoice_uq");
    expect(paymentConstraints.uniqueConstraints).toContain("billing_payments_idempotency_uq");
    expect(paymentConstraints.indexes).toContain("billing_payments_tenant_invoice_paid_idx");
  });
});
