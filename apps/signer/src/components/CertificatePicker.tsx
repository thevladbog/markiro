import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Spinner } from "@markiro/ui";
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

/** The agent can only sign with a certificate whose private key is present in
 *  the store; a certificate without one is listed by CryptoAPI but useless
 *  here. Both the initial load and the refresh button must apply this filter
 *  through this one function, or pressing refresh makes unusable
 *  certificates reappear. */
function usableCertificates(list: CertificateSummary[]): CertificateSummary[] {
  return list.filter((c) => c.hasPrivateKey);
}

export function CertificatePicker({
  selected,
  onSelected,
}: {
  selected: string | null;
  onSelected: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [certificates, setCertificates] = useState<CertificateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }),
    [i18n.language],
  );

  useEffect(() => {
    let disposed = false;
    bridge
      .listCertificates()
      .then((list) => {
        if (!disposed) setCertificates(usableCertificates(list));
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
    <div className="signer-certificate">
      {warning ? (
        <Alert tone={warning === "expired" ? "error" : "warn"}>
          {t(`certificates.${warning}`, {
            at: new Date(chosen?.notAfter ?? "").toLocaleDateString(),
          })}
        </Alert>
      ) : null}
      <fieldset className="signer-certificate__fieldset">
        <legend className="signer-certificate__legend">{t("certificates.label")}</legend>
        <div className="signer-certificate__options">
          {certificates.map((certificate) => (
            <label
              key={certificate.thumbprint}
              className="signer-certificate__option"
              data-selected={certificate.thumbprint === selected}
            >
              <input
                type="radio"
                name="signer-certificate"
                value={certificate.thumbprint}
                checked={certificate.thumbprint === selected}
                onChange={() =>
                  void bridge.selectCertificate(certificate.thumbprint).then(onSelected)
                }
              />
              <span className="signer-certificate__details">
                <strong className="signer-certificate__subject">{certificate.subject}</strong>
                <span className="signer-certificate__meta">
                  <span>
                    {t("certificates.validUntil", {
                      at: dateFormatter.format(new Date(certificate.notAfter)),
                    })}
                  </span>
                  {certificate.inn ? (
                    <span>{t("certificates.inn", { inn: certificate.inn })}</span>
                  ) : null}
                  <span className="signer-certificate__thumbprint">
                    {t("certificates.thumbprint", { thumbprint: certificate.thumbprint })}
                  </span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Button
          onClick={() =>
            void bridge.listCertificates().then((list) => setCertificates(usableCertificates(list)))
          }
        >
          {t("certificates.refresh")}
        </Button>
      </div>
    </div>
  );
}
