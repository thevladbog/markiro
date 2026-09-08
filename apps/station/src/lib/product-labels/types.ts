import type {
  EnabledValidationPrintPolicy,
  LabelField,
  PrinterLanguage,
  ProductLabelAttemptState,
  ProductLabelEvent,
  ProductLabelJobStatus,
  ProductLabelProjection,
  RasterizeTextFn,
  VerificationOutcome,
  VerificationPolicy,
} from "@markiro/domain";
import type { PrintTarget } from "../hardware.js";
import type { SqlExecutor } from "../mirror.js";
import type { BoxLabelInput } from "../box-label.js";

export type DuplicateLabelFieldsInput = Omit<BoxLabelInput, "sscc" | "itemCount" | "closedAt"> & {
  canonicalRaw: string;
  acceptedAt: string;
};
export type PrepareProductLabelInput = Pick<
  PreparedProductLabelAcceptance,
  | "jobId"
  | "shiftId"
  | "deviceId"
  | "terminalId"
  | "operatorId"
  | "credentialOwnership"
  | "raw"
  | "acceptedAt"
  | "policy"
> & {
  labelContext: Omit<DuplicateLabelFieldsInput, "canonicalRaw" | "acceptedAt">;
  eventId: string;
  attemptId: string;
  language: PrinterLanguage;
  /** Unknown resolution must be configured before accepting the first unit. */
  printerDpi: 203 | 300 | null;
  rasterizeText: RasterizeTextFn;
};

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
  attemptState: ProductLabelAttemptState;
  verification: VerificationPolicy;
  verificationOutcome: VerificationOutcome;
  ownershipConflict: boolean;
  acceptedAt: string;
  updatedAt: string;
}

export interface ProductLabelActor {
  operatorId: string;
  now(): string;
  newId(): string;
}
export interface ProductLabelPrintingDeps extends ProductLabelActor {
  exec: SqlExecutor;
  credentialOwnership: string;
  target: PrintTarget | null;
  language: PrinterLanguage;
  dpi: 203 | 300 | null;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
  recovery?: boolean;
}
