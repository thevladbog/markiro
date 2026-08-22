import {
  platformCommercialContracts,
  type ApplyInvoiceDto,
  type CreateInvoiceDto,
} from "@markiro/platform-contracts";

export const createInvoiceSchema = platformCommercialContracts.invoices.create.body;
export const invoiceIdSchema = platformCommercialContracts.invoices.detail.params;
export const applyInvoiceSchema = platformCommercialContracts.invoices.apply.body;

export type { ApplyInvoiceDto, CreateInvoiceDto };
