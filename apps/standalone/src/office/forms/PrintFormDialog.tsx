import type { PlacardFormat } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Modal, RadioGroup } from "@markiro/ui";

import type { HostApi } from "../../host/api.js";
import { errorMessageKey } from "../../host/errors.js";
import type {
  BoxReportRows,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
  PalletReportRows,
  ProductPhoto,
} from "../../host/protocol.js";
import { useOfficeFiles } from "../exports/office-files-context.js";
import { OfficeFilesError, type SavedFolder } from "../exports/office-files.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import type { TaskFormInputs } from "./form-data.js";
import { usePrintForm } from "./form-printer-context.js";
import { formFolder, openInBrowser, paint } from "./print-form.js";
import { useRefreshStoredFiles } from "../exports/use-refresh-files.js";
import { storeForm, type FormTarget as StoredFormTarget } from "./store-form.js";
import { prepareForm, type FormRequest } from "./render-form.js";
import { taskFormInputs } from "./task-inputs.js";

/** The form a card's button asks for; `label` names its box or pallet in the title. */
export type FormTarget =
  | { kind: "box"; boxId: string; label: string }
  | { kind: "pallet"; palletId: string; label: string }
  | { kind: "placard"; palletId: string; label: string }
  | { kind: "placards" }
  | { kind: "task" };

export interface PrintFormDialogProps {
  shift: OfficeShift;
  target: FormTarget;
  /** What «Бланк смены» is drawn from, `null` while one of its records is not loaded. */
  taskInputs: TaskFormInputs | null;
  /** The zone the forms write times in (`formTimeZone`). */
  timeZone: string;
  /** The placards' paper, kept by the card across openings, as the cloud's choice is. */
  format: PlacardFormat;
  onFormat: (format: PlacardFormat) => void;
  onClose: () => void;
}

/** What a form belongs to on the host: the card it is printed from. */
function formTarget(target: FormTarget, shiftId: string): StoredFormTarget {
  switch (target.kind) {
    case "box":
      return { type: "box", id: target.boxId };
    case "pallet":
    case "placard":
      return { type: "pallet", id: target.palletId };
    case "placards":
    case "task":
      return { type: "shift", id: shiftId };
  }
}

/** Where a press is: the data is read again, the form is drawn, the file is saved. */
type Stage = "reading" | "drawing" | "saving";

type Outcome = { kind: "opened"; saved: SavedFolder } | { kind: "failed"; message: string };

/** What a form is drawn from, as last read; a source its target does not use stays empty. */
interface Sources {
  box: BoxReportRows | undefined;
  pallets: PalletReportRows | undefined;
  task: TaskFormInputs | null;
}

/** The office's request for the form from `sources`, or `null` while they lack what it needs. */
function formRequest(
  target: FormTarget,
  sources: Sources,
  timeZone: string,
  format: PlacardFormat,
  generatedAt: Date,
): FormRequest | null {
  switch (target.kind) {
    case "box":
      return sources.box === undefined ? null : { kind: "box", rows: sources.box, timeZone };
    case "pallet":
      return sources.pallets === undefined
        ? null
        : { kind: "pallet", rows: sources.pallets, palletId: target.palletId, timeZone };
    case "placard":
      return sources.pallets === undefined
        ? null
        : { kind: "placard", rows: sources.pallets, palletId: target.palletId, format };
    case "placards":
      return sources.pallets === undefined
        ? null
        : { kind: "placards", rows: sources.pallets, format };
    case "task":
      return sources.task === null ? null : { kind: "task", inputs: sources.task, generatedAt };
  }
}

type Listed<K extends keyof HostApi> = Awaited<ReturnType<HostApi[K]>>;

/**
 * One printed form of a shift (plan О-Ф): the dialog reads the host's rows
 * when it opens (`staleTime` 0; a cached answer of an earlier opening is
 * never drawn from), and each press reads them AGAIN before it draws, with
 * `@markiro/domain`, exactly as the cloud's route draws it — a dialog left
 * open while the station closes a box must not print the box as it was. The
 * press then prints in the office's window («Печать») or saves the form
 * under `Документы\Markiro\Формы` and opens it in the default browser
 * («Открыть в браузере»). A form the cloud would refuse says why and offers
 * neither. The draw of a big form is the one heavy step: the press says what
 * it is doing and lets the window paint it first, the buttons stay on the
 * keyboard while it works (`aria-disabled`), and closing the dialog
 * abandons the press before anything is printed or saved.
 */
export function PrintFormDialog({
  shift,
  target,
  taskInputs,
  timeZone,
  format,
  onFormat,
  onClose,
}: PrintFormDialogProps) {
  const { t } = useTranslation();
  const files = useOfficeFiles();
  const print = usePrintForm();
  const queryClient = useQueryClient();
  const session = useOfficeSession();
  const refreshFiles = useRefreshStoredFiles();
  const { api, call } = session;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The words for why the host kept no copy of the last form, or `null`.
  const [hostCopy, setHostCopy] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const boxId = target.kind === "box" ? target.boxId : "";
  const box = useOfficeQuery(
    officeKeys.boxReport(boxId),
    (api, token) => api.getBoxReportRows(token, boxId),
    { enabled: target.kind === "box" },
  );
  const ofPallets =
    target.kind === "pallet" || target.kind === "placard" || target.kind === "placards";
  const pallets = useOfficeQuery(
    officeKeys.shiftPalletReport(shift.id),
    (api, token) => api.getPalletReportRows(token, shift.id),
    { enabled: ofPallets },
  );
  const read = target.kind === "box" ? box : ofPallets ? pallets : null;
  const busy = stage !== null;
  // Not the answer of an earlier opening: it is read again, and until it is
  // (our own press reads too, and keeps the buttons where they are) nothing is offered.
  const reading = read !== null && (read.isPending || (read.isFetching && !busy));
  const failed = !reading && read !== null && read.isError;
  const blankUnavailable = target.kind === "task" && taskInputs === null;

  const prepared = useMemo(() => {
    const asked = formRequest(
      target,
      { box: box.data, pallets: pallets.data, task: taskInputs },
      timeZone,
      format,
      new Date(),
    );
    return asked === null ? null : prepareForm(asked);
  }, [target, box.data, pallets.data, taskInputs, timeZone, format]);
  const settled = !reading && !failed && !blankUnavailable;
  const refused = settled && prepared === null;
  const drawable = settled && prepared !== null;

  /** The sources read at this moment, or `null` when a read failed (the page then says so). */
  async function readAgain(): Promise<Sources | null> {
    switch (target.kind) {
      case "box": {
        const answer = await box.refetch();
        return answer.isError || answer.data === undefined
          ? null
          : { box: answer.data, pallets: undefined, task: null };
      }
      case "pallet":
      case "placard":
      case "placards": {
        const answer = await pallets.refetch();
        return answer.isError || answer.data === undefined
          ? null
          : { box: undefined, pallets: answer.data, task: null };
      }
      case "task": {
        // The blank names the shift, its product, line, counterparty and the organization.
        await Promise.all(
          [
            officeKeys.shift(shift.id),
            officeKeys.products,
            officeKeys.lines,
            officeKeys.counterparties,
            officeKeys.org,
          ].map((queryKey) =>
            queryClient.refetchQueries({ queryKey, exact: true }, { throwOnError: true }),
          ),
        );
        const current =
          queryClient.getQueryData<Listed<"getShift">>(officeKeys.shift(shift.id)) ?? shift;
        const products = queryClient.getQueryData<Listed<"listProducts">>(officeKeys.products);
        const inputs = taskFormInputs(
          current,
          products,
          queryClient.getQueryData<Listed<"listLines">>(officeKeys.lines),
          queryClient.getQueryData<Listed<"listCounterparties">>(officeKeys.counterparties),
          queryClient.getQueryData<OrgProfile>(officeKeys.org),
          await readPhoto(products?.find((each) => each.id === current.productId)),
        );
        return { box: undefined, pallets: undefined, task: inputs };
      }
    }
  }

  /**
   * The product's photo read again for a press (plan ТОВ): none without one, and
   * none when it does not read — a photo never stops «Бланк смены».
   */
  async function readPhoto(product: OfficeProduct | undefined): Promise<ProductPhoto | null> {
    if (product === undefined || product.photoChecksum === null) return null;
    try {
      const state = await queryClient.fetchQuery({
        queryKey: officeKeys.productPhoto(product.id),
        queryFn: () => call((token) => api.getProductPhoto(token, product.id)),
        staleTime: 0,
      });
      return state.photo;
    } catch {
      return null;
    }
  }

  /** The words for what stopped a press: the host's, the shell's, or the disk's. */
  function failureText(error: unknown, at: Stage | null): string {
    if (error instanceof OfficeFilesError) return t(`office.forms.files.${error.code}`);
    return at === "reading" ? t(errorMessageKey(error)) : t("office.forms.files.storage");
  }

  /** Closes the dialog once a form is in the print window or the browser. */
  function closeAfterHandOff(): void {
    if (alive.current) onClose();
  }

  async function press(how: "print" | "open"): Promise<void> {
    if (inFlight.current || !drawable) return;
    inFlight.current = true;
    let at: Stage = "reading";
    setStage(at);
    setOutcome(null);
    setHostCopy(null);
    try {
      const fresh = await readAgain();
      // A dialog closed while the rows were read is found out after the paint, before any draw.
      if (fresh === null) return;
      at = "drawing";
      setStage(at);
      await paint();
      if (!alive.current) return;
      // Prepared again from the rows just read, at the moment of printing.
      const asked = formRequest(target, fresh, timeZone, format, new Date());
      const form = asked === null ? null : prepareForm(asked);
      // Nothing to draw: the rows just read were also the dialog's own, which now says why.
      if (form === null) return;
      const html = form.draw();
      // The host keeps the exact HTML first, printed or opened: a form can then be had again from
      // the card. A host that cannot never stops the form.
      const kept = await storeForm(
        session,
        { kind: form.kind, html, fileName: form.fileName },
        formTarget(target, shift.id),
      );
      refreshFiles();
      if (alive.current) setHostCopy(kept === null ? null : t(kept));
      if (how === "print") {
        try {
          print(html);
        } catch {
          setOutcome({ kind: "failed", message: t("office.forms.printFailed") });
          return;
        }
        // The print window is up: the dialog has nothing more to say, so it goes by itself, unless
        // the host could not keep its copy (the warning stays to be read).
        if (kept === null) closeAfterHandOff();
        return;
      }
      at = "saving";
      setStage(at);
      await paint();
      if (!alive.current) return;
      const folder = formFolder(shift.number, form.kind, new Date().toISOString(), timeZone);
      const saved = await openInBrowser(
        files,
        { kind: form.kind, html, fileName: form.fileName },
        folder,
      );
      if (alive.current) setOutcome({ kind: "opened", saved });
      // The browser has the form: close the dialog, so there is none to dismiss on the way back.
      if (kept === null) closeAfterHandOff();
    } catch (error) {
      if (alive.current) setOutcome({ kind: "failed", message: failureText(error, at) });
    } finally {
      inFlight.current = false;
      if (alive.current) setStage(null);
    }
  }

  async function showFolder(saved: SavedFolder): Promise<void> {
    try {
      await files.open(saved.segments);
    } catch (error) {
      if (alive.current) setOutcome({ kind: "failed", message: failureText(error, null) });
    }
  }

  const title =
    target.kind === "box" || target.kind === "pallet" || target.kind === "placard"
      ? t(`office.forms.titles.${target.kind}`, { label: target.label })
      : t(`office.forms.titles.${target.kind}`, { number: shift.number });

  const waiting = busy ? { "aria-disabled": true as const } : {};

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
          <Button
            variant="secondary"
            disabled={!drawable}
            {...waiting}
            onClick={() => void press("open")}
          >
            {t("office.forms.openInBrowser")}
          </Button>
          <Button disabled={!drawable} {...waiting} onClick={() => void press("print")}>
            {t("office.forms.print")}
          </Button>
        </>
      }
    >
      {reading ? (
        <PageLoading />
      ) : failed && read !== null ? (
        <LoadError error={read.error} onRetry={() => void read.refetch()} />
      ) : (
        <>
          {(target.kind === "placard" || target.kind === "placards") && (
            <RadioGroup
              label={t("office.forms.paper")}
              name="form-paper"
              value={format}
              disabled={busy}
              onValueChange={(value) => onFormat(value === "a5" ? "a5" : "a4")}
              options={[
                { value: "a4", label: t("office.forms.papers.a4") },
                { value: "a5", label: t("office.forms.papers.a5") },
              ]}
            />
          )}
          <p className="office-note">{t("office.forms.hint")}</p>
        </>
      )}
      {/* On the screen before it is said into, so that what is put into it is heard once, by
          this region: its messages are not alerts of their own (`role="presentation"`). */}
      <div aria-live="polite">
        {stage !== null && <p className="office-note">{t(`office.forms.${stage}`)}</p>}
        {blankUnavailable && !reading && (
          <Alert tone="warn" role="presentation">
            {t("office.forms.taskUnavailable")}
          </Alert>
        )}
        {refused && (
          <Alert tone="warn" role="presentation">
            {t(`office.forms.refused.${target.kind}`)}
          </Alert>
        )}
        {outcome?.kind === "opened" && (
          <Alert
            tone="ok"
            role="presentation"
            action={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void showFolder(outcome.saved)}
              >
                {t("office.forms.showFolder")}
              </Button>
            }
          >
            {t("office.forms.opened", { path: outcome.saved.path })}
          </Alert>
        )}
        {hostCopy !== null && (
          <Alert tone="warn" role="presentation">
            {t("office.storedFiles.hostCopyFailed", { reason: hostCopy })}
          </Alert>
        )}
        {outcome?.kind === "failed" && (
          <Alert tone="error" role="presentation">
            {outcome.message}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
