import { useTranslation } from "react-i18next";
import { Button, Select } from "@markiro/ui";
import {
  PRINT_PURPOSES,
  type PrinterProfile,
  type PrinterRouting,
  type PrintPurpose,
} from "../../lib/printer-routing.js";

function printerConnectionLabel(printer: PrinterProfile): string {
  const target = printer.target;
  if (target.kind === "tcp") return `${target.host}:${target.port}`;
  if (target.kind === "serial") return `${target.port} · ${target.baud}`;
  return target.printer;
}

export function PrinterRoutingPanel({
  routing,
  disabled,
  onAdd,
  onEdit,
  onAssign,
}: {
  routing: PrinterRouting;
  disabled: boolean;
  onAdd: () => void;
  onEdit: (printer: PrinterProfile) => void;
  onAssign: (purpose: PrintPurpose, printerId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="setup-printer-routing" data-testid="printer-routing">
      <section className="setup-printer-list" aria-label={t("setup.savedPrinters")}>
        <div className="setup-printer-list__header">
          <h2 className="setup-card__title">
            {t("setup.savedPrinters")}{" "}
            <span className="setup-printer-list__count">{routing.printers.length}</span>
          </h2>
          <Button size="floor" variant="secondary" disabled={disabled} onClick={onAdd}>
            {t("setup.addPrinter")}
          </Button>
        </div>
        <div className="setup-printer-list__scroll" tabIndex={0}>
          {routing.printers.length === 0 ? (
            <p className="setup-printer-list__empty">{t("setup.printersEmpty")}</p>
          ) : (
            routing.printers.map((printer) => {
              const purposes = PRINT_PURPOSES.filter(
                (purpose) => routing.assignments[purpose] === printer.id,
              );
              return (
                <article className="setup-printer-row" key={printer.id}>
                  <div className="setup-printer-row__detail">
                    <h3>{printer.name}</h3>
                    <p className="setup-printer-row__connection">
                      {printerConnectionLabel(printer)} · {printer.language.toUpperCase()} ·{" "}
                      {printer.dpi === null
                        ? t("setup.printerResolutionUnknown")
                        : `${printer.dpi} dpi`}
                    </p>
                    <p className="setup-printer-row__purposes">
                      {purposes.length
                        ? purposes.map((purpose) => t(`setup.printPurpose.${purpose}`)).join(" · ")
                        : t("setup.printerUnassigned")}
                    </p>
                  </div>
                  <Button
                    size="floor"
                    variant="secondary"
                    aria-label={t("setup.editNamedPrinter", { name: printer.name })}
                    disabled={disabled}
                    onClick={() => onEdit(printer)}
                  >
                    {t("setup.editPrinter")}
                  </Button>
                </article>
              );
            })
          )}
        </div>
      </section>
      <section
        className="setup-card setup-printer-assignments"
        aria-label={t("setup.printerAssignments")}
      >
        <h2 className="setup-card__title">{t("setup.printerAssignments")}</h2>
        {PRINT_PURPOSES.map((purpose) => (
          <Select
            native
            size="floor"
            key={purpose}
            label={t(`setup.printPurpose.${purpose}`)}
            value={routing.assignments[purpose] ?? ""}
            disabled={disabled}
            options={[
              { value: "", label: t("setup.printerNotAssigned") },
              ...routing.printers.map((printer) => ({ value: printer.id, label: printer.name })),
            ]}
            onValueChange={(value) => onAssign(purpose, value || null)}
          />
        ))}
      </section>
    </div>
  );
}
