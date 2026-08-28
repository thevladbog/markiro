import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Select, Spinner } from "@markiro/ui";
import { bridge, type CertificateSummary } from "../lib/bridge.js";

const EXPIRY_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** A UKEP that lapses silently stops every refresh, so the window flags it two
 *  weeks ahead — long enough for the customer to reissue the certificate. */
export function expiryWarning(
  notAfter: string,
  now: Date = new Date(),
): "expired" | "expiring" | null {
  const remaining = new Date(notAfter).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) return "expired";
  return remaining <= EXPIRY_WARNING_WINDOW_MS ? "expiring" : null;
}

export function CertificatePicker({
  selected,
  onSelected,
}: {
  selected: string | null;
  onSelected: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [certificates, setCertificates] = useState<CertificateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    bridge
      .listCertificates()
      .then((list) => {
        if (!disposed) setCertificates(list.filter((c) => c.hasPrivateKey));
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);

  if (error) return <Alert tone="error">{t("certificates.unavailable")}</Alert>;
  if (!certificates) return <Spinner label={t("certificates.loading")} />;
  if (certificates.length === 0) return <Alert tone="warn">{t("certificates.empty")}</Alert>;

  const chosen = certificates.find((certificate) => certificate.thumbprint === selected);
  const warning = chosen ? expiryWarning(chosen.notAfter) : null;

  return (
    <div>
      {warning ? (
        <Alert tone={warning === "expired" ? "error" : "warn"}>
          {t(`certificates.${warning}`, {
            at: new Date(chosen?.notAfter ?? "").toLocaleDateString(),
          })}
        </Alert>
      ) : null}
      <Select
        label={t("certificates.label")}
        value={selected ?? ""}
        onValueChange={(thumbprint) => {
          if (thumbprint) void bridge.selectCertificate(thumbprint).then(onSelected);
        }}
        options={certificates.map((certificate) => ({
          value: certificate.thumbprint,
          label: `${certificate.subject} · ${new Date(certificate.notAfter).toLocaleDateString()}`,
        }))}
      />
      <Button onClick={() => void bridge.listCertificates().then(setCertificates)}>
        {t("certificates.refresh")}
      </Button>
    </div>
  );
}
