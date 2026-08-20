import type { SignalTone } from "@markiro/ui";

import type { CredentialRecoveryPhase, LegacyIdentityState, StationView } from "../App.js";
import type { PairingError } from "../lib/pairing.js";
import type { BoxPrintErrorCode } from "../lib/boxes.js";
import type { ConflictListPersistentState } from "../pages/ConflictList.js";
import type { EnrollmentErrorState, EnrollmentState } from "../pages/Enrollment.js";
import type { ExceptionStage } from "../pages/ExceptionFlow.js";
import type { NewShiftMode, NewShiftView } from "../pages/NewShift.js";
import type { LoginStage } from "../pages/OperatorLogin.js";
import type { ShiftSelectionPersistentState } from "../pages/ShiftSelection.js";
import type { WorkBlockingState, WorkOverlayState } from "../pages/WorkScreen.js";
import type { PrintVerificationMessage } from "./PrintVerification.js";
import type { SetupTabId } from "./setup/SetupTabs.js";
import type { FloorConnectivityState } from "./StatusBar.js";
import type { BoxFillPersistentState } from "./work/BoxFillInstrument.js";

/**
 * Production-owned persistent viewport contract. Every map is exhaustive for
 * the union used by the live component; extending a production state union
 * therefore fails typecheck until its gallery contract is decided here.
 */
export const PERSISTENT_STATION_STATE_GALLERY = {
  stationView: {
    loading: "app-loading",
    pairing: "pairing-waiting",
    login: "login-badge",
    floor: "shift-page-1",
  } as const satisfies Record<StationView, string>,
  credentialRecovery: {
    sealing: "credential-recovery-sealing",
    failed: "credential-recovery-failed",
    ready: "credential-recovery-ready",
  } as const satisfies Record<CredentialRecoveryPhase, string>,
  legacyIdentity: {
    resolving: "legacy-identity-resolving",
    degraded: "legacy-identity-degraded",
    rejected: "legacy-identity-rejected",
  } as const satisfies Record<Exclude<LegacyIdentityState, null>, string>,
  enrollment: {
    waiting: "pairing-waiting",
    redeeming: "pairing-redeeming",
    success: "pairing-success",
    service: "pairing-service",
  } as const satisfies Record<EnrollmentState, string>,
  enrollmentError: {
    invalid: "pairing-error",
    expired: "pairing-error",
    locked: "pairing-error",
    rate_limited: "pairing-error",
    unavailable: "pairing-error",
    invalid_response: "pairing-error",
    service: "pairing-service",
    setup_required: "pairing-error",
  } as const satisfies Record<EnrollmentErrorState, string> & Record<PairingError, string>,
  login: {
    badge: "login-badge",
    login: "login-number",
    pin: "login-pin",
    search: "login-name-search",
  } as const satisfies Record<LoginStage, string>,
  newShift: {
    input: "new-shift-input",
    found: "new-shift-found",
    notFound: "new-shift-not-found",
    template: "new-shift-template",
  } as const satisfies Record<NewShiftView, string>,
  shiftSelection: {
    loading: "shift-loading",
    "read-error": "shift-read-error",
    empty: "shift-empty",
    "page-1": "shift-page-1",
    "page-2": "shift-page-2",
  } as const satisfies Record<ShiftSelectionPersistentState, string>,
  workMode: {
    validation: "work-validation",
    aggregation: "work-aggregation",
  } as const satisfies Record<NewShiftMode, string>,
  signal: {
    ok: "work-ok",
    duplicate: "work-duplicate",
    error: "work-error",
  } as const satisfies Record<SignalTone, string>,
  boxFill: {
    empty: "box-empty",
    partial: "work-aggregation",
    full: "box-full",
  } as const satisfies Record<BoxFillPersistentState, string>,
  boxPrint: {
    template_missing: "box-print-template-missing",
    printer_unconfigured: "box-print-printer-unconfigured",
    render_failed: "box-print-render-failed",
    transport_failed: "box-print-transport-failed",
    "skip-confirm": "box-print-skip-confirm",
  } as const satisfies Record<BoxPrintErrorCode | "skip-confirm", string>,
  exception: {
    action: "exception-action",
    target: "exception-target",
    reason: "exception-reason",
    confirm: "exception-confirm",
    applying: "exception-applying",
    result: "exception-result",
  } as const satisfies Record<ExceptionStage, string>,
  conflicts: {
    loading: "conflicts-loading",
    "read-error": "conflicts-read-error",
    empty: "conflicts-empty",
    "page-1": "conflicts-page-1",
    "page-2": "conflicts-page-2",
  } as const satisfies Record<ConflictListPersistentState, string>,
  setup: {
    scanner: "setup-scanner",
    printer: "setup-printer",
    sound: "setup-sound",
  } as const satisfies Record<SetupTabId, string>,
  connectivity: {
    online: "work-validation",
    offline: "offline",
    "sync-stuck": "sync-stuck",
  } as const satisfies Record<FloorConnectivityState, string>,
  updates: {
    current: "update-current",
    info: "update-info",
    warn: "update-warn",
    urgent: "update-urgent",
    error: "update-error",
    "active-shift": "update-active-shift",
  } as const,
  printVerification: {
    waiting: "print-verification",
    mismatch: "print-mismatch",
    notSscc: "print-not-sscc",
  } as const satisfies Record<PrintVerificationMessage, string>,
  workBlocking: {
    "serial-exhaustion": "serial-exhaustion",
  } as const satisfies Record<WorkBlockingState, string>,
  workOverlay: {
    "exit-pending": "work-exit-pending",
    "clear-confirm": "work-clear-confirm",
  } as const satisfies Record<WorkOverlayState, string>,
} as const;

type Registry = typeof PERSISTENT_STATION_STATE_GALLERY;
export type PersistentGalleryStateId = {
  [Group in keyof Registry]: Registry[Group][keyof Registry[Group]];
}[keyof Registry];

export const PERSISTENT_GALLERY_STATE_IDS = Array.from(
  new Set(
    Object.values(PERSISTENT_STATION_STATE_GALLERY).flatMap((states) => Object.values(states)),
  ),
);
