import {
  platformCommercialContracts,
  type ManualPaymentDto,
  type PaymentImportDto,
} from "@markiro/platform-contracts";

export const manualPaymentSchema = platformCommercialContracts.payments.manual.body;
export const importBankFileSchema = platformCommercialContracts.payments.import.body;

export type { ManualPaymentDto };
export type ImportBankFileDto = PaymentImportDto;
