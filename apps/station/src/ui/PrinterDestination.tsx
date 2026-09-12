import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Select } from "@markiro/ui";
import type { PrinterProfile, PrintPurpose } from "../lib/printer-routing.js";
import { readPrintDestination, type PrintDestinationKey } from "../lib/print-destinations.js";
import type { SqlExecutor } from "../lib/mirror.js";
import "./printer-destination.css";

export interface PrinterDestinationProps {
  purpose: PrintPurpose;
  printer: PrinterProfile | null;
  printers: PrinterProfile[];
  disabled?: boolean;
  onChoose?: (printer: PrinterProfile) => Promise<void>;
}

/** A deliberate per-label choice. Assignment edits never change this saved destination. */
export function PrinterDestination({
  purpose,
  printer,
  printers,
  disabled = false,
  onChoose,
}: PrinterDestinationProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <section className="printer-destination" aria-label={t("printerRouting.destination")}>
      <p>
        <span>{t(`setup.printPurpose.${purpose}`)} · </span>
        <strong>{printer?.name ?? t("printerRouting.legacyDestination")}</strong>
      </p>
      {error ? <Alert tone="error" title={t("printerRouting.changeFailed")} /> : null}
      {onChoose && !editing ? (
        <Button
          size="floor"
          variant="secondary"
          disabled={disabled || !printers.length}
          onClick={() => {
            setEditing(true);
            setSelected("");
          }}
        >
          {t("printerRouting.changePrinter")}
        </Button>
      ) : null}
      {onChoose && editing ? (
        <div className="printer-destination__editor">
          <Select
            size="floor"
            label={t("printerRouting.selectPrinter")}
            value={selected}
            disabled={disabled || busy}
            options={[
              { value: "", label: t("printerRouting.selectPrinter") },
              ...printers.map((item) => ({ value: item.id, label: item.name })),
            ]}
            onValueChange={setSelected}
          />
          <div className="printer-destination__actions">
            <Button
              size="floor"
              disabled={!selected || disabled || busy}
              onClick={() => {
                const next = printers.find((item) => item.id === selected);
                if (!next) return;
                setBusy(true);
                setError(false);
                void onChoose(next)
                  .then(() => setEditing(false))
                  .catch(() => setError(true))
                  .finally(() => setBusy(false));
              }}
            >
              {t("printerRouting.useForLabel")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t("printerRouting.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SavedPrinterDestination({
  exec,
  destination,
  revision = 0,
  ...props
}: Omit<PrinterDestinationProps, "printer" | "purpose"> & {
  exec: SqlExecutor;
  destination: PrintDestinationKey;
  revision?: number | string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    key: string;
    printer: PrinterProfile | null;
    error: boolean;
  } | null>(null);
  const key = JSON.stringify(destination);
  useEffect(() => {
    let active = true;
    void readPrintDestination(exec, {
      scope: destination.scope,
      purpose: destination.purpose,
      jobId: destination.jobId,
      attemptId: destination.attemptId,
    })
      .then((printer) => {
        if (active) setState({ key, printer, error: false });
      })
      .catch(() => {
        if (active) setState({ key, printer: null, error: true });
      });
    return () => {
      active = false;
    };
  }, [
    exec,
    key,
    destination.scope,
    destination.purpose,
    destination.jobId,
    destination.attemptId,
    revision,
  ]);
  if (state?.key !== key) return <p role="status">{t("printerRouting.loading")}</p>;
  if (state.error) return <Alert tone="error" title={t("printerRouting.changeFailed")} />;
  return <PrinterDestination {...props} purpose={destination.purpose} printer={state.printer} />;
}
