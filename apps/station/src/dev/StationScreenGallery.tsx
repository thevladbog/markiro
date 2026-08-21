import { useLayoutEffect, useRef } from "react";
import { Alert, Button, Card, PinPad, SignalOverlay } from "@markiro/ui";

import i18n from "../i18n/index.js";
import type { BoxPrintErrorCode } from "../lib/boxes.js";
import type { RecentOperation } from "../lib/journal.js";
import { BoxPrintRecovery } from "../ui/BoxPrintRecovery.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { FloorShell } from "../ui/FloorShell.js";
import { ShiftCard } from "../ui/ShiftCard.js";
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

  const syncVariant = fixture.kind === "sync" ? fixture.variant : null;
  const headerVariant = fixture.kind === "floor-header" ? fixture.variant : null;
  const withActiveShiftControls =
    headerVariant !== null || fixture.kind === "shift" || fixture.kind === "work";
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
        statusBarCollapsible={fixture.kind === "work"}
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
      return <BoxFixture full={fixture.variant === "full"} locale={locale} />;
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
      return <SyncFixture stuck={fixture.variant === "stuck"} locale={locale} />;
    case "print":
      return <PrintFixture variant={fixture.variant} locale={locale} />;
    case "updates":
      return <UpdateFixture variant={fixture.variant} locale={locale} />;
    case "floor-header":
      return <FloorHeaderFixture locale={locale} />;
    case "long-copy":
      return <LongCopyFixture locale={fixture.variant === "en" ? "en" : "ru"} />;
  }
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

function PairingFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const messages: Record<string, { tone: "info" | "error" | "ok" | "warn"; text: string }> = {
    waiting: { tone: "info", text: ru ? "Введите код подключения" : "Enter pairing code" },
    redeeming: {
      tone: "info",
      text: ru ? "Проверяем код подключения…" : "Checking pairing code…",
    },
    error: {
      tone: "error",
      text: ru ? "Код истёк. Запросите новый." : "Code expired. Request a new one.",
    },
    success: { tone: "ok", text: ru ? "Рабочее место подключено" : "Workstation paired" },
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

function LoginFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const isSearch = variant === "name-search";
  const searchNames = ru
    ? [
        "Александрова-Романовская Екатерина Владимировна",
        "Иванов Алексей Сергеевич",
        "Петрова Мария Андреевна",
        "Смирнов Александр Олегович",
        "Фёдорова Елена Викторовна",
      ]
    : [
        "Alexandria Montgomery-Wellington the Third",
        "Alex Johnson",
        "Alice Peterson",
        "Alicia Smith",
        "Alison Foster",
      ];
  const title = ru ? "Вход оператора" : "Operator sign-in";
  const prompt =
    variant === "badge"
      ? ru
        ? "Приложите пропуск"
        : "Present badge"
      : variant === "number"
        ? ru
          ? "Введите логин"
          : "Enter login"
        : variant === "pin"
          ? ru
            ? "Введите PIN"
            : "Enter PIN"
          : ru
            ? "Найдите себя по имени"
            : "Find your name";
  return (
    <StationScreen title={title} header={<p className="gallery-subtitle">{prompt}</p>}>
      {isSearch ? (
        <div className="gallery-search-grid" data-testid="gallery-name-search-results">
          <div className="gallery-search-field">{ru ? "Але" : "Ale"}</div>
          {searchNames.map((name) => (
            <Button key={name} size="floor" variant="secondary" fullWidth>
              <span className="operator-name-search__result-label">{name}</span>
            </Button>
          ))}
        </div>
      ) : variant === "badge" ? (
        <div className="gallery-badge" aria-hidden="true">
          ▣
        </div>
      ) : (
        <div className="gallery-keypad">
          <div className="gallery-code">{variant === "pin" ? "••••" : "0042"}</div>
          <PinPad
            value={variant === "pin" ? "1234" : "0042"}
            maxLength={12}
            size="floor"
            onChange={() => undefined}
          />
        </div>
      )}
    </StationScreen>
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
  const aggregation = mode.startsWith("aggregation");
  const waiting = mode === "validation" || mode === "aggregation-waiting";
  const workLabels = buildWorkLabels(i18n.getFixedT(locale), locale, 1);
  const operations = galleryRecentOperations();
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
              operation={waiting ? null : (operations[0] ?? null)}
              labels={workLabels.status}
            />
            {aggregation ? (
              <BoxFillInstrument
                box={{ boxId: "gallery-box-1", itemCount: 2 }}
                ordinal={1}
                acceptedToken="gallery-accepted-2"
                capacity={20}
                canUndo
                labels={workLabels.box}
                onClose={() => undefined}
                onUndo={() => undefined}
                onClear={() => undefined}
              />
            ) : null}
          </div>
          <aside className="work-screen__secondary" aria-label={workLabels.summary}>
            <WorkCounters
              accepted={1248}
              rejected={3}
              pendingSync={7}
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

function SignalFixture({ tone, locale }: { tone: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  if (tone === "duplicate") {
    return (
      <SignalOverlay
        tone="duplicate"
        title={ru ? "ДУБЛИКАТ" : "DUPLICATE"}
        detail={ru ? "Первое сканирование 14:31:52" : "First scanned 14:31:52"}
      />
    );
  }
  if (tone === "error") {
    return (
      <SignalOverlay
        tone="error"
        title={ru ? "КОД ОТКЛОНЁН" : "CODE REJECTED"}
        detail={ru ? "Неверный GTIN" : "Invalid GTIN"}
      />
    );
  }
  return (
    <SignalOverlay tone="ok" title={ru ? "ПРИНЯТО" : "ACCEPTED"} detail="TEST-SERIAL-000128" />
  );
}

function BoxFixture({ full, locale }: { full: boolean; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const capacity = full ? 120 : 20;
  const itemCount = full ? capacity : 0;
  const workLabels = buildWorkLabels(i18n.getFixedT(locale), locale, 1);
  return (
    <StationScreen title={ru ? "Текущий короб" : "Current box"}>
      <BoxFillInstrument
        box={{ boxId: "gallery-box-standalone", itemCount }}
        ordinal={1}
        acceptedToken={full ? "gallery-full" : null}
        capacity={capacity}
        canUndo={itemCount > 0}
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

function ExceptionFixture({ stage, locale }: { stage: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const title: Record<string, string> = {
    action: ru ? "Выберите действие" : "Choose action",
    target: ru ? "Выберите короб" : "Choose box",
    reason: ru ? "Укажите причину" : "Choose reason",
    confirm: ru ? "Подтвердите действие" : "Confirm action",
    applying: ru ? "Выполняем действие" : "Applying action",
    result: ru ? "Действие выполнено" : "Action completed",
  };
  const items: Record<string, string[]> = {
    action: ru
      ? [
          "Отменить последнее сканирование",
          "Очистить короб",
          "Повторить печать",
          "Расформировать короб",
        ]
      : ["Undo latest scan", "Clear box", "Reprint label", "Disassemble box"],
    target: ["TEST-BOX-0001 · 24", "TEST-BOX-0002 · 18", "TEST-BOX-0003 · 12"],
    reason: ru
      ? ["Этикетка повреждена", "Этикетка не читается", "Замятие в принтере", "Другая причина"]
      : ["Damaged label", "Unreadable label", "Printer jam", "Other reason"],
    confirm: [ru ? "Повторно напечатать этикетку TEST-BOX-0001?" : "Reprint label TEST-BOX-0001?"],
    applying: [ru ? "Запись сохраняется в локальный журнал…" : "Saving to the local journal…"],
    result: [ru ? "Этикетка отправлена на печать" : "Label sent to printer"],
  };
  return (
    <StationScreen
      title={ru ? "Исключения" : "Exceptions"}
      header={<p className="gallery-subtitle">{title[stage]}</p>}
      actions={
        <GalleryFooter
          locale={locale}
          {...(stage === "confirm" ? { primary: ru ? "Подтвердить" : "Confirm" } : {})}
        />
      }
    >
      <div className="gallery-action-grid">
        {(items[stage] ?? []).map((item) =>
          stage === "result" || stage === "applying" ? (
            <Alert key={item} tone={stage === "result" ? "ok" : "info"}>
              {item}
            </Alert>
          ) : (
            <Button key={item} size="floor" variant="secondary">
              {item}
            </Button>
          ),
        )}
      </div>
    </StationScreen>
  );
}

function ConflictFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  if (variant === "loading" || variant === "read-error" || variant === "empty") {
    return (
      <StationScreen
        title={ru ? "Конфликты" : "Conflicts"}
        actions={<GalleryFooter locale={locale} />}
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
              {ru
                ? "Не удалось прочитать локальные конфликты"
                : "Local conflicts could not be read"}
            </Alert>
          ) : (
            <p
              className="gallery-state-message"
              role={variant === "loading" ? "status" : undefined}
            >
              {variant === "loading"
                ? ru
                  ? "Загрузка конфликтов…"
                  : "Loading conflicts…"
                : ru
                  ? "Конфликтов нет"
                  : "There are no conflicts"}
            </p>
          )}
        </div>
      </StationScreen>
    );
  }
  const page = variant === "2" ? 2 : 1;
  const serials = page === 1 ? ["TEST-000128", "TEST-000129"] : ["TEST-000130", "TEST-000131"];
  return (
    <StationScreen
      title={ru ? "Конфликты" : "Conflicts"}
      actions={<GalleryFooter locale={locale} />}
    >
      <div className="gallery-paged-grid">
        <div className="gallery-two-cards">
          {serials.map((serial, index) => (
            <Card key={serial} className="gallery-card" title={`04607000000042 ${serial}`}>
              <p>
                {ru ? "Первой приняла" : "Accepted first by"}: DEMO-TERM-{page}
                {index + 1}
              </p>
              <p>
                {ru
                  ? "Продолжайте работу; запись сохранена."
                  : "Continue working; the record is retained."}
              </p>
            </Card>
          ))}
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

function SetupFixture({ tab, locale }: { tab: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const labels = ru ? ["Сканер", "Принтер", "Звук"] : ["Scanner", "Printer", "Sound"];
  const active = tab === "printer" ? 1 : tab === "sound" ? 2 : 0;
  const content =
    active === 0
      ? ru
        ? "Порт DEMO-COM1 · 9600 бод"
        : "Port DEMO-COM1 · 9600 baud"
      : active === 1
        ? ru
          ? "Принтер DEMO-PRINTER · ZPL"
          : "Printer DEMO-PRINTER · ZPL"
        : ru
          ? "Громкость сигнала 70%"
          : "Signal volume 70%";
  return (
    <StationScreen
      title={ru ? "Настройка оборудования" : "Equipment setup"}
      actions={<GalleryFooter locale={locale} primary={ru ? "Сохранить" : "Save"} />}
    >
      <div className="gallery-setup">
        <div className="gallery-setup-tabs" role="tablist">
          {labels.map((label, index) => (
            <Button
              key={label}
              size="floor"
              variant={index === active ? "primary" : "secondary"}
              aria-pressed={index === active}
            >
              {label}
            </Button>
          ))}
        </div>
        <Card className="gallery-card">
          <p>{content}</p>
          <Button size="floor" variant="secondary">
            {ru ? "Проверить" : "Test"}
          </Button>
          <div className="gallery-result-slot">
            <Alert tone="ok">{ru ? "Тестовое устройство готово" : "Synthetic device ready"}</Alert>
          </div>
        </Card>
      </div>
    </StationScreen>
  );
}

function SyncFixture({ stuck, locale }: { stuck: boolean; locale: GalleryLocale }) {
  const ru = locale === "ru";
  return (
    <StationScreen
      title={
        stuck
          ? ru
            ? "Синхронизация остановилась"
            : "Sync stopped"
          : ru
            ? "Работа без сети"
            : "Working offline"
      }
      actions={
        <GalleryFooter
          locale={locale}
          {...(stuck ? { primary: ru ? "Повторить" : "Retry" } : {})}
        />
      }
    >
      <div className="gallery-centered-card">
        <Alert
          tone="warn"
          title={
            stuck
              ? ru
                ? "18 операций ожидают отправки"
                : "18 operations are waiting"
              : ru
                ? "7 операций сохранены на устройстве"
                : "7 operations are saved on this device"
          }
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

function PrintFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const mismatch = variant === "mismatch";
  const notSscc = variant === "not-sscc";
  return (
    <StationScreen
      title={ru ? "Проверьте напечатанную этикетку" : "Verify the printed label"}
      actions={
        <GalleryFooter
          locale={locale}
          primary={ru ? "Повторить печать" : "Reprint"}
          secondary={ru ? "Пропустить" : "Skip"}
        />
      }
    >
      <div className="gallery-print">
        <p>{ru ? "Отсканируйте SSCC с этикетки короба" : "Scan the SSCC on the box label"}</p>
        <strong className="gallery-code">000000000000000000</strong>
        <Alert tone={mismatch || notSscc ? "error" : "info"}>
          {mismatch
            ? ru
              ? "Отсканирован SSCC другого короба"
              : "The scanned SSCC belongs to another box"
            : notSscc
              ? ru
                ? "На этикетке не распознан SSCC"
                : "No SSCC was recognized on the label"
              : ru
                ? "Ожидание сканирования"
                : "Waiting for scan"}
        </Alert>
      </div>
    </StationScreen>
  );
}

function UpdateFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const activeShift = variant === "active-shift";
  const error = variant === "error";
  const current = variant === "current";
  const tone = error || activeShift ? "warn" : current ? "ok" : "info";
  return (
    <StationScreen
      title={ru ? "Обновления станции" : "Station updates"}
      actions={
        <GalleryFooter
          locale={locale}
          {...(current ? {} : { primary: ru ? "Скачать и установить" : "Download and install" })}
        />
      }
    >
      <div className="gallery-centered-card" data-update-severity={variant}>
        <Alert tone={tone}>
          {current
            ? ru
              ? "На станции установлена актуальная версия."
              : "This station is up to date."
            : error
              ? ru
                ? "Не удалось проверить обновления. Локальная работа продолжается."
                : "Could not check for updates. Local work continues."
              : activeShift
                ? ru
                  ? "Завершите активную смену перед установкой."
                  : "Leave the active shift before installing."
                : ru
                  ? "Доступна версия 0.1.0-beta.2. Скачивание выполняется вручную."
                  : "Version 0.1.0-beta.2 is available. Download is manual."}
        </Alert>
      </div>
    </StationScreen>
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
