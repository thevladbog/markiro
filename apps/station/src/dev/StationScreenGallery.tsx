import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Alert, Button, Card, PinPad, SignalOverlay } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db/station-sqlite";
import type { StationInventoryBundleManifest } from "@markiro/domain";

import i18n from "../i18n/index.js";
import type { BoxPrintErrorCode, ClosedBoxSummary } from "../lib/boxes.js";
import type { HardwareContract, UsbPrinterInfo } from "../lib/hardware.js";
import type { HardwareConfig } from "../lib/hardware-config.js";
import type { SqlExecutor } from "../lib/mirror.js";
import type { RecentOperation } from "../lib/journal.js";
import type { InventoryProgress, RecordInventoryScanResult } from "../lib/inventory-journal.js";
import type {
  InventoryRepackScanResult,
  InventoryRepackStateView,
} from "../lib/inventory-repacking.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { StationClient } from "../lib/api-client.js";
import type { ResolvedInventoryTask } from "../lib/floor-task.js";
import type { SoundSettings } from "../lib/signal-sound.js";
import type { StationUpdaterController } from "../lib/use-station-updater.js";
import { updateSeverity, type KnownStationUpdate } from "../lib/update-state.js";
import { ConflictList } from "../pages/ConflictList.js";
import { Enrollment } from "../pages/Enrollment.js";
import { ExceptionFlow } from "../pages/ExceptionFlow.js";
import { InventoryTaskConfirmation } from "../pages/InventoryTaskConfirmation.js";
import { InventoryWorkScreen } from "../pages/InventoryWorkScreen.js";
import { TaskSelection } from "../pages/TaskSelection.js";
import { UpdateCenter } from "../pages/UpdateCenter.js";
import { WorkstationSetup } from "../pages/WorkstationSetup.js";
import { BadgeScanIllustration } from "../ui/BadgeScanIllustration.js";
import { BoxPrintRecovery } from "../ui/BoxPrintRecovery.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { FloorShell } from "../ui/FloorShell.js";
import { OperatorNameSearch } from "../ui/OperatorNameSearch.js";
import { PrintVerification } from "../ui/PrintVerification.js";
import { ShiftCard } from "../ui/ShiftCard.js";
import { StationBrand } from "../ui/StationBrand.js";
import { StationScreen } from "../ui/StationScreen.js";
import { WindowModeControl } from "../ui/WindowModeControl.js";
import { BoxFillInstrument } from "../ui/work/BoxFillInstrument.js";
import { RecentOperations } from "../ui/work/RecentOperations.js";
import { ScanResultInstrument } from "../ui/work/ScanResultInstrument.js";
import { WorkCounters } from "../ui/work/WorkCounters.js";
import { WorkFooter } from "../ui/work/WorkFooter.js";
import { buildWorkLabels } from "../ui/work/work-labels.js";
import {
  getGalleryFixture,
  resolveGalleryRequest,
  type GalleryFixture,
  type GalleryLocale,
  type GalleryRequest,
} from "./gallery-fixtures.js";
import { galleryProductImage, galleryProductImageExecutor } from "./gallery-product-image.js";

export interface StationScreenGalleryProps {
  request: GalleryRequest;
}

export function StationScreenGalleryRoute({ search }: { search: string }) {
  const request = resolveGalleryRequest(true, search);
  return request ? <StationScreenGallery request={request} /> : null;
}

const COPY = {
  ru: {
    back: "Назад",
    continue: "Продолжить",
    page: (page: number) => `Страница ${page} из 2`,
    station: "Демо-станция 01",
    line: "Тестовая линия А",
    operator: "Оператор Тестов",
    shift: "Смена ДЕМО-01",
    longStation: "Станция упаковки готовой продукции 01",
    longLine: "Линия сериализации и агрегации готовой продукции А",
    longOperator: "Александрова-Романовская Екатерина Владимировна",
    longShift: "Смена производства маркированной продукции ДЕМО-01",
    update: "Доступно критическое обновление 0.1.0-beta.123",
    updateShort: "Обновления",
    changeOperator: "Сменить оператора",
  },
  en: {
    back: "Back",
    continue: "Continue",
    page: (page: number) => `Page ${page} of 2`,
    station: "Demo station 01",
    line: "Test line A",
    operator: "Sample Operator",
    shift: "Shift DEMO-01",
    longStation: "Finished goods packaging station 01",
    longLine: "Finished goods serialization and aggregation line A",
    longOperator: "Alexandria Montgomery-Wellington the Third",
    longShift: "Marked goods production shift DEMO-01",
    update: "Critical update 0.1.0-beta.123 is available",
    updateShort: "Updates",
    changeOperator: "Change operator",
  },
} as const;

export function StationScreenGallery({ request }: StationScreenGalleryProps) {
  const fixture = getGalleryFixture(request.state);
  const copy = COPY[request.locale];

  useLayoutEffect(() => {
    void i18n.changeLanguage(request.locale);
  }, [request.locale]);

  if (fixture.kind === "login" || fixture.kind === "pairing") {
    // Neither the real OperatorLogin nor Enrollment ever renders inside the
    // FloorShell station chrome -- App.tsx's `stage === "login"` AND
    // `stage === "pairing"` branches both mount their screen directly under
    // `withWindowChrome`, not `<FloorShell>`, because there is no
    // station/operator/shift identity yet to show in a status bar. Wrapping
    // either in the shared status bar the way every other fixture is wrapped
    // would steal ~80px from this fixed, non-scrolling screen and visibly
    // clip the PIN keypad's last row (login) or show chrome the pairing
    // screen never has -- a capture artifact the real screens never have.
    return (
      <div
        className="station-gallery-capture station-window-frame"
        data-testid="station-screen-gallery"
        data-gallery-state={fixture.id}
        data-gallery-locale={request.locale}
      >
        <GalleryState fixture={fixture} locale={request.locale} />
      </div>
    );
  }

  const syncVariant = fixture.kind === "sync" ? fixture.variant : null;
  const headerVariant = fixture.kind === "floor-header" ? fixture.variant : null;
  // Single source of truth for every fixture that renders `WorkFixture` as an
  // ordinary mid-shift work screen -- "work" itself, plus "box-full" and
  // "offline", which were re-platformed onto the real work screen instead of
  // their own standalone wrapper (see the "box"/"sync" cases in
  // `GalleryState` below). Drives BOTH chrome decisions production ties to
  // an active shift, so the two can never drift apart again: App.tsx sets
  // `statusBarCollapsible={shift !== null}` (collapsed once a shift is
  // active) and unconditionally passes `operatorControl`/`windowControl`
  // whenever authenticated -- the latter is also true during plain shift
  // selection (no WorkFixture yet), which is why `withActiveShiftControls`
  // below still ORs in `fixture.kind === "shift"` on top of this.
  const rendersActiveShiftWorkScreen =
    fixture.kind === "work" ||
    (fixture.kind === "box" && fixture.variant === "full") ||
    syncVariant === "offline" ||
    (fixture.kind === "inventory" &&
      fixture.variant !== "task-selection" &&
      fixture.variant !== "other-line-confirmation");
  const withActiveShiftControls =
    headerVariant !== null || fixture.kind === "shift" || rendersActiveShiftWorkScreen;
  const headerControls = !withActiveShiftControls
    ? null
    : {
        update: {
          severity: "urgent" as const,
          glyph: "!" as const,
          available: true,
          label: copy.update,
          shortLabel: copy.updateShort,
        },
        operatorControl: (
          <Button size="floor" variant="secondary">
            {copy.changeOperator}
          </Button>
        ),
        windowControl: (
          <WindowModeControl
            snapshot={{
              mode: "locked",
              pending: false,
              error: headerVariant === "window-error" ? "exit" : null,
            }}
            activeShift
            onEnter={() => undefined}
            onExit={() => undefined}
            onDismissError={() => undefined}
          />
        ),
      };
  return (
    <div
      className="station-gallery-capture"
      data-testid="station-screen-gallery"
      data-gallery-state={fixture.id}
      data-gallery-locale={request.locale}
    >
      <FloorShell
        stationName={headerVariant ? copy.longStation : copy.station}
        lineName={headerVariant ? copy.longLine : copy.line}
        operatorName={headerVariant ? copy.longOperator : copy.operator}
        shiftLabel={headerVariant ? copy.longShift : copy.shift}
        serverReachability={syncVariant === "offline" ? "unreachable" : "reachable"}
        scanner="connected"
        printerConfigured
        syncPending={syncVariant === "stuck" ? 18 : syncVariant === "offline" ? 7 : 0}
        syncStuck={syncVariant === "stuck"}
        conflicts={fixture.kind === "conflicts" ? 4 : 0}
        statusBarCollapsible={rendersActiveShiftWorkScreen}
        {...(headerControls
          ? {
              update: headerControls.update,
              onOpenUpdates: () => undefined,
              operatorControl: headerControls.operatorControl,
              windowControl: headerControls.windowControl,
            }
          : {})}
      >
        <GalleryState fixture={fixture} locale={request.locale} />
      </FloorShell>
    </div>
  );
}

function GalleryState({ fixture, locale }: { fixture: GalleryFixture; locale: GalleryLocale }) {
  switch (fixture.kind) {
    case "system":
      return <SystemFixture locale={locale} />;
    case "credential-recovery":
      return <CredentialRecoveryFixture phase={fixture.variant} locale={locale} />;
    case "legacy-identity":
      return <LegacyIdentityFixture state={fixture.variant} locale={locale} />;
    case "pairing":
      return <PairingFixture variant={fixture.variant} locale={locale} />;
    case "login":
      return <LoginFixture variant={fixture.variant} locale={locale} />;
    case "new-shift":
      return <NewShiftFixture view={fixture.variant} locale={locale} />;
    case "shift":
      return <ShiftFixture variant={fixture.variant} locale={locale} />;
    case "work":
      return <WorkFixture mode={fixture.variant} locale={locale} />;
    case "work-overlay":
      return <WorkOverlayFixture overlay={fixture.variant} locale={locale} />;
    case "signal":
      return <SignalFixture tone={fixture.variant} locale={locale} />;
    case "box":
      // A full box is a moment inside an otherwise ordinary scanning shift --
      // the real BoxFillInstrument never renders on its own screen the way
      // "empty" does here for isolated component review; it always sits
      // inside the full work screen next to the scan result and counters.
      return fixture.variant === "full" ? (
        <WorkFixture mode="box-full" locale={locale} />
      ) : (
        <BoxFixture locale={locale} />
      );
    case "box-print-recovery":
      return <BoxPrintRecoveryFixture variant={fixture.variant} />;
    case "serial-recovery":
      return <SerialRecoveryFixture locale={locale} />;
    case "exception":
      return <ExceptionFixture stage={fixture.variant} locale={locale} />;
    case "conflicts":
      return <ConflictFixture variant={fixture.variant} locale={locale} />;
    case "setup":
      return <SetupFixture tab={fixture.variant} locale={locale} />;
    case "sync":
      // "offline" is not a dedicated interstitial screen in production --
      // App.tsx never navigates away from the active work screen when the
      // server becomes unreachable; it stays on WorkScreen and only the
      // status bar's "Сервер"/"Синхронизация" indicators and the counters'
      // "Не отправлено" line change (see the design spec's "Работа без
      // сети" section). Only the genuinely stuck-queue interstitial
      // (`sync-stuck`) is its own screen.
      return fixture.variant === "offline" ? (
        <WorkFixture mode="offline" locale={locale} />
      ) : (
        <SyncFixture locale={locale} />
      );
    case "print":
      return <PrintFixture variant={fixture.variant} />;
    case "updates":
      return <UpdateFixture variant={fixture.variant} />;
    case "inventory":
      return <InventoryFixture variant={fixture.variant} />;
    case "floor-header":
      return <FloorHeaderFixture locale={locale} />;
    case "long-copy":
      return <LongCopyFixture locale={fixture.variant === "en" ? "en" : "ru"} />;
  }
}

const GALLERY_INVENTORY_DATE = "2026-08-19";
const GALLERY_INVENTORY_SSCC = "046006820000000015";
const GALLERY_INVENTORY_TASK = {
  inventoryId: "11111111-1111-4111-8111-111111111111",
  inventoryNumber: "INV-00047",
  productName: "Вода питьевая 0,5 л / Drinking water 0.5 L",
  mode: "check" as const,
  lineId: "22222222-2222-4222-8222-222222222222",
  lineName: "Линия розлива 2 / Filling line 2",
  productionDateFrom: GALLERY_INVENTORY_DATE,
  productionDateTo: "2026-09-19",
};

const GALLERY_CHECK_MANIFEST: StationInventoryBundleManifest & { mode: "check" } = {
  ...GALLERY_INVENTORY_TASK,
  snapshotId: "44444444-4444-4444-8444-444444444444",
  snapshotRevision: 1,
  snapshotFixedAt: "2026-08-19T10:00:00.000Z",
  combinedDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  codeCount: 124,
  productId: "55555555-5555-4555-8555-555555555555",
  productPrintName: null,
  egaisCode: null,
  shelfLifeDays: null,
  gtin14: "04600000000015",
  boxCapacity: 20,
  boxLabelTemplate: null,
  limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
  sscc: null,
  ssccRevokedFrom: [],
  ssccRevokedBlocks: [],
};

const GALLERY_REPACK_MANIFEST: StationInventoryBundleManifest & { mode: "repack" } = {
  ...GALLERY_CHECK_MANIFEST,
  inventoryNumber: "INV-R-00012",
  mode: "repack",
  productPrintName: GALLERY_INVENTORY_TASK.productName,
  boxLabelTemplate: {
    id: "66666666-6666-4666-8666-666666666666",
    name: "Gallery box label",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  },
  sscc: {
    allocationOrder: 1,
    issuerPrefix: "460068200",
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 100,
    consumedThroughSerial: null,
  },
};

const galleryInventoryClient: StationClient = {
  get<T>(path: string): Promise<T> {
    if (path === "/shifts") return Promise.resolve({ items: [] } as T);
    if (path === "/station/inventory-tasks") {
      return Promise.resolve({ items: [GALLERY_INVENTORY_TASK] } as T);
    }
    return Promise.reject(new Error(`gallery: unexpected inventory GET ${path}`));
  },
  post<T>(path: string): Promise<T> {
    return Promise.reject(new Error(`gallery: unexpected inventory POST ${path}`));
  },
  download(): Promise<Blob> {
    return Promise.reject(new Error("gallery: inventory download is disabled"));
  },
  whoami() {
    return Promise.resolve({ ok: true as const });
  },
};

const galleryInventoryExecutor: SqlExecutor = {
  all<T>(): Promise<T[]> {
    return Promise.resolve([]);
  },
  run(): Promise<void> {
    return Promise.resolve();
  },
};

const galleryInventoryScanSource: ScanSource = {
  start() {
    return () => undefined;
  },
};

function InventoryFixture({ variant }: { variant: string }) {
  switch (variant) {
    case "task-selection":
      return <InventoryTaskSelectionFixture />;
    case "other-line-confirmation":
      return <InventoryOtherLineConfirmationFixture />;
    case "simple-box-accepted":
    case "duplicate-other-terminal":
    case "known-ineligible":
    case "protected-moving-by-ud":
    case "not-in-snapshot":
    case "production-date-change":
      return <SimpleInventoryFixture variant={variant} />;
    default:
      return <RepackInventoryFixture variant={variant} />;
  }
}

function InventoryTaskSelectionFixture() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click();
  }, []);
  return (
    <div ref={rootRef} style={{ width: "100%", height: "100%", minHeight: 0 }}>
      <TaskSelection
        client={galleryInventoryClient}
        exec={galleryInventoryExecutor}
        source={galleryInventoryScanSource}
        operatorId="gallery-operator"
        currentLineName="Линия розлива 1 / Filling line 1"
        onShiftSelected={() => undefined}
        onInventorySelected={() => undefined}
        onNew={() => undefined}
      />
    </div>
  );
}

function InventoryOtherLineConfirmationFixture() {
  const resolved: ResolvedInventoryTask = {
    task: GALLERY_INVENTORY_TASK,
    deviceLineId: "33333333-3333-4333-8333-333333333333",
    requiresDifferentLineConfirmation: true,
  };
  return (
    <InventoryTaskConfirmation
      resolved={resolved}
      currentLineName="Линия розлива 1 / Filling line 1"
      busy={false}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />
  );
}

function SimpleInventoryFixture({ variant }: { variant: string }) {
  const result = galleryInventoryScanResult(variant);
  const progress: InventoryProgress = {
    verified: variant === "simple-box-accepted" ? 20 : 124,
    discrepancies: variant === "known-ineligible" || variant === "not-in-snapshot" ? 1 : 3,
    protected: variant === "protected-moving-by-ud" ? 1 : 2,
    claimedByDevice: variant === "simple-box-accepted" ? 20 : 87,
    acceptedBoxes: variant === "simple-box-accepted" ? 1 : 4,
    acceptedItems: variant === "simple-box-accepted" ? 20 : 83,
  };
  return (
    <InventoryWorkScreen
      exec={galleryInventoryExecutor}
      inventory={GALLERY_CHECK_MANIFEST}
      deviceId="gallery-terminal-a"
      operatorId="gallery-operator"
      source={galleryInventoryScanSource}
      galleryState={{
        mode: "check",
        productionDate: GALLERY_INVENTORY_DATE,
        pendingSync: 0,
        progress,
        recent: [],
        result,
        dateDialog: variant === "production-date-change",
      }}
    />
  );
}

function galleryInventoryScanResult(variant: string): RecordInventoryScanResult | null {
  const common = {
    serialSuffix: "…0019",
    ssccSuffix: null,
    boxChildCount: 0,
  };
  switch (variant) {
    case "simple-box-accepted":
      return {
        ...common,
        verdict: "expected",
        scanKind: "known_box",
        serialSuffix: null,
        ssccSuffix: "…0015",
        claimedCount: 20,
        boxChildCount: 20,
        firstWinning: null,
      };
    case "duplicate-other-terminal":
      return {
        ...common,
        verdict: "duplicate",
        scanKind: "item",
        claimedCount: 0,
        firstWinning: {
          codeHash: "gallery-safe-code-hash",
          eventId: "gallery-winning-event",
          deviceId: "gallery-terminal-b",
          scannedAt: "2026-08-19T10:00:00.000Z",
        },
      };
    case "known-ineligible":
      return {
        ...common,
        verdict: "known-ineligible",
        scanKind: "item",
        claimedCount: 0,
        firstWinning: null,
      };
    case "protected-moving-by-ud":
      return {
        ...common,
        verdict: "protected",
        scanKind: "item",
        claimedCount: 0,
        firstWinning: null,
      };
    case "not-in-snapshot":
      return {
        ...common,
        verdict: "unknown",
        scanKind: "item",
        claimedCount: 0,
        firstWinning: null,
      };
    default:
      return null;
  }
}

function RepackInventoryFixture({ variant }: { variant: string }) {
  const state = galleryRepackState(variant);
  const result = galleryRepackResult(variant);
  const corrections = variant === "repack-corrections";
  const reprint = variant === "same-sscc-reprint-confirmation";
  const printRecovery = variant === "print-recovery";
  const leaveOpen = variant === "leave-open-box";
  return (
    <InventoryWorkScreen
      exec={galleryInventoryExecutor}
      inventory={GALLERY_REPACK_MANIFEST}
      deviceId="gallery-terminal-a"
      operatorId="gallery-operator"
      source={galleryInventoryScanSource}
      galleryState={{
        mode: "repack",
        productionDate: GALLERY_INVENTORY_DATE,
        pendingSync: 0,
        state,
        recent: [],
        result,
        leaveFailed: leaveOpen,
        correctionsDialog: corrections || reprint,
        printDisplay: printRecovery
          ? {
              attemptId: "gallery-print-attempt",
              attemptNumber: 1,
              attemptState: "failed",
              kind: "initial",
              state: "failed",
              errorCode: "transport_failed",
              boxId: "gallery-repack-box",
              sscc: GALLERY_INVENTORY_SSCC,
              quantity: 20,
              productionDate: GALLERY_INVENTORY_DATE,
            }
          : null,
        reprintSscc: reprint ? GALLERY_INVENTORY_SSCC : "",
        reprintCandidate: reprint
          ? {
              boxId: "gallery-repack-box",
              sscc: GALLERY_INVENTORY_SSCC,
              quantity: 20,
              productionDate: GALLERY_INVENTORY_DATE,
            }
          : null,
      }}
    />
  );
}

function galleryRepackState(variant: string): InventoryRepackStateView {
  if (variant === "repack-awaiting-old-box") return { phase: "awaiting-old-box", box: null };
  const itemCount =
    variant === "repack-capacity-20" || variant === "repack-box-ready"
      ? variant === "repack-box-ready"
        ? 20
        : 12
      : variant === "leave-open-box"
        ? 4
        : 7;
  return {
    phase: variant === "repack-box-ready" ? "closed-pending-print" : "scanning",
    box: {
      boxId: "gallery-repack-box",
      oldSsccContext: "…0014",
      newSscc: GALLERY_INVENTORY_SSCC,
      productionDate: GALLERY_INVENTORY_DATE,
      capacity: 20,
      itemCount,
      lastItemId: "gallery-repack-item",
      state: variant === "repack-box-ready" ? "closed" : "open",
      printState: variant === "repack-box-ready" ? "pending" : "not_ready",
      printErrorCode: null,
      ownerDeviceId: "gallery-terminal-a",
    },
  };
}

function galleryRepackResult(variant: string): InventoryRepackScanResult | null {
  if (variant === "repack-scanning") {
    return {
      verdict: "old-box-selected",
      boxId: "gallery-repack-box",
      newSscc: GALLERY_INVENTORY_SSCC,
      itemCount: 0,
      printState: "not_ready",
      sourceParentMismatch: false,
    };
  }
  if (variant === "repack-capacity-20") {
    return {
      verdict: "expected",
      boxId: "gallery-repack-box",
      newSscc: GALLERY_INVENTORY_SSCC,
      itemCount: 12,
      printState: "not_ready",
      sourceParentMismatch: false,
    };
  }
  if (variant === "repack-box-ready") {
    return {
      verdict: "capacity-closed",
      boxId: "gallery-repack-box",
      newSscc: GALLERY_INVENTORY_SSCC,
      itemCount: 20,
      printState: "pending",
      sourceParentMismatch: false,
    };
  }
  return null;
}

function FloorHeaderFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
  return (
    <StationScreen title={ru ? "Проверка верхней панели" : "Floor header review"}>
      <div className="gallery-centered-card">
        <p className="gallery-state-message">
          {ru
            ? "Проверьте читаемость действий и отсутствие перекрытий во всех поддерживаемых разрешениях."
            : "Check action readability and absence of overlap at every supported viewport."}
        </p>
      </div>
    </StationScreen>
  );
}

function SystemFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
  return (
    <StationScreen title={ru ? "Запуск рабочего места" : "Starting workstation"}>
      <div className="gallery-centered-card">
        <p className="gallery-state-message" role="status">
          {ru ? "Загрузка локального рабочего состояния…" : "Loading local workstation state…"}
        </p>
      </div>
    </StationScreen>
  );
}

function CredentialRecoveryFixture({ phase, locale }: { phase: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const failed = phase === "failed";
  const ready = phase === "ready";
  return (
    <StationScreen
      title={ru ? "Восстановление доступа" : "Credential recovery"}
      actions={
        failed ? <GalleryFooter locale={locale} primary={ru ? "Повторить" : "Retry"} /> : undefined
      }
    >
      <div className="gallery-centered-card">
        <Alert tone={failed ? "error" : ready ? "warn" : "info"}>
          <p>
            {failed
              ? ru
                ? "Не удалось подготовить локальные данные. Повторите попытку."
                : "Local work could not be prepared. Try again."
              : ready
                ? ru
                  ? "Сохранено: 12 сканирований, 2 короба и 1 исключение. Подключите станцию повторно."
                  : "Retained: 12 scans, 2 boxes, and 1 exception. Pair the station again."
                : ru
                  ? "Локальные операции блокируются и подготавливаются к безопасному восстановлению."
                  : "Local operations are being sealed for safe recovery."}
          </p>
        </Alert>
      </div>
    </StationScreen>
  );
}

function LegacyIdentityFixture({ state, locale }: { state: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const rejected = state === "rejected";
  const degraded = state === "degraded";
  return (
    <StationScreen
      title={ru ? "Проверка рабочего места" : "Workstation identity check"}
      actions={
        degraded ? (
          <GalleryFooter locale={locale} primary={ru ? "Повторить" : "Retry"} />
        ) : undefined
      }
    >
      <div className="gallery-centered-card">
        <Alert tone={rejected ? "error" : degraded ? "warn" : "info"}>
          {rejected
            ? ru
              ? "Старые учётные данные отклонены. Требуется сервисное восстановление."
              : "Legacy credentials were rejected. Service recovery is required."
            : degraded
              ? ru
                ? "Сервер временно недоступен. Производственные данные сохранены локально."
                : "The server is temporarily unavailable. Production data remains local."
              : ru
                ? "Проверяем привязку станции…"
                : "Checking workstation identity…"}
        </Alert>
      </div>
    </StationScreen>
  );
}

/** The real cabinet address `enroll.cabinetAddress` names, reused as the
 * synthetic pairing server for the "waiting" fixture -- no request is ever
 * sent from the gallery (nothing simulates a submit), so this only needs to
 * be a plausible, non-empty URL that keeps `pairingServerUrl` truthy the way
 * a fresh, deployment-configured station's would be. */
const GALLERY_PAIRING_SERVER_URL = "https://admin.markiro.app";

/**
 * Mirrors Enrollment.tsx's own render tree for the two states this gallery
 * still needs to be faithful to (see MKR-INS-04 Task 1's audit):
 *
 * - "waiting" mounts the real component directly -- App.tsx's `stage ===
 *   "pairing"` branch passes exactly this shape of props (machineId,
 *   pairingServerUrl, onSetup) before any code has been entered, so the
 *   component's own default state already IS the waiting screen.
 * - "success" cannot be reached by driving the real component end to end:
 *   `redeem()` needs a live pairing server response AND Tauri's local
 *   SQLite/config IPC (`persistStationProvisioning`/`writeConfig`) to
 *   resolve, neither of which exists in a plain dev-mode browser tab. This
 *   stage is instead mirrored, line for line, from Enrollment.tsx's own
 *   success branch (the `state === "success"` case in its final return).
 *
 * The other pairing variants (redeeming/error/service/recovery) are outside
 * this audit's scope and keep their previous synthetic-card rendering below.
 */
function PairingFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const t = i18n.getFixedT(locale);

  if (variant === "waiting") {
    return (
      <Enrollment
        machineId="gallery-demo-machine"
        pairingServerUrl={GALLERY_PAIRING_SERVER_URL}
        onEnrolled={() => undefined}
        onSetup={() => undefined}
      />
    );
  }

  if (variant === "success") {
    return (
      <main className="station-enrollment" aria-labelledby="station-enrollment-title">
        <aside className="station-enrollment__context">
          <StationBrand descriptor={t("app.stationDescriptor")} />
          <div className="station-enrollment__intro">
            <p>{t("app.stationPurpose")}</p>
            <p className="station-enrollment__cabinet">{t("enroll.cabinetAddress")}</p>
          </div>
          <ol className="station-enrollment__steps">
            <li>{t("enroll.steps.one")}</li>
            <li>{t("enroll.steps.two")}</li>
            <li>{t("enroll.steps.three")}</li>
          </ol>
        </aside>
        <section className="station-enrollment__entry">
          <div className="station-enrollment__success" role="status">
            <h1 id="station-enrollment-title">{t("enroll.success")}</h1>
            <p>{ru ? "Демо-станция 01 — Тестовая линия А" : "Demo station 01 — Test line A"}</p>
          </div>
        </section>
      </main>
    );
  }

  const messages: Record<string, { tone: "info" | "error" | "ok" | "warn"; text: string }> = {
    redeeming: {
      tone: "info",
      text: ru ? "Проверяем код подключения…" : "Checking pairing code…",
    },
    error: {
      tone: "error",
      text: ru ? "Код истёк. Запросите новый." : "Code expired. Request a new one.",
    },
    service: {
      tone: "warn",
      text: ru ? "Сервисное подключение для восстановления" : "Service recovery connection",
    },
    recovery: {
      tone: "warn",
      text: ru
        ? "На устройстве сохранены 12 сканирований, 2 короба и 1 исключение."
        : "This device retains 12 scans, 2 boxes, and 1 exception.",
    },
  };
  const message = messages[variant] ?? {
    tone: "info" as const,
    text: ru ? "Введите код подключения" : "Enter pairing code",
  };
  return (
    <StationScreen
      title={ru ? "Подключение рабочего места" : "Pair workstation"}
      actions={<GalleryFooter locale={locale} primary={ru ? "Подключить" : "Pair"} />}
    >
      <div className="gallery-centered-card">
        <Card padding="24px" className="gallery-card">
          <Alert tone={message.tone}>{message.text}</Alert>
          <div className="gallery-code" aria-label={ru ? "Код подключения" : "Pairing code"}>
            {variant === "service" ? "DEMO-SERVICE-ENDPOINT" : "0000 0000"}
          </div>
          <p>{ru ? "Синтетический код для проверки макета" : "Synthetic layout-review code"}</p>
        </Card>
      </div>
    </StationScreen>
  );
}

const RU_SEARCH_ROSTER_NAMES = [
  "Александрова-Романовская Екатерина Владимировна",
  "Иванов Алексей Сергеевич",
  "Петрова Мария Андреевна",
  "Смирнов Александр Олегович",
  "Фёдорова Елена Викторовна",
];
const EN_SEARCH_ROSTER_NAMES = [
  "Alexandria Montgomery-Wellington the Third",
  "Alex Johnson",
  "Alice Peterson",
  "Alicia Smith",
  "Alison Foster",
];

/** Every entry matches the fixed query below through the real `searchOperatorsByName`. */
function galleryOperatorRoster(locale: GalleryLocale): OperatorMirrorRecord[] {
  const names = locale === "ru" ? RU_SEARCH_ROSTER_NAMES : EN_SEARCH_ROSTER_NAMES;
  return names.map((name, index) => ({
    operatorId: `gallery-search-operator-${index}`,
    name,
    login: String(100234001 + index),
    role: "packer",
    pinHash: "gallery-demo-pin-hash",
    badgeHash: null,
    active: true,
  }));
}

/** Mirrors OperatorLogin.tsx's own render tree (composed from the same real
 * sub-components) instead of hand-copied markup, so the captured screenshot
 * matches the current badge-first sign-in flow stage for stage. */
function LoginFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const t = i18n.getFixedT(locale);
  const stage: "badge" | "login" | "pin" | "search" =
    variant === "badge"
      ? "badge"
      : variant === "pin"
        ? "pin"
        : variant === "name-search"
          ? "search"
          : "login";
  const prompt =
    stage === "badge"
      ? t("login.badgePrimary")
      : stage === "login"
        ? t("login.loginPrompt")
        : stage === "search"
          ? t("login.nameSearchPrompt")
          : t("login.pinPrompt");
  const loginValue = "0042";
  const pinValue = "1234";
  const roster = galleryOperatorRoster(locale);
  const searchQuery = locale === "ru" ? "ов" : "Al";

  return (
    <main className="operator-login" aria-labelledby="gallery-operator-login-title">
      <header className="operator-login__header">
        <StationBrand
          compact
          className="operator-login__brand"
          descriptor={t("app.stationDescriptor")}
        />
        <div className="operator-login__prompt">
          <h1 id="gallery-operator-login-title">{t("login.title")}</h1>
          <p>{prompt}</p>
        </div>
      </header>

      <div
        className="operator-login__message"
        aria-live="polite"
        style={{ minHeight: 64, overflow: "hidden" }}
      />

      {stage === "badge" ? (
        <div
          className="operator-login__scanner-status"
          role="status"
          aria-label={t("login.badgeReady")}
        >
          <span className="operator-login__scanner-status-icon" aria-hidden="true">
            ✓
          </span>
          <span>{t("login.badgeReady")}</span>
        </div>
      ) : null}

      <div
        className={`operator-login__body${stage === "badge" ? " operator-login__body--badge" : ""}`}
      >
        {stage === "search" ? (
          // `display: contents` keeps this wrapper (added only to give the
          // capture a stable query hook) out of the box model, so
          // `.operator-name-search` still lands directly in
          // `.operator-login__body`'s grid the way production's untouched
          // JSX does -- required for its `grid-row: 1 / -1; height: 100%`.
          <div data-testid="gallery-name-search-results" style={{ display: "contents" }}>
            <OperatorNameSearch
              operators={roster}
              query={searchQuery}
              onQueryChange={() => undefined}
              onSelect={() => undefined}
              disabled={false}
            />
          </div>
        ) : (
          <>
            {stage !== "badge" ? (
              <div
                className="operator-login__readout"
                aria-label={stage === "login" ? "login" : "pin"}
              >
                {stage === "login" ? loginValue : "•".repeat(pinValue.length)}
              </div>
            ) : null}
            <div className="operator-login__keypad-zone">
              {stage === "badge" ? (
                <div className="operator-login__badge-panel">
                  <BadgeScanIllustration />
                  <div className="operator-login__badge-copy">
                    <h2>{t("login.badgeInstruction")}</h2>
                    <p>{t("login.badgeExplanation")}</p>
                  </div>
                </div>
              ) : (
                <PinPad
                  value={stage === "login" ? loginValue : pinValue}
                  onChange={() => undefined}
                  maxLength={stage === "login" ? 12 : 6}
                  size="floor"
                  ariaLabel={stage === "login" ? t("login.loginKeypad") : t("login.pinKeypad")}
                  backspaceLabel={t("login.backspace")}
                  clearLabel={t("login.clear")}
                />
              )}
            </div>
          </>
        )}
      </div>

      <div
        className="operator-login__actions"
        style={{ "--operator-login-action-columns": stage === "login" ? 3 : 2 } as CSSProperties}
      >
        {stage === "badge" ? (
          <>
            <Button size="floor" variant="secondary">
              {t("login.findByName")}
            </Button>
            <Button size="floor">{t("login.useLogin")}</Button>
          </>
        ) : stage === "login" ? (
          <>
            <Button size="floor" variant="secondary">
              {t("login.back")}
            </Button>
            <Button size="floor" variant="secondary">
              {t("login.findByName")}
            </Button>
            <Button size="floor">{t("login.next")}</Button>
          </>
        ) : stage === "pin" ? (
          <>
            <Button size="floor" variant="secondary">
              {t("login.back")}
            </Button>
            <Button size="floor">{t("login.submit")}</Button>
          </>
        ) : (
          <>
            <Button size="floor" variant="secondary">
              {t("login.back")}
            </Button>
            <Button size="floor">{t("login.useLogin")}</Button>
          </>
        )}
      </div>
    </main>
  );
}

function NewShiftFixture({ view, locale }: { view: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const notFound = view === "not-found";
  const found = view === "found";
  const template = view === "template";
  return (
    <StationScreen
      title={ru ? "Новая смена" : "New shift"}
      actions={
        <GalleryFooter
          locale={locale}
          primary={
            notFound
              ? ru
                ? "Сканировать снова"
                : "Scan again"
              : found || template
                ? ru
                  ? "Начать смену"
                  : "Start shift"
                : ru
                  ? "Найти товар"
                  : "Find product"
          }
        />
      }
    >
      <div className="gallery-new-shift">
        {template ? (
          <>
            <h2 className="new-shift__template-title">
              {ru ? "Шаблон этикетки короба" : "Box label template"}
            </h2>
            <div className="new-shift__templates">
              <button
                type="button"
                className="new-shift__template new-shift__template--selected"
                aria-pressed="true"
              >
                <span className="new-shift__template-name">
                  {ru ? "Коробка 58×40 (203 dpi)" : "Box 58×40 (203 dpi)"}
                </span>
                <span className="new-shift__template-meta">
                  {ru ? "58×40 мм · 203 dpi" : "58×40 mm · 203 dpi"}
                </span>
                <span className="new-shift__template-badge">{ru ? "По умолчанию" : "Default"}</span>
              </button>
              <button type="button" className="new-shift__template" aria-pressed="false">
                <span className="new-shift__template-name">
                  {ru ? "Паллета 100×80 (300 dpi)" : "Pallet 100×80 (300 dpi)"}
                </span>
                <span className="new-shift__template-meta">
                  {ru ? "100×80 мм · 300 dpi" : "100×80 mm · 300 dpi"}
                </span>
              </button>
            </div>
          </>
        ) : notFound ? (
          <Alert tone="warn" title={ru ? "Товар не найден" : "Product not found"}>
            <p>GTIN: 04607000000999</p>
            <p>
              {ru
                ? "Проверьте код или обратитесь к мастеру."
                : "Check the code or contact a supervisor."}
            </p>
          </Alert>
        ) : found ? (
          <>
            <Card className="gallery-card" title={ru ? "Тестовый товар А" : "Sample product A"}>
              <p className="gallery-mono">04607000000042</p>
            </Card>
            <div className="gallery-two-actions">
              <Button size="floor">{ru ? "Проверка" : "Validation"}</Button>
              <Button size="floor" variant="secondary">
                {ru ? "Агрегация" : "Aggregation"}
              </Button>
            </div>
          </>
        ) : (
          <div className="gallery-search-field">
            <span>{ru ? "GTIN товара" : "Product GTIN"}</span>
            <strong className="gallery-mono">04607000000042</strong>
          </div>
        )}
      </div>
    </StationScreen>
  );
}

function ShiftFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  if (variant === "loading" || variant === "read-error" || variant === "empty") {
    return (
      <StationScreen
        title={ru ? "Смены" : "Shifts"}
        actions={<GalleryFooter locale={locale} primary={ru ? "Новая смена" : "New shift"} />}
      >
        <div className="gallery-centered-card">
          {variant === "read-error" ? (
            <Alert
              tone="error"
              action={
                <Button size="floor" variant="secondary">
                  {ru ? "Повторить" : "Retry"}
                </Button>
              }
            >
              {ru ? "Не удалось загрузить смены" : "Could not load shifts"}
            </Alert>
          ) : (
            <p
              className="gallery-state-message"
              role={variant === "loading" ? "status" : undefined}
            >
              {variant === "loading"
                ? ru
                  ? "Загрузка смен…"
                  : "Loading shifts…"
                : ru
                  ? "Открытых смен нет"
                  : "There are no open shifts"}
            </p>
          )}
        </div>
      </StationScreen>
    );
  }
  const page = variant === "2" ? 2 : 1;
  const shifts =
    page === 1
      ? [
          {
            number: "AUG26-041",
            productName: ru
              ? "Молоко ультрапастеризованное безлактозное обогащённое витаминами A и D для детского питания с массовой долей жира 3,2%, 930 мл"
              : "Ultra-pasteurized lactose-free milk enriched with vitamins A and D for children, 3.2% fat, 930 ml",
            active: false,
            mode: "validation" as const,
            plannedQty: 10_000,
          },
          {
            number: "AUG26-040/S",
            productName: ru
              ? "Пиво светлое фильтрованное пастеризованное «Жигулёвское», 0,5 л"
              : "Zhigulevskoye light filtered pasteurized beer, 0.5 l",
            active: true,
            mode: "aggregation" as const,
            plannedQty: null,
          },
        ]
      : [
          {
            number: "AUG26-039",
            productName: ru ? "Вода питьевая газированная, 1 л" : "Sparkling drinking water, 1 l",
            active: false,
            mode: "validation" as const,
            plannedQty: 4_000,
          },
          {
            number: "AUG26-038",
            productName: ru ? "Квас хлебный фильтрованный, 1,5 л" : "Filtered bread kvass, 1.5 l",
            active: false,
            mode: "aggregation" as const,
            plannedQty: 2_400,
          },
        ];
  return (
    <StationScreen
      title={ru ? "Смены" : "Shifts"}
      header={<div className="shift-selection__message" aria-hidden="true" />}
      actions={<GalleryFooter locale={locale} primary={ru ? "Новая смена" : "New shift"} />}
    >
      <div className="shift-selection__content">
        <div className="shift-selection__slot">
          <div className="shift-selection__grid">
            {shifts.map((shift, index) => (
              <ShiftCard
                key={shift.number}
                number={shift.number}
                productName={shift.productName}
                plannedDate={`2026-08-${String(21 - index - (page - 1) * 2).padStart(2, "0")}`}
                productionDate={index === 0 ? "2026-08-15" : null}
                productionDateLabel={ru ? "Производство" : "Produced"}
                locale={locale}
                plannedQty={shift.plannedQty}
                mode={shift.mode}
                status={shift.active ? "active" : "planned"}
                modeLabel={
                  shift.mode === "aggregation"
                    ? ru
                      ? "Агрегация"
                      : "Aggregation"
                    : ru
                      ? "Валидация"
                      : "Validation"
                }
                statusLabel={
                  shift.active ? (ru ? "Активна" : "Active") : ru ? "Запланирована" : "Planned"
                }
                plannedLabel={ru ? "план" : "plan"}
                noPlanLabel={ru ? "без плана" : "no plan"}
                counterpartyName={null}
                counterpartyLabel={ru ? "Для" : "For"}
                actionLabel={
                  shift.active ? (ru ? "Присоединиться" : "Join") : ru ? "Открыть" : "Open"
                }
                active={shift.active}
                disabled={false}
                onSelect={() => undefined}
                exec={galleryProductImageExecutor}
                productId={`gallery-shift-product-${page}-${index}`}
                image={galleryProductImage}
              />
            ))}
          </div>
        </div>
        <GalleryPager
          page={page}
          previousLabel={ru ? "Назад" : "Previous"}
          nextLabel={ru ? "Далее" : "Next"}
          pageLabel={COPY[locale].page(page)}
        />
      </div>
    </StationScreen>
  );
}

function WorkFixture({ mode, locale }: { mode: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const t = i18n.getFixedT(locale);
  // "box-full" is a filled box moments before it closes -- still an ordinary
  // scanning shift, just with the box panel at capacity, so it shares the
  // aggregation branch's box panel below.
  const boxFull = mode === "box-full";
  const aggregation = mode.startsWith("aggregation") || boxFull;
  // "waiting" is a freshly opened shift: no scan has landed yet, so the
  // journal-backed counters and recent-operations list must be empty too --
  // not the mid-shift numbers a screen with an actual scan history would show.
  // "ok" (validation-mode, no box panel) falls through here as non-waiting on
  // purpose: it needs `operations[0]` populated below so ScanResultInstrument
  // renders the real inline compact-success panel -- the accepted verdict's
  // ONLY visible feedback in production (see the module doc comment above
  // `SignalFixture`).
  const waiting = mode === "validation" || mode === "aggregation-waiting";
  const workLabels = buildWorkLabels(t, locale, 1);
  const operations = waiting ? [] : galleryRecentOperations();
  // Validation-mode shifts carry a plan target the way the shift list's own
  // validation-mode card does (see ShiftFixture's AUG26-041); aggregation-mode
  // shifts in this gallery have no plan, matching the shift list there too.
  const plannedQty = mode === "validation" ? 10_000 : undefined;
  // A grouped, >100-capacity box (see BoxFillInstrument's own `grouped` rule)
  // exercises the same viewport-review case the standalone "box-empty"
  // fixture already covers for the empty end of the range. The ordinary
  // aggregation fixture is a ten-place box — the production norm on the line —
  // which exercises the large numbered-segment mode; the 11–100 rows-of-ten
  // mode stays covered by "box-empty"'s 20-place panel.
  const boxCapacity = boxFull ? 120 : 10;
  const boxItemCount = boxFull ? 120 : 2;
  return (
    <main className="work-screen" aria-label={ru ? "Тестовый товар А" : "Sample product A"}>
      <div className="work-screen__content">
        <div className="work-screen__instruments">
          <div className="work-screen__primary">
            <ScanResultInstrument
              exec={galleryProductImageExecutor}
              productId="gallery-product-dicky-crest"
              image={galleryProductImage}
              productName={ru ? "Тестовый товар А" : "Sample product A"}
              counterpartyName={ru ? "ООО «Тестовый производитель»" : "Sample Manufacturer Ltd"}
              plannedQty={plannedQty}
              planLabel={t("work.plan")}
              gtin="04607000000042"
              operation={waiting ? null : (operations[0] ?? null)}
              labels={workLabels.status}
              showVerdict={!aggregation}
            />
            {aggregation ? (
              <BoxFillInstrument
                box={{ boxId: "gallery-box-1", itemCount: boxItemCount }}
                ordinal={1}
                acceptedToken={boxFull ? "gallery-box-full" : "gallery-accepted-2"}
                capacity={boxCapacity}
                canUndo
                labels={workLabels.box}
                lastAccepted={
                  waiting
                    ? null
                    : operations[0]?.identity
                      ? { serial: operations[0].identity.serial }
                      : null
                }
                verdictLabels={{ ok: workLabels.status.ok, waiting: workLabels.status.waiting }}
                onClose={() => undefined}
                onUndo={() => undefined}
                onClear={() => undefined}
              />
            ) : null}
          </div>
          <aside className="work-screen__secondary" aria-label={workLabels.summary}>
            <WorkCounters
              accepted={waiting ? 0 : 1248}
              rejected={waiting ? 0 : 3}
              pendingSync={mode === "offline" ? 7 : 0}
              locale={workLabels.locale}
              labels={workLabels.counters}
            />
            <RecentOperations
              operations={operations}
              labels={workLabels.recent}
              statusLabels={workLabels.status}
              locale={workLabels.locale}
            />
          </aside>
        </div>
      </div>
      <WorkFooter
        labels={workLabels.footer}
        onExceptions={() => undefined}
        onPause={() => undefined}
        onClose={() => undefined}
      />
    </main>
  );
}

function galleryRecentOperations(): RecentOperation[] {
  const identityForSerial = (serial: string) => {
    const crypto = [
      { ai: "91" as const, value: "ABCD" },
      {
        ai: "92" as const,
        value: "TEST-LONG-CRYPTO-TAIL-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789",
      },
      { ai: "93" as const, value: "XYZ1" },
    ];
    return {
      gtin14: "04607000000042",
      serial,
      crypto,
      normalized: [
        "(01)04607000000042",
        `(21)${serial}`,
        ...crypto.map(({ ai, value }) => `(${ai})${value}`),
      ].join(" "),
    };
  };
  return Array.from({ length: 6 }, (_, index) => ({
    verdict: "ok",
    scannedAt: `2026-08-13T14:32:0${8 - index}+03:00`,
    codeSuffix: null,
    identity: identityForSerial(`DEMO-SERIAL-00012${8 - index}`),
  }));
}

function WorkOverlayFixture({ overlay, locale }: { overlay: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const clear = overlay === "clear-confirm";
  return (
    <StationScreen title={ru ? "Рабочая смена" : "Active shift"}>
      <div className="gallery-centered-card">
        <Alert
          tone="warn"
          title={
            clear
              ? ru
                ? "Очистить короб?"
                : "Clear the box?"
              : ru
                ? "Есть неотправленные операции"
                : "Operations are still pending"
          }
        >
          <p>
            {clear
              ? ru
                ? "Все коды текущего тестового короба будут освобождены."
                : "All codes in the current synthetic box will be released."
              : ru
                ? "7 операций сохранены локально и ещё не синхронизированы."
                : "7 operations are stored locally and have not synced yet."}
          </p>
          <div className="gallery-two-actions">
            <Button size="floor">
              {clear ? (ru ? "Очистить" : "Clear") : ru ? "Выйти" : "Exit"}
            </Button>
            <Button size="floor" variant="secondary">
              {ru ? "Остаться" : "Stay"}
            </Button>
          </div>
        </Alert>
      </div>
    </StationScreen>
  );
}

/**
 * Mirrors WorkScreen's own `toneOf`/`showTimedSignal` wiring: the title
 * always comes from the same `signal.*` keys the real verdict flash uses, and
 * -- like production -- only "duplicate" carries a detail line (the
 * `signal.firstSeen` first-scan time); an error verdict never has a second
 * line (see `onOutcome`'s `detail` computation, which stays `undefined` for
 * every non-duplicate status).
 *
 * "duplicate"/"error" only -- "ok" is not a signal-overlay state in
 * production (WorkScreen.tsx's `publishVerdict` returns early for tone
 * "ok", so the accepted verdict never gets a full-screen flash); its gallery
 * id (`work-ok`) instead goes through `WorkFixture`'s "ok" mode below, which
 * renders the real inline compact-success panel.
 */
function SignalFixture({ tone, locale }: { tone: string; locale: GalleryLocale }) {
  const t = i18n.getFixedT(locale);
  if (tone === "duplicate") {
    const time = locale === "ru" ? "14:31:52" : "2:31:52 PM";
    return (
      <SignalOverlay
        tone="duplicate"
        title={t("signal.duplicate")}
        detail={t("signal.firstSeen", { time })}
      />
    );
  }
  // Any of signal.wrongCode/wrongGtin/systemError is a faithful "red
  // verdict" -- this picks the wrong-GTIN case (a scan for a different,
  // known product) as the representative example.
  return <SignalOverlay tone="error" title={t("signal.wrongGtin")} />;
}

/**
 * "box-empty" only -- an isolated component review of an unstarted box,
 * never a real production screen (the box panel only ever renders inside the
 * work screen; see "box-full" above, which now goes through `WorkFixture`
 * instead of this wrapper for exactly that reason).
 */
function BoxFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
  const workLabels = buildWorkLabels(i18n.getFixedT(locale), locale, 1);
  return (
    <StationScreen title={ru ? "Текущий короб" : "Current box"}>
      <BoxFillInstrument
        box={{ boxId: "gallery-box-standalone", itemCount: 0 }}
        ordinal={1}
        acceptedToken={null}
        capacity={20}
        canUndo={false}
        labels={workLabels.box}
        onClose={() => undefined}
        onUndo={() => undefined}
        onClear={() => undefined}
      />
    </StationScreen>
  );
}

const GALLERY_RECOVERY_SSCC = "046012345600000016";

function BoxPrintRecoveryFixture({ variant }: { variant: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const errorCode = galleryRecoveryErrorCode(variant);

  useLayoutEffect(() => {
    if (variant !== "skip-confirm") return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>(".mk-full-screen-dialog > footer button:last-of-type")
      ?.click();
  }, [variant]);

  return (
    <div ref={rootRef} className="gallery-production-recovery">
      <BoxPrintRecovery
        sscc={GALLERY_RECOVERY_SSCC}
        errorCode={errorCode}
        pending={false}
        onRetry={() => undefined}
        onSetup={() => undefined}
        onSkip={() => undefined}
      />
    </div>
  );
}

function galleryRecoveryErrorCode(variant: string): BoxPrintErrorCode {
  if (variant === "template_missing") return "template_missing";
  if (variant === "printer_unconfigured") return "printer_unconfigured";
  if (variant === "render_failed") return "render_failed";
  return "transport_failed";
}

function SerialRecoveryFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
  return (
    <StationScreen title={ru ? "Закончились номера коробов" : "Box serials exhausted"}>
      <div className="gallery-dialog-panel" role="dialog" aria-modal="true">
        <h2>{ru ? "Невозможно закрыть короб" : "The box cannot be closed"}</h2>
        <p>
          {ru
            ? "Продолжение сканирования заблокировано. Дождитесь пополнения диапазона SSCC или вернитесь к работе с открытым коробом."
            : "Scanning is blocked. Wait for the SSCC range to refill or return to the open box."}
        </p>
        <Button size="floor" variant="secondary">
          {ru ? "Вернуться к работе" : "Back to work"}
        </Button>
      </div>
    </StationScreen>
  );
}

const GALLERY_EXCEPTION_BOXES: ClosedBoxSummary[] = [
  {
    boxId: "gallery-exception-box-1",
    sscc: "046012345600000016",
    itemCount: 24,
    closedAt: "2026-08-21T09:14:00+03:00",
  },
  {
    boxId: "gallery-exception-box-2",
    sscc: "046012345600000023",
    itemCount: 18,
    closedAt: "2026-08-21T10:02:00+03:00",
  },
  {
    boxId: "gallery-exception-box-3",
    sscc: "046012345600000030",
    itemCount: 12,
    closedAt: "2026-08-21T10:41:00+03:00",
  },
];

/** Never fires on its own -- exists only so `ExceptionFlow` renders the real
 * scan-target hint on its "target" stage the way it does whenever WorkScreen
 * hands it a live scan source. */
function galleryExceptionScanSource(): ScanSource {
  return { start: () => () => undefined };
}

/**
 * Mirrors ExceptionFlow.tsx's own render tree (the real component, driven
 * through its own buttons) instead of hand-copied markup, so every captured
 * stage matches the current exception flow -- action/target/reason copy,
 * button variants, and (critically) the "confirm" stage's irreversible
 * double-confirmation dialog, which only the "disassemble" action reaches.
 * "reprint" shares the same "target"/"reason" stages but a different,
 * non-double-confirmed "confirm" screen. This fixture drives the "reprint"
 * path only for the "reason" stage, so exception-reason shows the reprint
 * reason directory ("Этикетка повреждена" et al.) instead of the
 * disassemble one; every other stage -- including "confirm"/"result" --
 * drives the "disassemble" path so exception-confirm/-result keep showing
 * the disassemble copy (irreversible double-confirmation) the design spec
 * calls for.
 */
function ExceptionFixture({ stage, locale }: { stage: string; locale: GalleryLocale }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (stage === "action") return;
    const root = rootRef.current;
    if (!root) return;
    const t = i18n.getFixedT(locale);
    const clickByText = (text: string): void => {
      // Action cards carry a hint line inside the button, so their textContent
      // is label+hint; the aria-label pins the accessible name to the label.
      const button = Array.from(root.querySelectorAll("button")).find(
        (candidate) =>
          candidate.getAttribute("aria-label") === text || candidate.textContent?.trim() === text,
      );
      button?.click();
    };
    // Only the "reason" stage drives the reprint path -- see the comment above.
    const initialAction = stage === "reason" ? t("box.reprintAction") : t("box.disassembleAction");
    const steps: Array<() => void> = [() => clickByText(initialAction)];
    if (stage !== "target") {
      steps.push(() => root.querySelector<HTMLButtonElement>(".shift-boxes__row")?.click());
    }
    if (stage === "confirm" || stage === "applying" || stage === "result") {
      steps.push(() => clickByText(t("box.reasons.disassemble.wrongProduct")));
    }
    if (stage === "applying" || stage === "result") {
      steps.push(() => clickByText(t("box.confirmDisassemble")));
    }
    let index = 0;
    function runNext(): void {
      if (index >= steps.length) return;
      steps[index]?.();
      index += 1;
      setTimeout(runNext, 0);
    }
    setTimeout(runNext, 0);
  }, [stage, locale]);

  return (
    <div ref={rootRef} className="gallery-exception-flow">
      <ExceptionFlow
        boxes={GALLERY_EXCEPTION_BOXES}
        canUndo
        hasOpenBox
        onUndo={() => Promise.resolve()}
        onClear={() => Promise.resolve()}
        onReprint={() => Promise.resolve()}
        // "applying" must stay parked on that stage for its own capture --
        // an already-resolved promise would flip straight to "result"
        // before the screenshot lands.
        onDisassemble={() =>
          stage === "applying" ? new Promise<void>(() => undefined) : Promise.resolve()
        }
        onBack={() => undefined}
        onPendingChange={() => undefined}
        scanSource={galleryExceptionScanSource()}
        windowControl={
          <WindowModeControl
            snapshot={{ mode: "locked", pending: false, error: null }}
            activeShift
            onEnter={() => undefined}
            onExit={() => undefined}
            onDismissError={() => undefined}
          />
        }
      />
    </div>
  );
}

interface GalleryConflictRow {
  code_hash: string;
  winning_terminal_id: string | null;
  winning_scanned_at: string;
  detected_at: string;
  gtin14: string | null;
  serial: string | null;
}

const GALLERY_CONFLICT_ROWS: GalleryConflictRow[] = [
  {
    code_hash: "gallery-conflict-1",
    winning_terminal_id: "DEMO-TERM-11",
    winning_scanned_at: "2026-08-21T09:14:22+03:00",
    detected_at: "2026-08-21T09:15:03+03:00",
    gtin14: "04607000000042",
    serial: "DEMO-SERIAL-000128",
  },
  {
    code_hash: "gallery-conflict-2",
    winning_terminal_id: "DEMO-TERM-12",
    winning_scanned_at: "2026-08-21T09:18:47+03:00",
    detected_at: "2026-08-21T09:19:10+03:00",
    gtin14: "04607000000042",
    serial: "DEMO-SERIAL-000129",
  },
  {
    code_hash: "gallery-conflict-3",
    winning_terminal_id: "DEMO-TERM-21",
    winning_scanned_at: "2026-08-21T10:02:31+03:00",
    detected_at: "2026-08-21T10:03:05+03:00",
    gtin14: "04607000000042",
    serial: "DEMO-SERIAL-000130",
  },
  {
    code_hash: "gallery-conflict-4",
    winning_terminal_id: "DEMO-TERM-22",
    winning_scanned_at: "2026-08-21T10:07:58+03:00",
    detected_at: "2026-08-21T10:08:40+03:00",
    gtin14: "04607000000042",
    serial: "DEMO-SERIAL-000131",
  },
];

/** Answers exactly the two queries `readConflicts` issues (see
 * `apps/station/src/lib/conflicts.ts`), so `ConflictList` -- the real
 * component -- drives every persistent variant without a network dependency.
 * "loading" never resolves, reproducing the interstitial for a static
 * capture; "read-error" rejects the count query the way a corrupt local
 * mirror would. */
function galleryConflictExecutor(variant: string): SqlExecutor {
  const rows = variant === "empty" ? [] : GALLERY_CONFLICT_ROWS;
  return {
    run: () => Promise.resolve(),
    all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (variant === "loading") return new Promise<T[]>(() => undefined);
      if (sql.includes("COUNT(*)")) {
        if (variant === "read-error") {
          return Promise.reject(new Error("gallery: conflict read failed"));
        }
        return Promise.resolve([{ n: rows.length }] as T[]);
      }
      if (sql.includes("FROM conflicts_mirror")) {
        const [limit, offset] = (params ?? []) as [number, number];
        return Promise.resolve(rows.slice(offset, offset + limit) as T[]);
      }
      return Promise.resolve([]);
    },
  };
}

/**
 * Mirrors ConflictList.tsx's own render tree (the real component, backed by
 * a synthetic executor answering its exact queries) instead of hand-copied
 * markup, so title, per-card copy ("Закреплён за …"), and pagination match
 * the current production screen. "2" drives the real component to its own
 * second page through its own Pager "next" button, the same way a real
 * operator would.
 */
function ConflictFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const exec = useMemo(() => galleryConflictExecutor(variant), [variant]);

  useLayoutEffect(() => {
    if (variant !== "2") return;
    const root = rootRef.current;
    if (!root) return;
    const t = i18n.getFixedT(locale);
    setTimeout(() => {
      const next = Array.from(root.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === t("conflicts.nextPage"),
      );
      next?.click();
    }, 0);
  }, [variant, locale]);

  return (
    <div ref={rootRef} className="gallery-conflict-list">
      <ConflictList exec={exec} onBack={() => undefined} />
    </div>
  );
}

/** Every call resolves without touching Tauri's IPC -- the real hardware
 * surface is stateless per call (see hardware.ts's own doc comment), so a
 * synthetic contract that just resolves is enough for WorkstationSetup to
 * render every field; nothing in this gallery clicks "Connect"/"Test". */
function gallerySetupHardware(): HardwareContract {
  const usbPrinters: UsbPrinterInfo[] = [{ name: "DEMO-USB-PRINTER", port: "USB001" }];
  return {
    listScannerPorts: () => Promise.resolve(["DEMO-COM1", "DEMO-COM2"]),
    listUsbPrinters: () => Promise.resolve(usbPrinters),
    openScanner: () => Promise.resolve(),
    closeScanner: () => Promise.resolve(),
    onScan: () => Promise.resolve(() => undefined),
    onScannerStatus: () => Promise.resolve(() => undefined),
    print: () => Promise.resolve(),
  };
}

const GALLERY_SETUP_HARDWARE_CONFIG: HardwareConfig = {
  scanner: { port: "DEMO-COM1", baud: 9600 },
  printer: { kind: "tcp", host: "192.168.10.20", port: 9100 },
  printerLanguage: "zpl",
  verifyPrintedLabel: true,
};

/** Answers exactly the `station_meta` query `loadHardwareConfig` issues (see
 * hardware-config.ts), so the real `WorkstationSetup` starts pre-configured
 * with a demo scanner and TCP printer without any local persistence. */
function gallerySetupExecutor(): SqlExecutor {
  return {
    run: () => Promise.resolve(),
    all<T>(sql: string): Promise<T[]> {
      if (sql.includes("station_meta")) {
        return Promise.resolve([{ value: JSON.stringify(GALLERY_SETUP_HARDWARE_CONFIG) }] as T[]);
      }
      return Promise.resolve([]);
    },
  };
}

/**
 * Mirrors WorkstationSetup.tsx's own render tree (the real component, backed
 * by a synthetic hardware contract + executor) instead of hand-copied tabs,
 * so the title, tab labels, and every field on each tab match the current
 * production setup screen. The tab switch is driven through the real
 * `SetupTabs` component's own button, the same way an operator would.
 */
function SetupFixture({ tab, locale }: { tab: string; locale: GalleryLocale }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hw = useMemo(gallerySetupHardware, []);
  const exec = useMemo(gallerySetupExecutor, []);
  const [sound, setSound] = useState<SoundSettings>({ muted: false, volume: 0.7 });

  useLayoutEffect(() => {
    if (tab === "scanner") return;
    const root = rootRef.current;
    if (!root) return;
    const t = i18n.getFixedT(locale);
    const label = tab === "printer" ? t("setup.printer") : t("setup.sound");
    setTimeout(() => {
      const button = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      button?.click();
    }, 0);
  }, [tab, locale]);

  return (
    <div ref={rootRef} className="gallery-workstation-setup">
      <WorkstationSetup
        hw={hw}
        exec={exec}
        sound={sound}
        onSoundChange={setSound}
        onConfigChange={() => undefined}
        onDone={() => undefined}
      />
    </div>
  );
}

/**
 * "sync-stuck" only -- the queue-stopped interstitial. Plain "offline" is not
 * a dedicated screen in production (see the "sync" case in `GalleryState`
 * above), so this component no longer needs an "offline" branch.
 */
function SyncFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
  return (
    <StationScreen
      title={ru ? "Синхронизация остановилась" : "Sync stopped"}
      actions={<GalleryFooter locale={locale} primary={ru ? "Повторить" : "Retry"} />}
    >
      <div className="gallery-centered-card">
        <Alert
          tone="warn"
          title={ru ? "18 операций ожидают отправки" : "18 operations are waiting"}
        >
          <p>
            {ru
              ? "Можно продолжать сканирование. Данные не потеряны и будут отправлены после восстановления соединения."
              : "Scanning can continue. Data is retained and will be sent after connectivity returns."}
          </p>
        </Alert>
      </div>
    </StationScreen>
  );
}

/** A valid, but different-from-`expected`, SSCC -- exercises PrintVerification's
 * own "mismatch" branch (a real, checksum-valid box label, just the wrong one). */
const GALLERY_PRINT_VERIFICATION_EXPECTED_SSCC = "046012345600000016";
const GALLERY_PRINT_VERIFICATION_OTHER_SSCC = "046012345600000023";

/** Delivers one fixed raw payload (or none) the instant PrintVerification
 * subscribes, reproducing its "mismatch"/"notSscc" feedback without a real
 * scanner -- `start` runs synchronously inside the component's own mount
 * effect, so the listener fires before that effect's `active` flag could
 * ever be stale. */
function galleryPrintScanSource(raw: string | null): ScanSource {
  return {
    start(listener) {
      if (raw !== null) listener(raw);
      return () => undefined;
    },
  };
}

/** Mirrors PrintVerification.tsx's own render tree (the real component, not
 * hand-copied markup) so the captured screen matches the current box-label
 * verification dialog -- title, instruction copy, SSCC formatting, and
 * footer button placement -- stage for stage. */
function PrintFixture({ variant }: { variant: string }) {
  const raw =
    variant === "mismatch"
      ? GALLERY_PRINT_VERIFICATION_OTHER_SSCC
      : variant === "not-sscc"
        ? "NOT-A-VALID-SSCC"
        : null;
  return (
    <PrintVerification
      expected={GALLERY_PRINT_VERIFICATION_EXPECTED_SSCC}
      onVerified={() => undefined}
      onReprint={() => undefined}
      onSkip={() => undefined}
      scanSource={galleryPrintScanSource(raw)}
    />
  );
}

/** Published dates chosen so `updateSeverity` (see update-state.ts) lands on
 * the age bracket each variant needs to demonstrate, anchored to "now" so the
 * fixture keeps working as the calendar advances. */
const GALLERY_UPDATE_AGE_MS: Record<"info" | "warn" | "urgent", number> = {
  info: 2 * 24 * 60 * 60 * 1000,
  warn: 21 * 24 * 60 * 60 * 1000,
  urgent: 45 * 24 * 60 * 60 * 1000,
};

function galleryUpdateAvailable(age: "info" | "warn" | "urgent" | null): KnownStationUpdate | null {
  if (age === null) return null;
  return {
    // `isStationBetaVersion` (station-version.ts) only accepts betas, so the
    // demo version keeps the brief's "1.4.2" base with the required suffix.
    version: "1.4.2-beta.1",
    publishedAt: new Date(Date.now() - GALLERY_UPDATE_AGE_MS[age]).toISOString(),
  };
}

/** Implements the real `StationUpdaterController` contract directly (the
 * production hook this normally comes from talks to Tauri's updater IPC),
 * so `UpdateCenter` -- the real component -- renders every severity/error
 * state without a network or IPC dependency. */
function galleryUpdateController(
  available: KnownStationUpdate | null,
  error: "check-failed" | null,
): StationUpdaterController {
  return {
    phase: "idle",
    persisted: { schemaVersion: 1, lastAttemptAt: null, lastSuccessfulCheckAt: null, available },
    severity: updateSeverity(Date.now(), available),
    error,
    downloadedBytes: 0,
    totalBytes: null,
    checkNow: () => Promise.resolve(),
    install: () => Promise.resolve(),
  };
}

/**
 * Mirrors UpdateCenter.tsx's own render tree (the real component, backed by
 * a synthetic controller implementing its exact interface) instead of
 * hand-copied markup, so the title, per-severity age copy, and the
 * active-shift blocker match the current production update screen.
 */
function UpdateFixture({ variant }: { variant: string }) {
  const activeShift = variant === "active-shift";
  const error = variant === "error";
  const current = variant === "current";
  const age =
    current || error ? null : activeShift ? "warn" : (variant as "info" | "warn" | "urgent");
  const available = galleryUpdateAvailable(age);
  const controller = useMemo(
    () => galleryUpdateController(available, error ? "check-failed" : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `available` is a fresh object each render; keyed on its own fields instead.
    [available?.version, available?.publishedAt, error],
  );
  return (
    <UpdateCenter
      controller={controller}
      activeShift={activeShift}
      pendingOutbox={0}
      onBack={() => undefined}
    />
  );
}

function LongCopyFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
  return (
    <StationScreen
      title={
        ru
          ? "Продолжительная автономная работа на производственной линии"
          : "Extended offline operation on the production line"
      }
      actions={
        <GalleryFooter locale={locale} primary={ru ? "Продолжить автономно" : "Continue offline"} />
      }
    >
      <div className="gallery-centered-card">
        <Alert tone="warn">
          <p>
            {ru
              ? "Продолжительная автономная работа возможна: все отсканированные коды, закрытые короба, исключения и действия оператора сохраняются на этом рабочем месте. После восстановления соединения отправка возобновится автоматически, без остановки текущей смены."
              : "Extended offline operation is available: every scanned code, closed box, exception, and operator action remains safely stored on this workstation. Upload resumes automatically when connectivity returns, without stopping the active shift."}
          </p>
        </Alert>
      </div>
    </StationScreen>
  );
}

function GalleryFooter({
  locale,
  primary,
  secondary,
}: {
  locale: GalleryLocale;
  primary?: string;
  secondary?: string;
}) {
  const copy = COPY[locale];
  return (
    <FloorFooter ariaLabel={locale === "ru" ? "Действия" : "Actions"}>
      <Button size="floor" variant="secondary">
        {secondary ?? copy.back}
      </Button>
      {primary ? <Button size="floor">{primary}</Button> : null}
    </FloorFooter>
  );
}

function GalleryPager({
  page,
  previousLabel,
  nextLabel,
  pageLabel,
}: {
  page: number;
  previousLabel: string;
  nextLabel: string;
  pageLabel: string;
}) {
  return (
    <nav className="mk-pager gallery-pager" aria-label={pageLabel}>
      <Button size="floor" variant="secondary" fullWidth disabled={page === 1}>
        {previousLabel}
      </Button>
      <span>{pageLabel}</span>
      <Button size="floor" variant="secondary" fullWidth disabled={page === 2}>
        {nextLabel}
      </Button>
    </nav>
  );
}
