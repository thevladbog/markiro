/**
 * Admin disaggregation document detail/editor (Task 10). Reached from the
 * list page (`./index.tsx`) and from the list's create flow. A draft
 * document is a live editor: header (reason/comment), an add-lines panel
 * (paste or import SSCCs), a per-line status table with delete, and an
 * apply/cancel action bar. `applied`/`cancelled` documents render the same
 * shell read-only -- no header inputs, no add panel, no apply/cancel/delete
 * controls.
 *
 * Mirrors `pages/pickup/OrderDetail.tsx`'s structure (PageHeader +
 * DetailField grid + Table + ConfirmDialog) and reuses `./index.tsx`'s
 * document-status -> StatusChip tone mapping.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  FileDropZone,
  PageHeader,
  RowActions,
  Select,
  Spinner,
  StatusChip,
  Table,
  Textarea,
} from "@markiro/ui";
import type { SelectOption, StatusChipStatus, TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY, formatSsccHri } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { formatCreatedAt } from "../../lib/datetime.js";
import { toast } from "../../lib/toast.js";
import {
  useAddLines,
  useApplyDocument,
  useCancelDocument,
  useDisaggregationReasons,
  useDocument,
  useImportLines,
  useRemoveLine,
  useUpdateDocument,
  type DocumentDetailDto,
  type LineDto,
} from "./api.js";

// See `./index.tsx`'s `STATUS_TO_CHIP` doc comment for why "applied"/"cancelled"
// map to "ok"/"warn" rather than StatusChip's nonexistent "success" tone.
const STATUS_TO_CHIP: Record<DocumentDetailDto["status"], StatusChipStatus> = {
  draft: "neutral",
  applied: "ok",
  cancelled: "warn",
};

// Line-level statuses (`apps/api/src/modules/disaggregation/dto.ts`'s
// `LineDto.status`): "ok" is the only status that lets a line take part in
// an apply. "not_found"/"written_off" are hard failures (the box either
// never existed or is already gone) so they read as "error"; the rest are
// transient/soft blockers (still closing, still open, already handled
// elsewhere) so they read as "warn".
const LINE_STATUS_TO_CHIP: Record<string, StatusChipStatus> = {
  ok: "ok",
  not_found: "error",
  written_off: "error",
  not_closed: "warn",
  shift_open: "warn",
  already_disassembled: "warn",
  duplicate: "warn",
};

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>{label}</span>
      <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>{value}</span>
    </div>
  );
}

function formatSscc(line: LineDto): string {
  if (!line.sscc) return line.ssccInput;
  try {
    return formatSsccHri(line.sscc);
  } catch {
    return line.ssccInput;
  }
}

function splitSsccInput(raw: string): string[] {
  return raw
    .split(/[\s;,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Draft-only header block: reason select + comment textarea, both saved via `useUpdateDocument`. */
function EditableHeader({ doc }: { doc: DocumentDetailDto }) {
  const { t } = useTranslation();
  const updateMutation = useUpdateDocument(doc.id);
  const { data: reasonsData } = useDisaggregationReasons();
  const reasons = reasonsData ?? [];
  const [comment, setComment] = useState(doc.comment ?? "");

  const reasonOptions: SelectOption[] = [
    { value: "", label: t("pages.disaggregation.detail.reasonPlaceholder") },
    ...reasons.map((reason) => ({ value: reason.id, label: reason.name })),
  ];

  const handleReasonChange = (value: string) => {
    updateMutation.mutate(
      { reasonId: value.length > 0 ? value : null },
      {
        onError: () => toast("error", t("pages.disaggregation.detail.updateError")),
      },
    );
  };

  const handleCommentBlur = () => {
    if (comment === (doc.comment ?? "")) return;
    updateMutation.mutate(
      { comment: comment.length > 0 ? comment : null },
      {
        onError: () => toast("error", t("pages.disaggregation.detail.updateError")),
      },
    );
  };

  return (
    <Card>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <Select
          label={t("pages.disaggregation.detail.reasonLabel")}
          options={reasonOptions}
          value={doc.reasonId ?? ""}
          onValueChange={handleReasonChange}
        />
        <Textarea
          label={t("pages.disaggregation.detail.commentLabel")}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onBlur={handleCommentBlur}
        />
      </div>
    </Card>
  );
}

function ReadOnlyHeader({ doc, language }: { doc: DocumentDetailDto; language: string }) {
  const { t } = useTranslation();
  return (
    <Card>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 16,
        }}
      >
        <DetailField
          label={t("pages.disaggregation.detail.reasonLabel")}
          value={doc.reasonName ?? t("pages.disaggregation.detail.noReason")}
        />
        <DetailField
          label={t("pages.disaggregation.detail.commentLabel")}
          value={doc.comment ?? t("pages.disaggregation.detail.noComment")}
        />
        <DetailField
          label={t("pages.disaggregation.detail.createdAtLabel")}
          value={formatCreatedAt(doc.createdAt, language)}
        />
        {doc.status === "applied" ? (
          <DetailField
            label={t("pages.disaggregation.detail.appliedAtLabel")}
            value={doc.appliedAt ? formatCreatedAt(doc.appliedAt, language) : "—"}
          />
        ) : null}
        {doc.status === "cancelled" ? (
          <DetailField
            label={t("pages.disaggregation.detail.cancelledAtLabel")}
            value={doc.cancelledAt ? formatCreatedAt(doc.cancelledAt, language) : "—"}
          />
        ) : null}
      </div>
    </Card>
  );
}

/** Draft-only add-lines panel: paste/scan SSCCs or import a file. */
function AddLinesPanel({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const addLinesMutation = useAddLines(docId);
  const importMutation = useImportLines(docId);
  const [pasteValue, setPasteValue] = useState("");

  const handleAddLines = async () => {
    const ssccs = splitSsccInput(pasteValue);
    if (ssccs.length === 0) return;
    try {
      await addLinesMutation.mutateAsync(ssccs);
      setPasteValue("");
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.disaggregation.detail.addLinesError"),
      );
    }
  };

  const handleFile = async (file: File) => {
    try {
      await importMutation.mutateAsync(file);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.disaggregation.detail.importError"),
      );
    }
  };

  return (
    <Card title={t("pages.disaggregation.detail.addPanelTitle")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Textarea
          label={t("pages.disaggregation.detail.addLinesInputLabel")}
          placeholder={t("pages.disaggregation.detail.addLinesPlaceholder")}
          value={pasteValue}
          onChange={(event) => setPasteValue(event.target.value)}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <Button
            type="button"
            loading={addLinesMutation.isPending}
            disabled={splitSsccInput(pasteValue).length === 0}
            onClick={() => void handleAddLines()}
          >
            {t("pages.disaggregation.detail.addLines")}
          </Button>
          <FileDropZone
            compact
            accept=".txt,.csv"
            label={t("pages.disaggregation.detail.dropLabel")}
            ariaLabel={t("pages.disaggregation.detail.importAction")}
            disabled={importMutation.isPending}
            onFile={(file) => void handleFile(file)}
          />
        </div>
      </div>
    </Card>
  );
}

function DeleteLineAction({ docId, line }: { docId: string; line: LineDto }) {
  const { t } = useTranslation();
  const removeMutation = useRemoveLine(docId);

  const handleDelete = async () => {
    try {
      await removeMutation.mutateAsync(line.id);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.disaggregation.detail.deleteLineError"),
      );
    }
  };

  return (
    <RowActions>
      <Button
        type="button"
        size="compact"
        variant="destructive"
        aria-label={t("pages.disaggregation.detail.deleteLineNamed", { sscc: formatSscc(line) })}
        loading={removeMutation.isPending}
        onClick={() => void handleDelete()}
      >
        {t("pages.disaggregation.detail.deleteLine")}
      </Button>
    </RowActions>
  );
}

/** Draft-only footer: apply (confirm) and cancel-document (confirm) actions. */
function DraftActions({ doc }: { doc: DocumentDetailDto }) {
  const { t } = useTranslation();
  const applyMutation = useApplyDocument(doc.id);
  const cancelMutation = useCancelDocument(doc.id);
  const [confirmApply, setConfirmApply] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [applyBlocked, setApplyBlocked] = useState(false);

  const canApply =
    doc.lines.length > 0 &&
    doc.lines.every((line) => line.status === "ok") &&
    Boolean(doc.reasonId);

  const handleApply = async () => {
    try {
      await applyMutation.mutateAsync();
      toast("ok", t("pages.disaggregation.detail.applySuccess"));
      setConfirmApply(false);
      setApplyBlocked(false);
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.status === 409 &&
        error.code === "invalid_lines"
      ) {
        setApplyBlocked(true);
        setConfirmApply(false);
        return;
      }
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.disaggregation.detail.applyError"),
      );
    }
  };

  const handleCancel = async () => {
    try {
      await cancelMutation.mutateAsync();
      toast("ok", t("pages.disaggregation.detail.cancelSuccess"));
      setConfirmCancel(false);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.disaggregation.detail.cancelError"),
      );
    }
  };

  return (
    <>
      {applyBlocked ? (
        <Alert tone="error">{t("pages.disaggregation.detail.applyBlocked")}</Alert>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Button type="button" disabled={!canApply} onClick={() => setConfirmApply(true)}>
          {t("pages.disaggregation.detail.applyAction")}
        </Button>
        <Button type="button" variant="destructive" onClick={() => setConfirmCancel(true)}>
          {t("pages.disaggregation.detail.cancelDocumentAction")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmApply}
        title={t("pages.disaggregation.detail.applyConfirmTitle")}
        description={t("pages.disaggregation.detail.applyConfirm", {
          boxes: doc.lineCount,
          codes: doc.codeCount,
        })}
        confirmLabel={t("pages.disaggregation.detail.applyConfirmAction")}
        cancelLabel={t("pages.disaggregation.detail.dismissAction")}
        busy={applyMutation.isPending}
        onConfirm={() => void handleApply()}
        onCancel={() => setConfirmApply(false)}
      />
      <ConfirmDialog
        open={confirmCancel}
        title={t("pages.disaggregation.detail.cancelConfirmTitle")}
        description={t("pages.disaggregation.detail.cancelConfirmBody")}
        tone="destructive"
        confirmLabel={t("pages.disaggregation.detail.cancelConfirmAction")}
        cancelLabel={t("pages.disaggregation.detail.dismissAction")}
        busy={cancelMutation.isPending}
        onConfirm={() => void handleCancel()}
        onCancel={() => setConfirmCancel(false)}
      />
    </>
  );
}

/**
 * Admin disaggregation document detail/editor -- Plan I-1 Task 10. Draft
 * documents are editable end to end (header, lines, apply/cancel); applied
 * and cancelled documents render the same layout read-only. All mutation
 * controls are additionally gated on `OPERATIONS_WRITE`.
 */
export function DisaggregationDocumentPage() {
  const { t, i18n } = useTranslation();
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const { id } = useParams();
  const docId = id ?? "";

  const { data: doc, isPending, isError } = useDocument(docId);

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !doc) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("pages.disaggregation.detail.loadError")}</Alert>
      </div>
    );
  }

  const isDraft = doc.status === "draft";

  const columns: TableColumn<LineDto>[] = [
    {
      key: "sscc",
      title: t("pages.disaggregation.detail.table.sscc"),
      mono: true,
      render: (line) =>
        doc.status === "applied" && line.boxId ? (
          <Link to={`/codes/box/${line.boxId}`}>{formatSscc(line)}</Link>
        ) : (
          formatSscc(line)
        ),
    },
    {
      key: "productName",
      title: t("pages.disaggregation.detail.table.productName"),
      render: (line) => line.productName ?? "—",
    },
    {
      key: "codeCount",
      title: t("pages.disaggregation.detail.table.codeCount"),
      align: "right",
      mono: true,
    },
    {
      key: "status",
      title: t("pages.disaggregation.detail.table.status"),
      render: (line) => (
        <StatusChip
          status={LINE_STATUS_TO_CHIP[line.status] ?? "neutral"}
          label={t(`pages.disaggregation.lineStatus.${line.status}`)}
        />
      ),
    },
    ...(isDraft && canWrite
      ? [
          {
            key: "actions",
            title: t("pages.disaggregation.detail.table.actions"),
            render: (line: LineDto) => <DeleteLineAction docId={doc.id} line={line} />,
          },
        ]
      : []),
  ];

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <Link
        to="/disaggregation"
        style={{ font: "var(--text-body)", color: "var(--fg-3)", textDecoration: "none" }}
      >
        {t("pages.disaggregation.detail.backAction")}
      </Link>

      <PageHeader
        title={doc.docNo}
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                window.open(`/api/disaggregation/${doc.id}/report?variant=boxes`);
              }}
            >
              {t("pages.disaggregation.detail.printBoxes")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                window.open(`/api/disaggregation/${doc.id}/report?variant=full`);
              }}
            >
              {t("pages.disaggregation.detail.printFull")}
            </Button>
            <StatusChip
              status={STATUS_TO_CHIP[doc.status]}
              label={t(`pages.disaggregation.status.${doc.status}`)}
            />
          </div>
        }
      />

      {isDraft && canWrite ? (
        <EditableHeader doc={doc} />
      ) : (
        <ReadOnlyHeader doc={doc} language={i18n.language} />
      )}

      {isDraft && canWrite ? <AddLinesPanel docId={doc.id} /> : null}

      <Card title={t("pages.disaggregation.detail.linesTitle")}>
        <Table
          columns={columns}
          rows={doc.lines}
          empty={t("pages.disaggregation.detail.linesEmpty")}
        />
      </Card>

      {isDraft && canWrite ? <DraftActions doc={doc} /> : null}
    </div>
  );
}
