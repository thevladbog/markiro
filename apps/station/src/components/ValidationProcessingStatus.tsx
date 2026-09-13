import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@markiro/ui";
import type { SqlExecutor } from "../lib/mirror.js";
import { readValidationProcessingState } from "../lib/validation-reprocessing.js";

export function ValidationProcessingStatus({
  exec,
  shiftId,
  refreshKey,
  onState,
}: {
  exec: SqlExecutor;
  shiftId: string;
  refreshKey: number;
  onState: (state: Awaited<ReturnType<typeof readValidationProcessingState>>) => void;
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<Awaited<
    ReturnType<typeof readValidationProcessingState>
  > | null>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const next = await readValidationProcessingState(exec, shiftId);
        const [policy] = await exec.all<{ enabled: number }>(
          "SELECT COALESCE(json_extract(validation_print_context,'$.policy.allowPreviouslyAcceptedCodes'),0) AS enabled FROM shift_mirror WHERE id=?",
          [shiftId],
        );
        if (current) {
          setState(next);
          onState(next);
          setEnabled(policy?.enabled === 1);
        }
      } catch {
        if (current) setState(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [exec, shiftId, refreshKey, onState]);
  return (
    <div role="status" aria-live="polite" data-testid="validation-processing-status">
      <p>
        {t(enabled ? "productLabels.reprocessingEnabled" : "productLabels.reprocessingDisabled")}
      </p>
      <p>
        {state?.fetchedAt
          ? t("productLabels.historyChecked", {
              date: new Date(state.fetchedAt).toLocaleString(i18n.language),
            })
          : t("productLabels.historyUnknown")}
      </p>
      {state ? (
        <p>
          {t("productLabels.processed", { count: state.processed })} ·{" "}
          {t("productLabels.processingPending", { count: state.pending })}
        </p>
      ) : null}
      {state && state.conflicts > 0 ? (
        <Alert tone="error">
          {t("productLabels.processingConflicts", { count: state.conflicts })}
        </Alert>
      ) : null}
    </div>
  );
}
