import {
  platformCommercialContracts,
  type ApplyInvoiceDto,
  type CreateInvoiceDto,
} from "@markiro/platform-contracts";

import type { SchemaObject } from "@nestjs/swagger";

export const createInvoiceSchema = platformCommercialContracts.invoices.create.body;
export const invoiceIdSchema = platformCommercialContracts.invoices.detail.params;
export const applyInvoiceSchema = platformCommercialContracts.invoices.apply.body;

export type { ApplyInvoiceDto, CreateInvoiceDto };

// Hand-written wire schemas for TenantBillingController responses: the tenant
// billing service returns interface-less projections of drizzle rows, so there
// is no zod schema to derive the OpenAPI document from.
const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
// numeric(14,2) columns serialize as decimal strings with two fraction digits.
const moneySchema = { type: "string", pattern: "^[0-9]+\\.[0-9]{2}$" } as const;

// Tenants only ever see invoices past the draft stage.
const TENANT_INVOICE_STATUSES = ["issued", "paid", "cancelled"] as const;

const tenantInvoiceListItemOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "number", "issueDate", "dueDate", "status", "total", "currency"],
  properties: {
    id: uuidSchema,
    number: { type: "string" },
    issueDate: { ...dateTimeSchema, nullable: true },
    dueDate: { ...dateTimeSchema, nullable: true },
    status: { type: "string", enum: [...TENANT_INVOICE_STATUSES] },
    total: moneySchema,
    currency: { type: "string", enum: ["RUB"] },
  },
};

export const tenantInvoiceListOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: tenantInvoiceListItemOpenApiSchema } },
};

const tenantInvoiceLineOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["position", "nameRu", "unit", "quantity", "agreedUnitPrice", "lineTotal"],
  properties: {
    position: { type: "integer", minimum: 1 },
    nameRu: { type: "string" },
    unit: { type: "string" },
    quantity: { type: "integer", minimum: 1 },
    agreedUnitPrice: moneySchema,
    lineTotal: moneySchema,
  },
};

const tenantInvoiceDocumentOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "revision", "format", "status", "byteSize"],
  properties: {
    id: uuidSchema,
    revision: { type: "integer", minimum: 1 },
    format: { type: "string", enum: ["pdf", "html"] },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
    byteSize: { type: "integer", minimum: 0, nullable: true },
  },
};

export const tenantInvoiceDetailOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "number",
    "issueDate",
    "dueDate",
    "status",
    "subtotal",
    "vatTotal",
    "total",
    "currency",
    "lines",
    "documents",
  ],
  properties: {
    id: uuidSchema,
    number: { type: "string" },
    issueDate: { ...dateTimeSchema, nullable: true },
    dueDate: { ...dateTimeSchema, nullable: true },
    status: { type: "string", enum: [...TENANT_INVOICE_STATUSES] },
    subtotal: moneySchema,
    vatTotal: moneySchema,
    total: moneySchema,
    currency: { type: "string", enum: ["RUB"] },
    lines: { type: "array", items: tenantInvoiceLineOpenApiSchema },
    documents: { type: "array", items: tenantInvoiceDocumentOpenApiSchema },
  },
};

export const tenantInvoiceDocumentDownloadOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: { url: { type: "string", format: "uri" } },
};
