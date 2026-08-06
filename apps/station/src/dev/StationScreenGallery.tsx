import { useLayoutEffect } from "react";
import { Alert, Button, Card, PinPad, SignalOverlay } from "@markiro/ui";

import i18n from "../i18n/index.js";
import { FloorFooter } from "../ui/FloorFooter.js";
import { FloorShell } from "../ui/FloorShell.js";
import { StationScreen } from "../ui/StationScreen.js";
import {
  getGalleryFixture,
  resolveGalleryRequest,
  type GalleryFixture,
  type GalleryLocale,
  type GalleryRequest,
} from "./gallery-fixtures.js";

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
  },
  en: {
    back: "Back",
    continue: "Continue",
    page: (page: number) => `Page ${page} of 2`,
    station: "Demo station 01",
    line: "Test line A",
    operator: "Sample Operator",
    shift: "Shift DEMO-01",
  },
} as const;

export function StationScreenGallery({ request }: StationScreenGalleryProps) {
  const fixture = getGalleryFixture(request.state);
  const copy = COPY[request.locale];

  useLayoutEffect(() => {
    void i18n.changeLanguage(request.locale);
  }, [request.locale]);

  const syncVariant = fixture.kind === "sync" ? fixture.variant : null;
  return (
    <div
      className="station-gallery-capture"
      data-testid="station-screen-gallery"
      data-gallery-state={fixture.id}
      data-gallery-locale={request.locale}
    >
      <FloorShell
        stationName={copy.station}
        lineName={copy.line}
        operatorName={copy.operator}
        shiftLabel={copy.shift}
        online={syncVariant !== "offline"}
        scanner="connected"
        printerConfigured
        syncPending={syncVariant === "stuck" ? 18 : syncVariant === "offline" ? 7 : 0}
        syncStuck={syncVariant === "stuck"}
        conflicts={fixture.kind === "conflicts" ? 4 : 0}
      >
        <GalleryState fixture={fixture} locale={request.locale} />
      </FloorShell>
    </div>
  );
}

function GalleryState({ fixture, locale }: { fixture: GalleryFixture; locale: GalleryLocale }) {
  switch (fixture.kind) {
    case "pairing":
      return <PairingFixture variant={fixture.variant} locale={locale} />;
    case "login":
      return <LoginFixture variant={fixture.variant} locale={locale} />;
    case "shift":
      return <ShiftFixture page={fixture.variant === "2" ? 2 : 1} locale={locale} />;
    case "work":
      return <WorkFixture mode={fixture.variant} locale={locale} />;
    case "signal":
      return <SignalFixture tone={fixture.variant} locale={locale} />;
    case "box":
      return <BoxFixture full={fixture.variant === "full"} locale={locale} />;
    case "exception":
      return <ExceptionFixture stage={fixture.variant} locale={locale} />;
    case "conflicts":
      return <ConflictFixture page={fixture.variant === "2" ? 2 : 1} locale={locale} />;
    case "setup":
      return <SetupFixture tab={fixture.variant} locale={locale} />;
    case "sync":
      return <SyncFixture stuck={fixture.variant === "stuck"} locale={locale} />;
    case "print":
      return <PrintFixture locale={locale} />;
    case "long-copy":
      return <LongCopyFixture locale={fixture.variant === "en" ? "en" : "ru"} />;
  }
}

function PairingFixture({ variant, locale }: { variant: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const messages: Record<string, { tone: "info" | "error" | "ok" | "warn"; text: string }> = {
    waiting: { tone: "info", text: ru ? "Введите код подключения" : "Enter pairing code" },
    error: {
      tone: "error",
      text: ru ? "Код истёк. Запросите новый." : "Code expired. Request a new one.",
    },
    success: { tone: "ok", text: ru ? "Рабочее место подключено" : "Workstation paired" },
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
            0000 0000
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
        <div className="gallery-search-grid">
          <div className="gallery-search-field">{ru ? "Тесто" : "Sample"}</div>
          {["Оператор Тестов", "Sample Operator", "Демо Пользователь"].map((name) => (
            <Button key={name} size="floor" variant="secondary">
              {name}
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

function ShiftFixture({ page, locale }: { page: number; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const shifts = page === 1 ? ["ДЕМО-01", "ДЕМО-02", "ДЕМО-03"] : ["ДЕМО-04", "ДЕМО-05"];
  return (
    <StationScreen title={ru ? "Выберите смену" : "Select shift"}>
      <div className="gallery-paged-grid">
        <div className="gallery-three-cards">
          {shifts.map((shift, index) => (
            <Card
              key={shift}
              className="gallery-card"
              title={ru ? `Смена ${shift}` : `Shift ${shift}`}
            >
              <p>
                {ru
                  ? `Линия ${index + 1} · Задание TEST-${page}${index + 1}`
                  : `Line ${index + 1} · Job TEST-${page}${index + 1}`}
              </p>
              <Button size="floor" fullWidth>
                {ru ? "Открыть" : "Open"}
              </Button>
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

function WorkFixture({ mode, locale }: { mode: string; locale: GalleryLocale }) {
  const ru = locale === "ru";
  const aggregation = mode === "aggregation";
  return (
    <StationScreen
      title={
        aggregation
          ? ru
            ? "Агрегация короба"
            : "Box aggregation"
          : ru
            ? "Проверка кодов"
            : "Code validation"
      }
      actions={<GalleryFooter locale={locale} primary={ru ? "Исключения" : "Exceptions"} />}
    >
      <div className="gallery-work-grid">
        <Card className="gallery-counter" title={ru ? "Принято" : "Accepted"}>
          <strong>1 248</strong>
        </Card>
        <Card
          className="gallery-counter"
          title={aggregation ? (ru ? "В коробе" : "In box") : ru ? "Ошибки" : "Errors"}
        >
          <strong>{aggregation ? "18 / 24" : "3"}</strong>
        </Card>
        <Card
          className="gallery-card gallery-wide"
          title={ru ? "Последняя операция" : "Latest operation"}
        >
          <p className="gallery-mono">TEST-GTIN-04607000000042 · DEMO-SERIAL-000128</p>
          <p>{ru ? "Синтетическая операция · 14:32:08" : "Synthetic operation · 14:32:08"}</p>
        </Card>
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
  return (
    <StationScreen
      title={ru ? "Текущий короб" : "Current box"}
      actions={<GalleryFooter locale={locale} primary={ru ? "Закрыть короб" : "Close box"} />}
    >
      <div className="gallery-box">
        <div className="gallery-box-count">
          <strong>{full ? "24 / 24" : "0 / 24"}</strong>
          <span>
            {full ? (ru ? "Короб заполнен" : "Box is full") : ru ? "Короб пуст" : "Box is empty"}
          </span>
        </div>
        <div className="gallery-box-meter">
          <span style={{ width: full ? "100%" : "0%" }} />
        </div>
        <p className="gallery-mono">SSCC TEST 000000000000000000</p>
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
          stage === "result" ? (
            <Alert key={item} tone="ok">
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

function ConflictFixture({ page, locale }: { page: number; locale: GalleryLocale }) {
  const ru = locale === "ru";
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

function PrintFixture({ locale }: { locale: GalleryLocale }) {
  const ru = locale === "ru";
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
        <Alert tone="info">{ru ? "Ожидание сканирования" : "Waiting for scan"}</Alert>
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
