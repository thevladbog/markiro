import type { LabelTemplateSpec } from "@markiro/domain";

export interface PalletAssemblyProduct {
  id: string;
  name: string;
  printName: string | null;
  gtin14: string;
  shelfLifeDays: number | null;
  capacity: number | null;
  chzGroupCode: number | null;
}

export interface PalletAssemblyBox {
  sscc: string;
  shiftNumber: string | null;
  productionDate: string | null;
  lotNumber?: string | null;
  itemCount: number;
  syncState: "pending" | "accepted";
}

export type PalletPrintState = "pending" | "printing" | "sent" | "failed" | "unknown" | "confirmed";

export interface PalletAssemblyPallet {
  id: string;
  product: PalletAssemblyProduct;
  boxes: PalletAssemblyBox[];
  openedAt: string;
  closedAt: string | null;
  sscc: string | null;
  /** Immutable initial label content, including the count at the time of closing. */
  label: {
    template: LabelTemplateSpec;
    boxCount: number;
    itemCount: number;
    productionDate: string | null;
    lotNumber?: string | null | undefined;
  } | null;
  labelVersion: number;
  isCorrection: boolean;
  printState: PalletPrintState;
  printReason: string | null;
  deferred: boolean;
  cancelled: boolean;
  syncState: "pending" | "accepted" | "rejected";
}

export interface PalletAssemblyConflict {
  palletId: string;
  palletSscc: string | null;
  boxSscc: string | null;
  winningPalletSscc: string | null;
  closeIssueId: string | null;
  code: string;
  acknowledged: boolean;
  blocksAssembly: boolean;
  canAbandon: boolean;
}

export interface PalletAssemblyView {
  open: PalletAssemblyPallet | null;
  pendingLabels: PalletAssemblyPallet[];
  conflicts: PalletAssemblyConflict[];
  registrySyncedAt: string | null;
  canOpenPallets: boolean | null;
}

export type AddPalletBoxResult =
  | { kind: "added"; pallet: PalletAssemblyPallet; full: boolean }
  | { kind: "occupied"; palletSscc: string | null }
  | {
      kind:
        | "duplicate"
        | "unknown_box"
        | "removed_box"
        | "different_product"
        | "unknown_product"
        | "invalid_box_sscc"
        | "registry_required"
        | "full"
        | "forbidden"
        | "blocked"
        | "stale";
    };

export type CloseAssemblyPalletResult =
  | { kind: "closed"; pallet: PalletAssemblyPallet }
  | { kind: "empty" | "no_serials" | "invalid_serial" | "forbidden" | "blocked" | "stale" };

export interface PalletAssemblyStore {
  read(): Promise<PalletAssemblyView>;
  get(palletId: string): Promise<PalletAssemblyPallet | null>;
  add(sscc: string): Promise<AddPalletBoxResult>;
  remove(palletId: string, sscc: string): Promise<boolean>;
  close(
    palletId: string,
    issuerPrefix: string,
    template: LabelTemplateSpec,
    expectedBoxSsccs?: readonly string[],
  ): Promise<CloseAssemblyPalletResult>;
  startPrint(
    palletId: string,
    expectedLabelVersion: number,
    allowUnknown?: boolean,
  ): Promise<boolean>;
  finishPrint(
    palletId: string,
    state: "sent" | "failed" | "unknown",
    reason?: string,
  ): Promise<boolean>;
  confirmPrint(
    palletId: string,
    expectedLabelVersion: number,
    verified?: boolean,
  ): Promise<boolean>;
  deferPrint(palletId: string): Promise<boolean>;
  recoverPrints(inFlightIds: readonly string[]): Promise<void>;
  acknowledgeConflict(palletId: string): Promise<void>;
  abandonOpenConflict(palletId: string): Promise<boolean>;
}
