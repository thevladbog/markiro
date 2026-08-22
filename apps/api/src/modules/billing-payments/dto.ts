import {
  platformCommercialContracts,
  type ManualPaymentDto,
  type PaymentMatchResolveDto,
  type PaymentImportDto,
} from "@markiro/platform-contracts";

export const manualPaymentSchema = platformCommercialContracts.payments.manual.body;
export const importBankFileSchema = platformCommercialContracts.payments.import.body;
export const paymentMatchIdSchema = platformCommercialContracts.payments.matches.resolve.params;
export const paymentMatchResolveSchema = platformCommercialContracts.payments.matches.resolve.body;

export type { ManualPaymentDto, PaymentMatchResolveDto };
export type ImportBankFileDto = PaymentImportDto;
