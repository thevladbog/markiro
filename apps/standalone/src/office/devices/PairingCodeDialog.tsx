import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  DefinitionGrid,
  Modal,
  Spinner,
  VisuallyHidden,
  type DefinitionGridItem,
} from "@markiro/ui";

import { formatFingerprint } from "../../app/fingerprint.js";
import { parsePairingPayload } from "../../host/pairing-code.js";
import type { PairingCode } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";

const PairingDataMatrix = lazy(() => import("./PairingDataMatrix.js"));

/** How often the device list is read while a code is shown. */
export const DEVICE_POLL_MS = 3000;

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Milliseconds until `deadline`, ticking every second (after the admin's
 * pairing panel). `deadline` is this PC's own clock reading
 * (`receivedAt + CODE_LIFETIME_MS`, set once in `DevicesPage` when the code
 * arrives), never the host's `expiresAt`: the office can run on a PC other
 * than the host, and a cloud-less LAN site cannot promise the two clocks
 * agree. Comparing the host's timestamp against this PC's `Date.now()` would
 * make the countdown wrong by however far the clocks have drifted — showing
 * an already-expired fresh code, or a many-hours-long one.
 */
function useRemainingMs(deadline: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, deadline - now);
}

export interface PairingCodeDialogProps {
  code: PairingCode;
  /** When the code stops showing, by this PC's own clock; see `useRemainingMs`. */
  deadline: number;
  regenerating: boolean;
  /** Why a new code could not be created, as an i18n key. */
  failure: string | null;
  onRegenerate: () => void;
  onClose: () => void;
}

/**
 * A one-time pairing code (spec §4.7, §5.5): the DataMatrix for a scanner,
 * the code and the host's fingerprint and addresses for pairing by hand, and
 * the time left.
 */
export function PairingCodeDialog({
  code,
  deadline,
  regenerating,
  failure,
  onRegenerate,
  onClose,
}: PairingCodeDialogProps) {
  const { t } = useTranslation();
  // A claim does not raise the host revision, so no event announces the new
  // device: the list is read again every few seconds while the code shows.
  useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    refetchInterval: DEVICE_POLL_MS,
  });
  const remainingMs = useRemainingMs(deadline);
  const payload = parsePairingPayload(code.payload);
  const details: DefinitionGridItem[] = [];
  if (payload !== null) {
    details.push({
      id: "fingerprint",
      term: t("office.devices.pairing.fingerprint"),
      description: formatFingerprint(payload.fingerprint),
      mono: true,
    });
    if (payload.addresses.length > 0) {
      details.push({
        id: "addresses",
        term: t("office.devices.pairing.addresses"),
        description: payload.addresses.map((host) => `${host}:${payload.port}`).join(", "),
        mono: true,
      });
    }
  }

  return (
    <Modal
      open
      title={t("office.devices.pairing.title")}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <>
          <Button variant="secondary" loading={regenerating} onClick={onRegenerate}>
            {t("office.devices.pairing.regenerate")}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t("office.common.close")}
          </Button>
        </>
      }
    >
      <div className="standalone-form">
        {failure && <Alert tone="error">{t(failure)}</Alert>}
        {/* Announces a new code or its expiry; the countdown stays outside. */}
        <div className="standalone-form" aria-live="polite">
          {remainingMs === 0 ? (
            <Alert tone="warn">{t("office.devices.pairing.expired")}</Alert>
          ) : (
            <>
              <p>{t("office.devices.pairing.intro")}</p>
              <div className="pairing-code">
                <Suspense fallback={<Spinner label={t("office.devices.pairing.matrixLoading")} />}>
                  <PairingDataMatrix
                    payload={code.payload}
                    label={t("office.devices.pairing.matrixLabel")}
                  />
                </Suspense>
                <span className="pairing-code__digits" aria-hidden="true">
                  {`${code.code.slice(0, 5)} ${code.code.slice(5)}`}
                </span>
                <VisuallyHidden>{code.code}</VisuallyHidden>
              </div>
              {payload !== null && payload.addresses.length === 0 && (
                <Alert tone="warn">{t("office.devices.pairing.noAddresses")}</Alert>
              )}
              <DefinitionGrid items={details} />
            </>
          )}
        </div>
        {remainingMs > 0 && (
          <p className="office-note">
            {t("office.devices.pairing.expiresIn", { time: formatCountdown(remainingMs) })}
          </p>
        )}
        <p className="office-note">{t("office.devices.pairing.attempts")}</p>
      </div>
    </Modal>
  );
}
