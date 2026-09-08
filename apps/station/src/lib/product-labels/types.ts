import type {
  EnabledValidationPrintPolicy,
  LabelField,
  PrinterLanguage,
  ProductLabelAttemptState,
  ProductLabelEvent,
  ProductLabelJobStatus,
  ProductLabelProjection,
  VerificationOutcome,
  VerificationPolicy,
} from "@markiro/domain";

export interface PreparedProductLabelAcceptance {
  jobId: string;
  shiftId: string;
  deviceId: string;
  terminalId: string;
  operatorId: string;
  credentialOwnership: string;
  raw: string;
  canonicalRaw: string;
  codeHash: string;
  gtin14: string;
  serial: string;
  acceptedAt: string;
  policy: EnabledValidationPrintPolicy;
  fields: Record<LabelField, string>;
  bytesBase64: string;
  preparedEvent: Extract<ProductLabelEvent, { kind: "prepared" }>;
}
export type ProductLabelAcceptResult =
  { status: "accepted"; jobId: string } | { status: "duplicate" } | { status: "busy" };

export interface StoredProductLabelAttempt {
  prepared: Extract<ProductLabelEvent, { kind: "prepared" }>;
  state: ProductLabelAttemptState;
  verifiedAt: string | null;
  verifiedBy: string | null;
}
/** Private durable context; only ProductLabelJobView may reach UI components. */
export interface StoredProductLabelJob extends PreparedProductLabelAcceptance {
  projection: ProductLabelProjection;
  attempts: StoredProductLabelAttempt[];
  ownershipConflict: boolean;
  updatedAt: string;
}
export interface ProductLabelJobView {
  jobId: string;
  shiftId: string;
  codeSuffix: string;
  attemptId: string;
  attemptNo: number;
  language: PrinterLanguage;
  dpi: 203 | 300;
  status: ProductLabelJobStatus;
  verification: VerificationPolicy;
  verificationOutcome: VerificationOutcome;
  ownershipConflict: boolean;
  acceptedAt: string;
  updatedAt: string;
}
