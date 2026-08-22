import {
  platformCommercialContracts,
  type CreateOfferDto,
  type OfferPaymentDto,
} from "@markiro/platform-contracts";

export const createOfferSchema = platformCommercialContracts.offers.create.body;
export const offerIdSchema = platformCommercialContracts.offers.detail.params;
export const paymentSchema = platformCommercialContracts.offers.payment.body;

export type { CreateOfferDto };
export type PaymentDto = OfferPaymentDto;
