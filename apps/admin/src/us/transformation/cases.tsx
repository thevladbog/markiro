import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@markiro/ui";
import { parseScannedSscc } from "@markiro/domain";
import type { CaseListResult, CaseRow } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";

type Intent =
  | { kind: "link"; operationKey: string; sscc: string }
  | { kind: "unlink"; operationKey: string; linkId: string; reason: string };

type Props = {
  client: UsBrowserClient;
  lotId: string;
  evidenceVersion?: string;
  canWrite: boolean;
  disabled?: boolean;
  timeZone: string;
  beginMutation?: () => () => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  onProtectedChange?: (protectedState: boolean) => void;
};

export function LotCasesPanel({
  client,
  lotId,
  evidenceVersion = "",
  canWrite,
  disabled = false,
  timeZone,
  beginMutation,
  onForbidden,
  onSessionLost,
  onProtectedChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState<CaseListResult | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [readFailure, setReadFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sscc, setSscc] = useState("");
  const [inputError, setInputError] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<Pick<CaseRow, "linkId" | "ssccAtLink"> | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const intent = useRef<Intent | null>(null);
  const readRun = useRef(0);
  const protectedState = Boolean(intent.current || sscc || reason || unlinkTarget);
  const fresh = loadedVersion === evidenceVersion && !loading && !loadFailure;

  useEffect(() => {
    if (canWrite) return;
    // Drop unsubmitted edits on access loss; an uncertain command remains in intent for exact-key retry.
    setSscc("");
    setInputError(false);
    setUnlinkTarget(null);
    setReason("");
  }, [canWrite]);

  useEffect(() => {
    onProtectedChange?.(protectedState);
  }, [onProtectedChange, protectedState]);
  useEffect(() => () => onProtectedChange?.(false), [onProtectedChange]);

  async function auth(error: unknown) {
    if (!(error instanceof UsClientError)) return;
    if (error.code === "session_required") onSessionLost();
    if (error.code === "forbidden") await onForbidden();
  }

  async function load() {
    const run = ++readRun.current;
    setLoading(true);
    setLoadFailure(false);
    try {
      const next = await client.listLotCases(lotId, {
        limit: 50,
        history: String(history),
        ...(cursors[page] ? { cursor: cursors[page] } : {}),
      });
      if (run !== readRun.current) return;
      setValue(next);
      setLoadedVersion(evidenceVersion);
      setConflict(false);
      setReadFailure(false);
    } catch (error) {
      if (run !== readRun.current) return;
      setLoadFailure(true);
      await auth(error);
    } finally {
      if (run === readRun.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => {
      readRun.current += 1;
    };
    // load reads the current bounded page; changes to that page trigger a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, lotId, evidenceVersion, history, page, cursors, onForbidden, onSessionLost]);

  async function runCommand(command: Intent) {
    if (busy || disabled || !canWrite) return;
    if (command.kind === "link" && !uncertain && (!fresh || value?.originState !== "current"))
      return;
    intent.current = command;
    setBusy(true);
    setConflict(false);
    setUncertain(false);
    const release = beginMutation?.();
    try {
      if (command.kind === "link")
        await client.linkLotCases(lotId, {
          operationKey: command.operationKey,
          ssccs: [command.sscc],
        });
      else
        await client.unlinkLotCase(lotId, command.linkId, {
          operationKey: command.operationKey,
          reason: command.reason,
        });
      intent.current = null;
      setSscc("");
      setInputError(false);
      setUnlinkTarget(null);
      setReason("");
      setPage(0);
      setCursors([undefined]);
      try {
        const next = await client.listLotCases(lotId, { limit: 50, history: String(history) });
        setValue(next);
        setLoadedVersion(evidenceVersion);
        setReadFailure(false);
      } catch (error) {
        setReadFailure(true);
        await auth(error);
      }
    } catch (error) {
      await auth(error);
      if (
        error instanceof UsClientError &&
        (error.code === "case_link_stale" ||
          error.code === "case_link_conflict" ||
          error.code === "case_origin_not_current" ||
          error.code === "case_disassembled" ||
          error.code === "case_sscc_inconsistent" ||
          error.code === "case_operation_conflict" ||
          error.code === "case_not_found" ||
          error.code === "case_link_not_found" ||
          error.code === "invalid_input")
      ) {
        intent.current = null;
        if (error.code === "invalid_input") setInputError(true);
        else setConflict(true);
      } else {
        setUncertain(true);
      }
    } finally {
      release?.();
      setBusy(false);
    }
  }

  function showHistory(next: boolean) {
    if (intent.current || busy || unlinkTarget) return;
    setHistory(next);
    setPage(0);
    setCursors([undefined]);
  }

  function date(value: string) {
    return new Intl.DateTimeFormat(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  }

  function rowView(row: CaseRow) {
    return (
      <li key={row.linkId} className="us-tr-case-row">
        <strong className="us-tr-mono">{row.ssccAtLink}</strong>
        <span>{t(`transformation.cases.${row.provenance}`)}</span>
        <span>{t(`transformation.cases.${row.linkSource}`)}</span>
        <span>
          {t("transformation.cases.linkedBy", { actor: row.linkedBy, at: date(row.linkedAt) })}
        </span>
        {row.ssccState === "inconsistent" ? (
          <span>{t("transformation.cases.inconsistent")}</span>
        ) : null}
        {row.unlinkedAt ? (
          <span>
            {t("transformation.cases.unlinkedBy", {
              actor: row.unlinkedBy,
              at: date(row.unlinkedAt),
              reason: row.unlinkReason,
            })}
          </span>
        ) : canWrite && !disabled && !conflict && !uncertain && !readFailure && !unlinkTarget ? (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={busy}
            onClick={() => {
              setUnlinkTarget({ linkId: row.linkId, ssccAtLink: row.ssccAtLink });
              setReason("");
            }}
          >
            {t("transformation.cases.unlink", { sscc: row.ssccAtLink })}
          </Button>
        ) : null}
      </li>
    );
  }

  return (
    <section
      className="us-tr-section"
      aria-label={t("transformation.cases.title")}
      aria-busy={loading || busy}
    >
      <h2>{t("transformation.cases.title")}</h2>
      <p className="us-tr-hint">{t("transformation.cases.separate")}</p>
      {loading && !value ? <p role="status">{t("transformation.cases.loading")}</p> : null}
      {loadFailure ? <p role="alert">{t("transformation.cases.loadFailed")}</p> : null}
      {value ? (
        <>
          <p role="status">{t("transformation.cases.count", { count: value.activeCount })}</p>
          {value.originState === "gap" ? (
            <p role="alert">{t("transformation.cases.originGap")}</p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={busy || uncertain || Boolean(unlinkTarget)}
            onClick={() => showHistory(!history)}
          >
            {t(history ? "transformation.cases.showActive" : "transformation.cases.showHistory")}
          </Button>
          {value.rows.length ? (
            <ul className="us-tr-case-list">{value.rows.map(rowView)}</ul>
          ) : (
            <p>{t(history ? "transformation.cases.noHistory" : "transformation.cases.noActive")}</p>
          )}
          {page > 0 || value.nextCursor ? (
            <div className="us-tr-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={page === 0 || loading || busy || Boolean(unlinkTarget)}
                onClick={() => {
                  if (!unlinkTarget) setPage(page - 1);
                }}
              >
                {t("md.previousPage")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!value.nextCursor || loading || busy || Boolean(unlinkTarget)}
                onClick={() => {
                  if (value.nextCursor && !unlinkTarget) {
                    setCursors([...cursors, value.nextCursor]);
                    setPage(page + 1);
                  }
                }}
              >
                {t("md.nextPage")}
              </Button>
            </div>
          ) : null}
          {canWrite &&
          value.originState === "current" &&
          fresh &&
          !disabled &&
          !conflict &&
          !uncertain &&
          !readFailure ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const normalized = parseScannedSscc(sscc.trim());
                if (!normalized) {
                  setInputError(true);
                  return;
                }
                void runCommand({
                  kind: "link",
                  operationKey: crypto.randomUUID(),
                  sscc: normalized,
                });
              }}
            >
              <Input
                label={t("transformation.cases.sscc")}
                value={sscc}
                onChange={(event) => {
                  setSscc(event.target.value);
                  setInputError(false);
                }}
                disabled={busy}
              />
              {inputError ? <p role="alert">{t("transformation.cases.invalidSscc")}</p> : null}
              <Button type="submit" disabled={busy || !sscc.trim()}>
                {t("transformation.cases.link")}
              </Button>
            </form>
          ) : null}
          {unlinkTarget && canWrite && !disabled && !uncertain && !conflict && !readFailure ? (
            <div className="us-tr-actions">
              <p className="us-tr-mono">
                {t("transformation.cases.unlinkTarget", {
                  sscc: unlinkTarget.ssccAtLink,
                  linkId: unlinkTarget.linkId,
                })}
              </p>
              <Input
                label={t("transformation.cases.reason")}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy || disabled || !canWrite}
              />
              <Button
                type="button"
                disabled={busy || disabled || !canWrite || reason.trim().length < 3}
                onClick={() =>
                  void runCommand({
                    kind: "unlink",
                    operationKey: crypto.randomUUID(),
                    linkId: unlinkTarget.linkId,
                    reason: reason.trim(),
                  })
                }
              >
                {t("transformation.cases.confirmUnlink")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setUnlinkTarget(null);
                  setReason("");
                }}
              >
                {t("transformation.cancel")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {conflict ? <p role="alert">{t("transformation.cases.conflict")}</p> : null}
      {uncertain ? <p role="alert">{t("transformation.cases.uncertain")}</p> : null}
      {readFailure ? <p role="alert">{t("transformation.cases.readFailed")}</p> : null}
      {uncertain && intent.current ? (
        <Button
          type="button"
          disabled={busy || disabled || !canWrite}
          onClick={() => {
            if (intent.current) void runCommand(intent.current);
          }}
        >
          {t("transformation.retrySame")}
        </Button>
      ) : null}
      {loadFailure || conflict || readFailure || uncertain ? (
        <Button
          type="button"
          variant="secondary"
          disabled={busy || loading}
          onClick={() => {
            if (uncertain && !window.confirm(t("transformation.abandonConfirm"))) return;
            intent.current = null;
            setUncertain(false);
            setSscc("");
            setInputError(false);
            setUnlinkTarget(null);
            setReason("");
            void load();
          }}
        >
          {t("transformation.cases.reload")}
        </Button>
      ) : null}
    </section>
  );
}
