import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import type { ScannerIndicator } from "../scanner-indicator.js";
import { Glyph, type GlyphName } from "../kit/StatusIcons.js";
import {
  Banner,
  FooterButton,
  JobPrint,
  JobSubject,
  Journal,
  JournalEmpty,
  ManualEntry,
  ReasonList,
  ReprintDialog,
  ReprintFooter,
  ReprintHeading,
  ScanZone,
  SummaryList,
  Tag,
  type Press,
  type PressProps,
  type SummaryLine,
  type ZoneVariant,
} from "./ReprintParts.js";
import type { WarehouseJob, WarehouseReason } from "./warehouse-store.js";
import {
  filterJobs,
  isPrinterSetupFailure,
  printerView,
  resultView,
  type JobKindView,
  type JournalFilter,
} from "./warehouse-view.js";
import "./warehouse.css";

/**
 * The reprint's three views and its two questions, as stateless components over the pieces of
 * `ReprintParts` (design: station reprint, 2026-10). `WarehouseScreen` owns the state and the
 * work; these only say what is on screen, so every state can be rendered, tested and looked at
 * (the harness of `test/harness/reprint`) without a database.
 */

/** What the screen last said that is no state of a job (a refusal, the link, the scanner's absence). */
export interface Said {
  tone: "ok" | "warn" | "error" | "info";
  text: string;
  /** The outcome (`not_found`, `offline`, ...): it picks the banner's title and the scan zone's face. */
  kind?: string;
}

/** The outcomes that have a title over their words (`floor.warehouse.banner.title`). */
const TITLED = new Set([
  "not_found",
  "invalid_scan",
  "lookup_failed",
  "offline",
  "host_outdated",
  "restore_pending",
  "released",
  "disassembled",
  "busy",
  "write_failed",
  "verify_mismatch",
  "verify_invalid",
  "refused",
  "duplicate",
]);

/**
 * What stands above the zones: the last thing the screen said, else the link's or the scanner's own
 * state. A job's state is never said here: its detail says it. The region is always in the tree: a
 * polite region has to stand before a message is heard.
 */
export function ReprintBanner({
  said,
  online,
  scanner,
}: {
  said: Said | null;
  online: boolean;
  scanner: ScannerIndicator;
}) {
  const { t } = useTranslation();
  let banner: ReactNode = null;
  if (said !== null) {
    const glyph: GlyphName =
      said.kind === "not_found"
        ? "search-x"
        : said.kind === "offline"
          ? "wifi-slash"
          : said.tone === "error"
            ? "x-circle"
            : said.tone === "warn"
              ? "warning"
              : "info";
    banner = (
      <Banner
        tone={said.tone === "ok" ? "info" : said.tone}
        glyph={glyph}
        title={
          said.kind !== undefined && TITLED.has(said.kind)
            ? t(`floor.warehouse.banner.title.${said.kind}`)
            : undefined
        }
      >
        {said.text}
      </Banner>
    );
  } else if (!online) {
    banner = (
      <Banner tone="warn" glyph="wifi-slash" title={t("floor.warehouse.banner.offlineTitle")}>
        {t("floor.warehouse.banner.offlineText")}
      </Banner>
    );
  } else if (scanner === "disconnected") {
    banner = (
      <Banner tone="error" glyph="plugs" title={t("floor.warehouse.banner.scannerTitle")}>
        {t("floor.warehouse.banner.scannerText")}
      </Banner>
    );
  }
  return (
    <div className="rp-banner-region" aria-live="polite">
      {banner}
    </div>
  );
}

/** Whether a banner stands: the body leaves its row. */
export function hasBanner(said: Said | null, online: boolean, scanner: ScannerIndicator): boolean {
  return said !== null || !online || scanner === "disconnected";
}

/** The screen's frame: the heading, the body, the answers; a question over it takes the view's focus. */
export function ReprintFrame({
  head,
  body,
  footer = null,
  overlay = null,
  viewRef,
}: {
  head: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
  overlay?: ReactNode;
  viewRef?: Ref<HTMLElement>;
}) {
  return (
    <section
      className="warehouse-reprint"
      aria-labelledby="warehouse-title"
      tabIndex={-1}
      ref={overlay === null ? viewRef : undefined}
    >
      {head}
      {body}
      {footer}
      {overlay}
    </section>
  );
}

export function useHeading() {
  const { t } = useTranslation();
  return (setup: boolean, actions?: ReactNode, title?: string) => (
    <ReprintHeading
      eyebrow={t(setup ? "floor.warehouse.eyebrowSetup" : "floor.warehouse.eyebrowSession")}
      title={title ?? t(setup ? "floor.warehouse.title" : "floor.warehouse.titleSession")}
      titleId="warehouse-title"
      {...(actions === undefined ? {} : { actions })}
    />
  );
}

function PauseButton({ leave, onLeave }: { leave: Press; onLeave: () => void }) {
  const { t } = useTranslation();
  return (
    <FooterButton glyph="arrow-left" {...leave(onLeave)}>
      {t("floor.warehouse.pause")}
    </FooterButton>
  );
}

/** A body: the banner's place, then the zones; the banner's row is there only while one stands. */
function Body({
  banner,
  shown,
  children,
}: {
  banner: ReactNode;
  shown: boolean;
  children: ReactNode;
}) {
  return (
    <div className={shown ? "rp-body rp-body--banner" : "rp-body"}>
      {banner}
      {children}
    </div>
  );
}

/** Start of a session: the reason first, then what prints on what. */
export function SetupView({
  reason,
  lines,
  press,
  leave,
  viewRef,
  onPick,
  onChangeTemplates,
  onLeave,
  onSetup,
  onStart,
}: {
  reason: WarehouseReason | null;
  lines: readonly SummaryLine[];
  press: Press;
  leave: Press;
  viewRef?: Ref<HTMLElement>;
  onPick: (reason: WarehouseReason) => void;
  onChangeTemplates: (kind: JobKindView) => void;
  onLeave: () => void;
  onSetup: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const heading = useHeading();
  return (
    <ReprintFrame
      {...(viewRef === undefined ? {} : { viewRef })}
      head={heading(true)}
      body={
        <div className="rp-zones rp-zones--setup">
          <section className="rp-setup-reasons" aria-labelledby="warehouse-setup-title">
            <h3 id="warehouse-setup-title" className="rp-label rp-label--hidden">
              {t("floor.warehouse.sessionSetup")}
            </h3>
            <ReasonList
              picked={reason}
              onPick={onPick}
              press={press}
              legend={t("floor.warehouse.reason")}
            />
            <p>{t("floor.warehouse.reasonHint")}</p>
            <p>{t("floor.warehouse.scope")}</p>
          </section>
          <section aria-labelledby="warehouse-summary-title">
            <h3 id="warehouse-summary-title" className="rp-label">
              {t("floor.warehouse.summary.title")}
            </h3>
            <SummaryList
              lines={lines}
              press={press}
              onChange={onChangeTemplates}
              disabled={false}
            />
          </section>
        </div>
      }
      footer={
        <ReprintFooter>
          <PauseButton leave={leave} onLeave={onLeave} />
          <FooterButton glyph="gear" {...leave(onSetup)}>
            {t("floor.warehouse.setup")}
          </FooterButton>
          <FooterButton
            primary
            glyph="printer"
            disabled={reason === null}
            {...press(() => {
              if (reason !== null) onStart();
            })}
          >
            {t("floor.warehouse.start")}
          </FooterButton>
        </ReprintFooter>
      }
    />
  );
}

/** The session at rest: its journal on the left, the scan zone on the right. */
export function SessionView({
  journal,
  filter,
  onFilter,
  onOpen,
  said,
  online,
  scanner,
  reasonText,
  sent,
  press,
  leave,
  viewRef,
  overlay,
  onReason,
  onManual,
  onTemplates,
  onFinish,
  onLeave,
}: {
  journal: readonly WarehouseJob[];
  filter: JournalFilter;
  onFilter: (filter: JournalFilter) => void;
  onOpen: (job: WarehouseJob) => void;
  said: Said | null;
  online: boolean;
  scanner: ScannerIndicator;
  reasonText: string;
  sent: number;
  press: Press;
  leave: Press;
  viewRef?: Ref<HTMLElement>;
  overlay?: ReactNode;
  onReason: () => void;
  onManual: () => void;
  onTemplates: () => void;
  onFinish: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const heading = useHeading();
  const variant: ZoneVariant =
    scanner === "disconnected"
      ? "scanner"
      : !online
        ? "offline"
        : said?.kind === "not_found"
          ? "not_found"
          : "ready";
  const banner = <ReprintBanner said={said} online={online} scanner={scanner} />;
  const zones = (
    <div className="rp-zones">
      {journal.length === 0 ? (
        <JournalEmpty />
      ) : (
        <Journal
          jobs={filterJobs(journal, filter)}
          filter={filter}
          onFilter={onFilter}
          onOpen={onOpen}
          press={press}
        />
      )}
      <ScanZone
        variant={variant}
        manual={
          <Button
            size="floor"
            variant={variant === "scanner" ? "primary" : "secondary"}
            icon={<Glyph name="keyboard" size={26} />}
            disabled={!online}
            {...press(onManual)}
          >
            {t("floor.warehouse.manual")}
          </Button>
        }
      />
    </div>
  );
  return (
    <ReprintFrame
      {...(viewRef === undefined ? {} : { viewRef })}
      head={heading(
        false,
        <>
          <FooterButton glyph="info" {...press(onReason)}>
            {reasonText}
          </FooterButton>
          <Tag tone="ok" glyph="printer">
            {t("floor.warehouse.sentChip", { sent })}
          </Tag>
        </>,
      )}
      body={
        <Body banner={banner} shown={hasBanner(said, online, scanner)}>
          {zones}
        </Body>
      }
      footer={
        <ReprintFooter>
          <PauseButton leave={leave} onLeave={onLeave} />
          <FooterButton glyph="file" {...press(onTemplates)}>
            {t("floor.warehouse.chooseTemplates")}
          </FooterButton>
          <FooterButton glyph="stop" end {...press(onFinish)}>
            {t("floor.warehouse.finish")}
          </FooterButton>
        </ReprintFooter>
      }
      overlay={overlay ?? null}
    />
  );
}

/** What a job's detail does: every answer is the screen's. */
export interface JobHandlers {
  onSend: () => void;
  onRetry: () => void;
  onCancelJob: () => void;
  onAgain: () => void;
  onNext: () => void;
  onVerify: () => void;
  onSetup: () => void;
  onLeave: () => void;
}

function JobFooter({
  job,
  verifying,
  press,
  leave,
  handlers,
}: {
  job: WarehouseJob;
  verifying: boolean;
  press: Press;
  leave: Press;
  handlers: JobHandlers;
}) {
  const { t } = useTranslation();
  const again = (primary: boolean) => (
    <FooterButton glyph="refresh" primary={primary} {...press(handlers.onAgain)}>
      {t("floor.warehouse.printAgain")}
    </FooterButton>
  );
  const next = (
    <FooterButton primary glyph="barcode" {...press(handlers.onNext)}>
      {t("floor.warehouse.nextCode")}
    </FooterButton>
  );
  switch (job.state) {
    case "sending":
      return (
        <FooterButton
          primary
          glyph="circle-notch"
          aria-disabled="true"
          style={{ opacity: 0.45, cursor: "not-allowed" }}
        >
          {t("floor.warehouse.printing")}
        </FooterButton>
      );
    case "prepared":
      return (
        <FooterButton primary glyph="printer" {...press(handlers.onSend)}>
          {t("floor.warehouse.send")}
        </FooterButton>
      );
    case "failed": {
      const cancel = (
        <FooterButton glyph="x" {...press(handlers.onCancelJob)}>
          {t("floor.warehouse.cancelJob")}
        </FooterButton>
      );
      const retry = (primary: boolean) => (
        <FooterButton glyph="refresh" primary={primary} {...press(handlers.onRetry)}>
          {t("floor.warehouse.retrySend")}
        </FooterButton>
      );
      return isPrinterSetupFailure(job.errorCode) ? (
        <>
          {cancel}
          {retry(false)}
          <FooterButton primary glyph="gear" {...leave(handlers.onSetup)}>
            {t("floor.warehouse.setup")}
          </FooterButton>
        </>
      ) : (
        <>
          {cancel}
          <FooterButton glyph="gear" {...leave(handlers.onSetup)}>
            {t("floor.warehouse.setup")}
          </FooterButton>
          {retry(true)}
        </>
      );
    }
    case "unknown":
      return (
        <>
          {again(false)}
          <FooterButton
            primary={!verifying}
            glyph="scan-frame"
            aria-pressed={verifying}
            {...press(handlers.onVerify)}
          >
            {t(verifying ? "floor.warehouse.verifyCancel" : "floor.warehouse.verifyButton")}
          </FooterButton>
        </>
      );
    case "sent":
    case "verified":
      return (
        <>
          {again(false)}
          {next}
        </>
      );
    case "cancelled":
      return next;
  }
}

/** A job's detail: the subject on the left, what goes and where it stands on the right. */
export function JobView({
  job,
  verifying,
  templateName,
  resultText,
  note,
  said,
  online,
  scanner,
  reasonText,
  press,
  leave,
  viewRef,
  overlay,
  handlers,
}: {
  /** The job as the detail shows it (`sending` while its bytes are on their way). */
  job: WarehouseJob;
  verifying: boolean;
  templateName: string | null;
  /** The words of the result's body: the screen chooses them (a hint, or a print's code). */
  resultText: string | null;
  note: string | null;
  said: Said | null;
  online: boolean;
  scanner: ScannerIndicator;
  reasonText: string;
  press: Press;
  leave: Press;
  viewRef?: Ref<HTMLElement>;
  overlay?: ReactNode;
  handlers: JobHandlers;
}) {
  const { t } = useTranslation();
  const heading = useHeading();
  const banner = <ReprintBanner said={said} online={online} scanner={scanner} />;
  const zones = (
    <div className="rp-zones rp-zones--job">
      <JobSubject job={job} />
      <JobPrint
        templateName={templateName}
        printer={printerView(job)}
        reason={t(`floor.warehouse.reasons.${job.reason}`)}
        result={resultView(job, verifying)}
        resultText={resultText}
        note={note}
      />
    </div>
  );
  return (
    <ReprintFrame
      {...(viewRef === undefined ? {} : { viewRef })}
      head={heading(
        false,
        <>
          <Tag tone="neutral" glyph="info">
            {reasonText}
          </Tag>
          {/* Never held by work: the floor's leave waits for it (N9). */}
          <PauseButton leave={leave} onLeave={handlers.onLeave} />
        </>,
      )}
      body={
        <Body banner={banner} shown={hasBanner(said, online, scanner)}>
          {zones}
        </Body>
      }
      footer={
        <ReprintFooter>
          <JobFooter
            job={job}
            verifying={verifying}
            press={press}
            leave={leave}
            handlers={handlers}
          />
        </ReprintFooter>
      }
      overlay={overlay ?? null}
    />
  );
}

/** The typed code: its own screen, the reason beside the title, «Отмена» the only way back. */
export function ManualView({
  value,
  onChange,
  onSubmit,
  online,
  submitProps,
  reasonText,
  press,
  viewRef,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  online: boolean;
  submitProps: PressProps;
  reasonText: string;
  press: Press;
  viewRef?: Ref<HTMLElement>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const heading = useHeading();
  return (
    <ReprintFrame
      {...(viewRef === undefined ? {} : { viewRef })}
      head={heading(
        false,
        <Tag tone="neutral" glyph="info">
          {reasonText}
        </Tag>,
        t("floor.warehouse.manual"),
      )}
      body={
        <div
          className="rp-body"
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
          }}
        >
          <ManualEntry
            value={value}
            onChange={onChange}
            online={online}
            onSubmit={onSubmit}
            submitProps={submitProps}
          />
        </div>
      }
      footer={
        <ReprintFooter>
          <FooterButton glyph="x" {...press(onCancel)}>
            {t("floor.warehouse.cancel")}
          </FooterButton>
        </ReprintFooter>
      }
    />
  );
}

/** «Причина новой попытки» and «Изменить причину»: a reason from three rows, an answer. */
export function ReasonDialog({
  again,
  picked,
  onPick,
  onConfirm,
  closeProps,
  press,
  dialogRef,
}: {
  /** A new attempt of a printed label (its own title and line) rather than the session's reason. */
  again: boolean;
  picked: WarehouseReason | null;
  onPick: (reason: WarehouseReason) => void;
  onConfirm: () => void;
  closeProps: PressProps & { onClick: () => void };
  press: Press;
  dialogRef: Ref<HTMLElement>;
}) {
  const { t } = useTranslation();
  return (
    <ReprintDialog
      titleId="warehouse-reason-title"
      title={t(again ? "floor.warehouse.againTitle" : "floor.warehouse.changeReason")}
      dialogRef={dialogRef}
      onCancel={closeProps.onClick}
      actions={
        <>
          <FooterButton glyph="x" {...closeProps}>
            {t("floor.warehouse.cancel")}
          </FooterButton>
          <FooterButton
            primary
            glyph="printer"
            disabled={picked === null}
            {...press(() => {
              if (picked !== null) onConfirm();
            })}
          >
            {t(again ? "floor.warehouse.againConfirm" : "floor.warehouse.applyReason")}
          </FooterButton>
        </>
      }
    >
      {again ? <p>{t("floor.warehouse.againText")}</p> : null}
      <ReasonList
        picked={picked}
        onPick={onPick}
        press={press}
        legend={t("floor.warehouse.reason")}
        hideLegend
      />
    </ReprintDialog>
  );
}

/** «Завершить сеанс перепечатки?»: what was sent and what still waits for the host. */
export function FinishDialog({
  sent,
  waiting,
  onConfirm,
  closeProps,
  press,
  dialogRef,
}: {
  sent: number;
  waiting: number;
  onConfirm: () => void;
  closeProps: PressProps & { onClick: () => void };
  press: Press;
  dialogRef: Ref<HTMLElement>;
}) {
  const { t } = useTranslation();
  return (
    <ReprintDialog
      titleId="warehouse-finish-title"
      title={t("floor.warehouse.finishTitle")}
      dialogRef={dialogRef}
      onCancel={closeProps.onClick}
      actions={
        <>
          <FooterButton glyph="x" {...closeProps}>
            {t("floor.warehouse.cancel")}
          </FooterButton>
          <FooterButton primary glyph="stop" {...press(onConfirm)}>
            {t("floor.warehouse.finishConfirm")}
          </FooterButton>
        </>
      }
    >
      <p>{t("floor.warehouse.finishText", { sent })}</p>
      {waiting > 0 ? (
        <Tag tone="warn" glyph="upload">
          {t("floor.warehouse.waiting", { waiting })}
        </Tag>
      ) : null}
    </ReprintDialog>
  );
}
