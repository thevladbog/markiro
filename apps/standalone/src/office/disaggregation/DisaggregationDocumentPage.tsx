import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DefinitionGrid,
  FileDropZone,
  Input,
  PageHeader,
  RowActions,
  Select,
  StatusChip,
  Table,
  Textarea,
  type DefinitionGridItem,
  type TableColumn,
} from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type {
  DisaggregationDetail,
  DisaggregationDocument,
  DisaggregationLine,
  DisaggregationReason,
} from "../../host/disaggregation.js";
import { optionalTextRule, toOptionalText } from "../../lib/rules.js";
import { useCan } from "../access.js";
import { alertFailure, writeFailure } from "../form-errors.js";
import { formTimeZone } from "../forms/render-form.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading, StaleAlert } from "../page-state.js";
import {
  byReasonOrder,
  DOCUMENT_STATUS_PHASE,
  LINE_STATUS_PHASE,
  lineSsccLabel,
} from "./disaggregation-text.js";
import { DisaggregationActDialog } from "./DisaggregationActDialog.js";
import { DisaggregationXmlDialog } from "./DisaggregationXmlDialog.js";
import { inParts, lineInputs, parsePastedSsccs, readSsccImport } from "./sscc-input.js";

/** The count of a number as Russian writes it: «1 200». */
const COUNTS = new Intl.NumberFormat("ru");

/** The longest comment the host takes (`MAX_COMMENT_CHARS`). */
const COMMENT_MAX = 500;

/** What the page tells after a write: a notice, or a stale write that offers to load again. */
type Status =
  { kind: "text"; tone: "ok" | "warn" | "error"; text: string; focus: boolean } | { kind: "stale" };

type DocumentDialog = "act" | "xml" | "apply" | "cancel";

/** The header of a draft: the whole of it goes in one request. */
interface HeaderChange {
  reasonId: string | null;
  comment: string | null;
  expectedRev: number;
}

interface HeaderFormProps {
  document: DisaggregationDocument;
  reasons: readonly DisaggregationReason[] | undefined;
  busy: boolean;
  /** The server's word about the comment (a `validation_failed` on it), or `null`. */
  commentRejected: boolean;
  onSave: (change: HeaderChange) => void;
}

/**
 * The draft's reason and comment. A reason is saved as soon as it is chosen, a
 * comment when its field loses focus and only if it changed: the host takes
 * the whole header over the revision every time.
 */
function HeaderForm({ document, reasons, busy, commentRejected, onSave }: HeaderFormProps) {
  const { t } = useTranslation();
  const [comment, setComment] = useState(document.comment ?? "");
  // The comment follows the document when it is read again (set while rendering, React's way to
  // follow a value from an earlier render): a header loaded afresh drops the edit.
  const [seen, setSeen] = useState(document.comment);
  if (seen !== document.comment) {
    setSeen(document.comment);
    setComment(document.comment ?? "");
  }
  const [problem, setProblem] = useState<string | null>(null);

  const options = reasonOptions(reasons, document, t);
  /** The comment as the host takes it, or `null` (and the problem shown) when it cannot go. */
  const checked = (): { value: string | null } | null => {
    const result = optionalTextRule(COMMENT_MAX, "rules.rejected").safeParse(comment);
    if (!result.success) {
      setProblem(result.error.issues[0]?.message ?? "rules.rejected");
      return null;
    }
    setProblem(null);
    return { value: toOptionalText(result.data) };
  };
  const save = (reasonId: string | null) => {
    const valid = checked();
    if (valid === null) return;
    onSave({ reasonId, comment: valid.value, expectedRev: document.rev });
  };
  const message = problem ?? (commentRejected ? "rules.rejected" : null);

  return (
    <div className="standalone-form">
      <Select
        label={t("office.disaggregation.detail.reason")}
        options={options}
        value={document.reasonId ?? ""}
        disabled={busy}
        onValueChange={(value) => save(value === "" ? null : value)}
      />
      <Input
        label={t("office.disaggregation.detail.comment")}
        value={comment}
        maxLength={COMMENT_MAX}
        disabled={busy}
        {...(message === null ? {} : { error: t(message) })}
        onChange={(event) => {
          setComment(event.target.value);
          setProblem(null);
        }}
        onBlur={() => {
          if ((toOptionalText(comment) ?? "") === (document.comment ?? "")) return;
          save(document.reasonId);
        }}
      />
    </div>
  );
}

/** The options of the reason field: «not chosen», the reasons in use, and the document's own if archived. */
function reasonOptions(
  reasons: readonly DisaggregationReason[] | undefined,
  document: DisaggregationDocument,
  t: TFunction,
): { value: string; label: string }[] {
  const shown = [...(reasons ?? [])]
    .filter((reason) => !reason.archived || reason.id === document.reasonId)
    .sort(byReasonOrder)
    .map((reason) => ({
      value: reason.id,
      label: reason.archived ? t("office.common.archivedName", { name: reason.name }) : reason.name,
    }));
  if (document.reasonId !== null && !shown.some((option) => option.value === document.reasonId)) {
    shown.push({ value: document.reasonId, label: document.reasonName ?? document.reasonId });
  }
  return [{ value: "", label: t("office.disaggregation.detail.reasonNone") }, ...shown];
}

interface AddLinesCardProps {
  busy: boolean;
  /** Adds the tokens; the number that went in, from the first. */
  onPaste: (tokens: string[]) => Promise<number>;
  onFile: (file: File) => void;
  onRejected: () => void;
}

/** SSCCs of boxes and pallets, pasted or scanned into a field, or taken from a .txt or .csv file. */
function AddLinesCard({ busy, onPaste, onFile, onRejected }: AddLinesCardProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const tokens = parsePastedSsccs(text);
  const add = async () => {
    const added = await onPaste(tokens);
    // What did not go in stays to be added again.
    setText(tokens.slice(added).join("\n"));
  };
  return (
    <Card title={t("office.disaggregation.detail.addTitle")} titleAs="h2">
      <div className="standalone-form">
        <Textarea
          label={t("office.disaggregation.detail.addLabel")}
          placeholder={t("office.disaggregation.detail.addPlaceholder")}
          rows={4}
          value={text}
          // Held still while the lines go in: what the add leaves is put back into the field.
          readOnly={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="standalone-form__actions">
          <Button disabled={busy || tokens.length === 0} onClick={() => void add()}>
            {t("office.disaggregation.detail.addAction")}
          </Button>
        </div>
        <FileDropZone
          compact
          accept=".txt,.csv"
          label={t("office.disaggregation.detail.importLabel")}
          busy={busy}
          busyLabel={t("office.disaggregation.detail.importBusy")}
          onFile={onFile}
          onRejected={onRejected}
        />
        <p className="office-note">{t("office.disaggregation.detail.importHint")}</p>
      </div>
    </Card>
  );
}

/** The level of a line: a box, a pallet, or nothing found. */
function levelKey(line: DisaggregationLine): "box" | "pallet" | "unknown" {
  if (line.boxId !== null) return "box";
  if (line.palletId !== null) return "pallet";
  return "unknown";
}

/**
 * One disaggregation document (plan ДЗГ-О): a draft is edited, filled with
 * SSCCs, applied or cancelled; an applied or cancelled one is read, and the
 * act and the ЧЗ file are made from it. The host holds every rule: the page
 * shows its answers.
 */
export function DisaggregationDocumentPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const canWrite = useCan("planShifts");
  const queryClient = useQueryClient();
  const noticeId = useId();
  const hintId = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [commentRejected, setCommentRejected] = useState(false);
  const [dialog, setDialog] = useState<DocumentDialog | null>(null);
  const [adding, setAdding] = useState(false);
  // Set at once, so a second press in the same moment is refused before `adding` re-rendered.
  const inFlight = useRef(false);
  const transitioning = useRef(false);

  const doc = useOfficeQuery(officeKeys.disaggregationDocument(id), (api, token) =>
    api.getDisaggregation(token, id),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const reasons = useOfficeQuery(officeKeys.disaggregationReasons, (api, token) =>
    api.listDisaggregationReasons(token),
  );
  const saveHeader = useOfficeMutation((api, token, change: HeaderChange) =>
    api.updateDisaggregation(token, id, change),
  );
  const addLines = useOfficeMutation(
    (api, token, add: { lines: ReturnType<typeof lineInputs>; import: boolean }) =>
      api.addDisaggregationLines(token, id, add),
  );
  const removeLine = useOfficeMutation((api, token, lineId: string) =>
    api.deleteDisaggregationLine(token, id, lineId),
  );
  const apply = useOfficeMutation((api, token, expectedRev: number) =>
    api.applyDisaggregation(token, id, { expectedRev }),
  );
  const cancel = useOfficeMutation((api, token, expectedRev: number) =>
    api.cancelDisaggregation(token, id, { expectedRev }),
  );
  const working =
    adding || saveHeader.isPending || removeLine.isPending || apply.isPending || cancel.isPending;

  // After a write the control that was pressed may be gone (the line, the buttons of a draft): the
  // notice takes the focus, so it is read and the keyboard is not lost. A saved header is the
  // exception: its fields stay, the user may already be on the next one, and the notice is an
  // alert that is read where it stands.
  useEffect(() => {
    if (status !== null && (status.kind === "stale" || status.focus)) {
      document.getElementById(noticeId)?.focus();
    }
  }, [status, noticeId]);

  /** After a write: the document and every list are read again. */
  const readAgain = () => {
    void queryClient.invalidateQueries({ queryKey: officeKeys.disaggregationDocument(id) });
    void queryClient.invalidateQueries({ queryKey: officeKeys.disaggregation });
  };
  /** What the host answered a write is the document now; the next write needs its revision. */
  const store = (detail: DisaggregationDetail) => {
    queryClient.setQueryData(officeKeys.disaggregationDocument(id), detail);
  };
  const say = (tone: "ok" | "warn" | "error", text: string, focus = true) =>
    setStatus({ kind: "text", tone, text, focus });
  const saved = (detail: DisaggregationDetail, text: string, focus = true) => {
    store(detail);
    say("ok", text, focus);
    readAgain();
  };
  /**
   * What a refused write says: a text and its tone, whether the document is read again (where its
   * state is what the host refused on), or that the write was stale (the page offers to reload).
   */
  const explain = (
    error: unknown,
  ): { stale: true } | { stale: false; tone: "warn" | "error"; text: string; reread: boolean } => {
    if (error instanceof HostError) {
      if (error.code === "conflict") {
        switch (error.details.constraint) {
          case "invalid_lines":
            return {
              stale: false,
              tone: "warn",
              text: t("office.disaggregation.detail.applyBlocked"),
              reread: true,
            };
          case "reason_required":
            return {
              stale: false,
              tone: "warn",
              text: t("office.disaggregation.detail.applyNoReason"),
              reread: true,
            };
          case "no_lines":
            return {
              stale: false,
              tone: "warn",
              text: t("office.disaggregation.detail.applyNoLines"),
              reread: true,
            };
          case "document_not_draft":
            return {
              stale: false,
              tone: "warn",
              text: t("office.disaggregation.detail.notDraft"),
              reread: true,
            };
          case "restore_hold":
            // The host waits for the stations: the draft is as it was, nothing to read again.
            return {
              stale: false,
              tone: "warn",
              text: t("office.disaggregation.detail.restoreHold"),
              reread: false,
            };
        }
      }
      if (error.code === "validation_failed" && error.field?.startsWith("lines.")) {
        // One token of the part the host cannot take (over 64 characters, or a control character).
        return {
          stale: false,
          tone: "warn",
          text: t("office.disaggregation.detail.badToken"),
          reread: false,
        };
      }
      if (error.code === "validation_failed" && error.field === "lines") {
        return {
          stale: false,
          tone: "warn",
          text: t("office.disaggregation.detail.documentFull"),
          reread: false,
        };
      }
    }
    const failure = alertFailure(error);
    if (failure.kind === "stale") return { stale: true };
    return { stale: false, tone: "error", text: t(failure.message), reread: false };
  };
  /** Explains a refused write on the page. */
  const refused = (error: unknown) => {
    const said = explain(error);
    if (said.stale) {
      setStatus({ kind: "stale" });
      return;
    }
    say(said.tone, said.text);
    if (said.reread) readAgain();
  };

  const changeHeader = async (change: HeaderChange) => {
    setStatus(null);
    setCommentRejected(false);
    let detail: DisaggregationDetail;
    try {
      detail = await saveHeader.mutateAsync(change);
    } catch (error) {
      const outcome = writeFailure(error, { comment: "comment" });
      if (outcome.kind === "field") setCommentRejected(true);
      else refused(error);
      return;
    }
    saved(detail, t("office.common.saved"), false);
  };

  /**
   * Sends tokens in the host's parts, in order, stopping at the first that fails. Answers the
   * number that went in; what failed is explained, and what is already in stays in the document.
   */
  const addTokens = async (tokens: string[], isImport: boolean): Promise<number> => {
    if (inFlight.current) return 0;
    inFlight.current = true;
    setAdding(true);
    setStatus(null);
    let added = 0;
    let last: DisaggregationDetail | null = null;
    let failure: { error: unknown } | null = null;
    for (const part of inParts(lineInputs(tokens))) {
      try {
        last = await addLines.mutateAsync({ lines: part, import: isImport });
        added += part.length;
      } catch (error) {
        failure = { error };
        break;
      }
    }
    inFlight.current = false;
    setAdding(false);
    if (last !== null) store(last);
    if (failure === null) {
      say(
        "ok",
        t(
          isImport
            ? "office.disaggregation.detail.importAdded"
            : "office.disaggregation.detail.pasteAdded",
          { count: added },
        ),
      );
      readAgain();
    } else if (added > 0) {
      // What went in stays; the cause is told too, so the rest is not added blindly again.
      const cause = explain(failure.error);
      const why = cause.stale ? t("errors.api.stale_revision") : cause.text;
      say(
        "warn",
        `${t("office.disaggregation.detail.importPartial", { added, total: tokens.length })} ${why}`,
      );
      readAgain();
    } else {
      refused(failure.error);
    }
    return added;
  };

  const importFile = async (file: File) => {
    setStatus(null);
    let parsed;
    try {
      parsed = await readSsccImport(file);
    } catch {
      say("error", t("office.disaggregation.detail.importRefused.unreadable"));
      return;
    }
    if (!parsed.ok) {
      say("warn", t(`office.disaggregation.detail.importRefused.${parsed.refusal}`));
      return;
    }
    await addTokens(parsed.tokens, true);
  };

  const deleteLine = async (line: DisaggregationLine) => {
    setStatus(null);
    let detail: DisaggregationDetail;
    try {
      detail = await removeLine.mutateAsync(line.id);
    } catch (error) {
      refused(error);
      return;
    }
    saved(detail, t("office.disaggregation.detail.lineDeleted"));
  };

  const transition = async (kind: "apply" | "cancel", rev: number) => {
    // A second press in the same moment would meet the first one's result as a false refusal.
    if (transitioning.current) return;
    transitioning.current = true;
    try {
      await runTransition(kind, rev);
    } finally {
      transitioning.current = false;
    }
  };
  const runTransition = async (kind: "apply" | "cancel", rev: number) => {
    setStatus(null);
    let detail: DisaggregationDetail;
    try {
      detail = await (kind === "apply" ? apply : cancel).mutateAsync(rev);
    } catch (error) {
      setDialog(null);
      refused(error);
      return;
    }
    setDialog(null);
    saved(
      detail,
      t(
        kind === "apply"
          ? "office.disaggregation.detail.applied"
          : "office.disaggregation.detail.cancelled",
      ),
    );
  };

  const back = (
    // The class of the shift card's back link: a link on its own line, at the start.
    <Link className="shift-card__back" to="/disaggregation">
      {t("office.disaggregation.detail.back")}
    </Link>
  );
  if (doc.data === undefined) {
    return (
      <>
        {back}
        {doc.isError ? (
          <LoadError error={doc.error} onRetry={() => void doc.refetch()} />
        ) : (
          <PageLoading />
        )}
      </>
    );
  }
  const { document: header, lines } = doc.data;
  const draft = header.status === "draft";
  const editable = draft && canWrite;
  const zone = formTimeZone(org.data);
  const time = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: zone,
  });
  const at = (instant: string) => time.format(new Date(instant));
  const canApply =
    lines.length > 0 && lines.every((line) => line.status === "ok") && header.reasonId !== null;

  const meta: DefinitionGridItem[] = [
    {
      id: "createdAt",
      term: t("office.disaggregation.detail.createdAt"),
      description: at(header.createdAt),
    },
    {
      id: "createdBy",
      term: t("office.disaggregation.detail.createdBy"),
      description: header.createdByName,
    },
    ...(header.appliedAt === null
      ? []
      : [
          {
            id: "appliedAt",
            term: t("office.disaggregation.detail.appliedAt"),
            description: at(header.appliedAt),
          },
          ...(header.appliedByName === null
            ? []
            : [
                {
                  id: "appliedBy",
                  term: t("office.disaggregation.detail.appliedBy"),
                  description: header.appliedByName,
                },
              ]),
        ]),
    ...(header.cancelledAt === null
      ? []
      : [
          {
            id: "cancelledAt",
            term: t("office.disaggregation.detail.cancelledAt"),
            description: at(header.cancelledAt),
          },
        ]),
  ];
  const view: DefinitionGridItem[] = [
    {
      id: "reason",
      term: t("office.disaggregation.detail.reason"),
      description: header.reasonName ?? t("office.disaggregation.detail.reasonNone"),
    },
    {
      id: "comment",
      term: t("office.disaggregation.detail.comment"),
      description: header.comment ?? t("office.disaggregation.detail.commentNone"),
    },
    ...meta,
  ];

  const columns: TableColumn<DisaggregationLine>[] = [
    {
      key: "sscc",
      title: t("office.disaggregation.detail.table.sscc"),
      mono: true,
      render: (line) => lineSsccLabel(line),
    },
    {
      key: "level",
      title: t("office.disaggregation.detail.table.level"),
      render: (line) => t(`office.disaggregation.detail.levels.${levelKey(line)}`),
    },
    {
      key: "shift",
      title: t("office.disaggregation.detail.table.shift"),
      mono: true,
      render: (line) =>
        line.shiftId !== null && line.shiftNumber !== null ? (
          <Link to={`/shifts/${line.shiftId}`}>{line.shiftNumber}</Link>
        ) : (
          t("office.common.none")
        ),
    },
    {
      key: "product",
      title: t("office.disaggregation.detail.table.product"),
      wrap: true,
      minWidth: 180,
      render: (line) => line.productName ?? t("office.common.none"),
    },
    {
      key: "codeCount",
      title: t("office.disaggregation.detail.table.codeCount"),
      mono: true,
      align: "right",
      render: (line) => COUNTS.format(line.codeCount),
    },
    {
      key: "status",
      title: t("office.disaggregation.detail.table.status"),
      wrap: true,
      minWidth: 200,
      render: (line) => (
        <StatusChip
          phase={LINE_STATUS_PHASE[line.status]}
          label={t(`office.disaggregation.lineStatuses.${line.status}`)}
        />
      ),
    },
  ];
  if (editable) {
    columns.push({
      key: "actions",
      title: t("office.disaggregation.detail.table.actions"),
      render: (line) => (
        <Button
          variant="secondary"
          size="compact"
          disabled={working}
          aria-label={t("office.disaggregation.detail.deleteLineNamed", {
            sscc: lineSsccLabel(line),
          })}
          onClick={() => void deleteLine(line)}
        >
          {t("office.disaggregation.detail.deleteLine")}
        </Button>
      ),
    });
  }

  return (
    <>
      {back}
      <PageHeader
        title={t("office.disaggregation.detail.title", { docNo: header.docNo })}
        actions={
          <RowActions>
            <StatusChip
              phase={DOCUMENT_STATUS_PHASE[header.status]}
              label={t(`office.disaggregation.statuses.${header.status}`)}
            />
            <Button variant="secondary" onClick={() => setDialog("act")}>
              {t("office.disaggregation.detail.printAct")}
            </Button>
            {header.status === "applied" && canWrite && (
              <Button variant="secondary" onClick={() => setDialog("xml")}>
                {t("office.disaggregation.detail.xml")}
              </Button>
            )}
          </RowActions>
        }
      />
      {status?.kind === "text" && (
        <Alert tone={status.tone} id={noticeId} tabIndex={-1}>
          {status.text}
        </Alert>
      )}
      {status?.kind === "stale" && (
        <div id={noticeId} tabIndex={-1}>
          <StaleAlert
            onReload={() => {
              setStatus(null);
              setCommentRejected(false);
              readAgain();
            }}
          />
        </div>
      )}
      {reasons.isError && editable && (
        <LoadError error={reasons.error} onRetry={() => void reasons.refetch()} />
      )}
      <Card>
        {editable ? (
          <div className="standalone-form">
            <HeaderForm
              key={header.id}
              document={header}
              reasons={reasons.data}
              busy={working}
              commentRejected={commentRejected}
              onSave={(change) => void changeHeader(change)}
            />
            <DefinitionGrid items={meta} />
          </div>
        ) : (
          <DefinitionGrid items={view} />
        )}
      </Card>
      {editable && (
        <AddLinesCard
          busy={working}
          onPaste={(tokens) => addTokens(tokens, false)}
          onFile={(file) => void importFile(file)}
          onRejected={() => say("warn", t("office.disaggregation.detail.importRefused.extension"))}
        />
      )}
      <Card title={t("office.disaggregation.detail.linesTitle")} titleAs="h2">
        <Table
          columns={columns}
          rows={lines}
          getRowKey={(line) => line.id}
          empty={t("office.disaggregation.detail.linesEmpty")}
          scrollLabel={t("office.disaggregation.detail.linesCaption")}
        />
      </Card>
      {editable && (
        <div className="standalone-form">
          {!canApply && (
            <p id={hintId} className="office-note">
              {t("office.disaggregation.detail.applyHint")}
            </p>
          )}
          <div className="standalone-form__actions">
            <Button
              variant="destructive-outline"
              disabled={working}
              onClick={() => setDialog("cancel")}
            >
              {t("office.disaggregation.detail.cancel")}
            </Button>
            <Button
              disabled={!canApply || working}
              {...(canApply ? {} : { "aria-describedby": hintId })}
              onClick={() => setDialog("apply")}
            >
              {t("office.disaggregation.detail.apply")}
            </Button>
          </div>
        </div>
      )}
      {editable && (
        <>
          <ConfirmDialog
            open={dialog === "apply"}
            title={t("office.disaggregation.detail.applyConfirmTitle")}
            description={t("office.disaggregation.detail.applyConfirm", {
              lines: lines.length,
              codes: lines.reduce((sum, line) => sum + line.codeCount, 0),
            })}
            confirmLabel={t("office.disaggregation.detail.applyConfirmAction")}
            cancelLabel={t("office.disaggregation.detail.dismiss")}
            busy={apply.isPending}
            onConfirm={() => void transition("apply", header.rev)}
            onCancel={() => setDialog(null)}
          />
          <ConfirmDialog
            open={dialog === "cancel"}
            tone="destructive"
            title={t("office.disaggregation.detail.cancelConfirmTitle")}
            description={t("office.disaggregation.detail.cancelConfirm")}
            confirmLabel={t("office.disaggregation.detail.cancelConfirmAction")}
            cancelLabel={t("office.disaggregation.detail.dismiss")}
            busy={cancel.isPending}
            onConfirm={() => void transition("cancel", header.rev)}
            onCancel={() => setDialog(null)}
          />
        </>
      )}
      {dialog === "act" && (
        <DisaggregationActDialog
          documentId={header.id}
          docNo={header.docNo}
          timeZone={zone}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "xml" && (
        <DisaggregationXmlDialog
          documentId={header.id}
          docNo={header.docNo}
          timeZone={zone}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
