import {
  platformCommercialContracts,
  type CreateOfferDto,
  type OfferPaymentDto,
  type OfferReviseDto,
} from "@markiro/platform-contracts";

export const createOfferSchema = platformCommercialContracts.offers.create.body;
export const offerIdSchema = platformCommercialContracts.offers.detail.params;
export const reviseOfferSchema = platformCommercialContracts.offers.revise.body;
export const paymentSchema = platformCommercialContracts.offers.payment.body;

export type { CreateOfferDto };
export type PaymentDto = OfferPaymentDto;
export type ReviseOfferDto = OfferReviseDto;
