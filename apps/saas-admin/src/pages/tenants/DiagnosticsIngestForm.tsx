import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Textarea } from "@markiro/ui";
import type { StandaloneDiagnosticsIngestResponse } from "@markiro/platform-contracts";

import { diagnosticsKey, ingestDiagnostics } from "./diagnostics-api.js";
import { diagnosticsErrorCode, diagnosticsErrorKey } from "./diagnostics-format.js";
import { useUnsavedChanges } from "./useUnsavedChanges.js";

const UNBOUND = "standalone_diagnostics_host_unbound";

/**
 * Paste of the whole «Сведения для поддержки» text (spec 3.7, block 2). The text lives only in this
 * component's state: it is cleared on success, never put in a message, a URL or a key.
 */
export function DiagnosticsIngestForm({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<StandaloneDiagnosticsIngestResponse | null>(null);
  const ingest = useMutation({
    mutationFn: (acknowledgeUnboundHost: boolean) =>
      ingestDiagnostics(tenantId, {
        text,
        ...(acknowledgeUnboundHost ? { acknowledgeUnboundHost } : {}),
      }),
    onSuccess: async (response) => {
      setText("");
      setSaved(response);
      await queryClient.invalidateQueries({ queryKey: diagnosticsKey(tenantId) });
    },
  });
  useUnsavedChanges(text.trim() !== "", ingest.isPending);
  const prefix = "tenants.detail.diagnostics.ingest";
  const unbound = ingest.isError && diagnosticsErrorCode(ingest.error) === UNBOUND;
  const submit = (acknowledge: boolean) => {
    setSaved(null);
    ingest.mutate(acknowledge);
  };
  return (
    <Card title={t(`${prefix}.title`)} titleAs="h3" className="diagnostics-ingest">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() !== "" && !ingest.isPending) submit(false);
        }}
      >
        <Textarea
          id={fieldId}
          label={t(`${prefix}.label`)}
          className="diagnostics-ingest__text mono"
          rows={6}
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            if (ingest.isError) ingest.reset();
          }}
        />
        <p className="diagnostics-ingest__counter" aria-live="polite">
          {t(`${prefix}.counter`, { n: text.length })}
        </p>
        <Button type="submit" disabled={text.trim() === "" || ingest.isPending}>
          {t(`${prefix}.submit`)}
        </Button>
      </form>
      {unbound ? (
        <Alert
          tone="warn"
          action={
            <Button variant="secondary" disabled={ingest.isPending} onClick={() => submit(true)}>
              {t(`${prefix}.confirmUnboundAction`)}
            </Button>
          }
        >
          {t(`${prefix}.confirmUnbound`)}
        </Alert>
      ) : ingest.isError ? (
        <Alert tone="error">{t(diagnosticsErrorKey(ingest.error))}</Alert>
      ) : saved ? (
        <p role="status" className="diagnostics-ingest__saved">
          {saved.duplicate
            ? t(`${prefix}.duplicate`)
            : t(`${prefix}.saved`, {
                host:
                  saved.diagnostic.hostKey === "unknown"
                    ? "—"
                    : saved.diagnostic.hostKey.slice(0, 8),
                version: saved.diagnostic.appVersion ?? "—",
                n: saved.monthsApplied,
              })}
        </p>
      ) : null}
    </Card>
  );
}
