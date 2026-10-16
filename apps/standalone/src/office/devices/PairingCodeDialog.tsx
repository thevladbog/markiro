import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  DefinitionGrid,
  Modal,
  RadioGroup,
  Spinner,
  VisuallyHidden,
  type DefinitionGridItem,
} from "@markiro/ui";

import { formatFingerprint } from "../../app/fingerprint.js";
import { parsePairingPayload } from "../../host/pairing-code.js";
import type { PairingCode } from "../../host/protocol.js";
import { usePrintForm } from "../forms/form-printer-context.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { downloadFile } from "../templates/download.js";
import {
  pairingCardData,
  pairingCardHtml,
  pairingCardPdf,
  rasterizeCard,
  type CardRasterizer,
} from "./pairing-card.js";
import type { PairingCardFormat } from "@markiro/domain";

const PairingDataMatrix = lazy(() => import("./PairingDataMatrix.js"));

/** How often the device list is read while a code is shown. */
export const DEVICE_POLL_MS = 3000;

/**
 * How long a code lives, by the host's own clock: `expiresAt − createdAt`.
 * Only this duration crosses to this PC's clock (`DevicesPage` adds it to the
 * moment the code was requested); neither timestamp is ever compared with
 * this PC's `Date.now()`.
 */
export function codeLifetimeMs(code: Pick<PairingCode, "createdAt" | "expiresAt">): number {
  return Math.max(0, Date.parse(code.expiresAt) - Date.parse(code.createdAt));
}

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Milliseconds until `deadline`, ticking every second (after the admin's
 * pairing panel). `deadline` is this PC's own clock reading (`requestedAt +
 * lifetime`, captured in `DevicesPage` just before the request is sent, not
 * after it resolves), never the host's `expiresAt`: the office can run on a
 * PC other than the host, and a cloud-less LAN site cannot promise the two
 * clocks agree. Comparing the host's timestamp against this PC's
 * `Date.now()` would make the countdown wrong by however far the clocks have
 * drifted — showing an already-expired fresh code, or a many-hours-long one.
 * Clamped to `lifetime`: right after a fresh `deadline` arrives, this hook
 * can still be rendering with a `now` reading from the previous tick, up to
 * a second old, which would otherwise read as "10:01" for that one frame.
 */
function useRemainingMs(deadline: number, lifetime: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.min(deadline - now, lifetime));
}

export interface PairingCodeDialogProps {
  code: PairingCode;
  /** When the code stops showing, by this PC's own clock; see `useRemainingMs`. */
  deadline: number;
  regenerating: boolean;
  /** Why a new code could not be created, as an i18n key. */
  failure: string | null;
  /** The name of the device this code re-pairs; unset for a code of a new device. */
  repairFor?: string | undefined;
  onRegenerate: () => void;
  onClose: () => void;
  /** Draws the card for the PDF; the webview's canvas by default, a test's mock otherwise. */
  rasterize?: CardRasterizer;
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
  repairFor,
  onRegenerate,
  onClose,
  rasterize = rasterizeCard,
}: PairingCodeDialogProps) {
  const { t } = useTranslation();
  const print = usePrintForm();
  const [paper, setPaper] = useState<PairingCardFormat>("a4");
  const [cardFailure, setCardFailure] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A claim does not raise the host revision, so no event announces the new
  // device: the list is read again every few seconds while the code shows.
  // A re-pairing adds no device, so the list is not polled for it.
  useOfficeQuery(
    officeKeys.devices,
    (api, token) => api.listDevices(token),
    repairFor === undefined ? { refetchInterval: DEVICE_POLL_MS } : {},
  );
  const remainingMs = useRemainingMs(deadline, codeLifetimeMs(code));
  const payload = parsePairingPayload(code.payload);
  // The card is drawn when a button is pressed, from this code, and handed on
  // (the print frame, the downloaded file): the dialog keeps none of it. The
  // code is one-time and secret-like, so it is neither logged nor stored.
  const card = () => pairingCardData(code, deadline, codeLifetimeMs(code));
  const printCard = () => {
    const data = card();
    if (data === null) return;
    setCardFailure(null);
    try {
      print(pairingCardHtml(data, paper));
    } catch {
      setCardFailure("office.devices.pairing.card.printFailed");
    }
  };
  const downloadCard = async () => {
    const data = card();
    if (data === null || drawing) return;
    setCardFailure(null);
    setDrawing(true);
    try {
      downloadFile(
        await pairingCardPdf(data, paper, rasterize),
        `Подключение устройства ${paper.toUpperCase()}.pdf`,
      );
    } catch {
      if (alive.current) setCardFailure("office.devices.pairing.card.pdfFailed");
    } finally {
      if (alive.current) setDrawing(false);
    }
  };
  const expired = remainingMs === 0;
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
      title={
        repairFor === undefined
          ? t("office.devices.pairing.title")
          : t("office.devices.repair.title", { name: repairFor })
      }
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <>
          {payload !== null && !expired && (
            <>
              <Button variant="secondary" loading={drawing} onClick={() => void downloadCard()}>
                {t("office.devices.pairing.card.pdf")}
              </Button>
              <Button variant="secondary" onClick={printCard}>
                {t("office.devices.pairing.card.print")}
              </Button>
            </>
          )}
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
        {cardFailure && <Alert tone="error">{t(cardFailure)}</Alert>}
        {/* Announces a new code or its expiry; the countdown stays outside. */}
        <div className="standalone-form" aria-live="polite">
          {expired ? (
            <Alert tone="warn">{t("office.devices.pairing.expired")}</Alert>
          ) : (
            <>
              <p>
                {repairFor === undefined
                  ? t("office.devices.pairing.intro")
                  : t("office.devices.repair.intro")}
              </p>
              <div className="pairing-code">
                <Suspense fallback={<Spinner label={t("office.devices.pairing.matrixLoading")} />}>
                  <PairingDataMatrix
                    payload={code.payload}
                    label={t("office.devices.pairing.matrixLabel")}
                  />
                </Suspense>
                <div className="pairing-code__side">
                  <span className="pairing-code__label" aria-hidden="true">
                    {t("office.devices.pairing.codeLabel")}
                  </span>
                  <span className="pairing-code__digits" aria-hidden="true">
                    {`${code.code.slice(0, 5)} ${code.code.slice(5)}`}
                  </span>
                  <VisuallyHidden>{code.code}</VisuallyHidden>
                </div>
              </div>
              {payload !== null && payload.addresses.length === 0 && (
                <Alert tone="warn">{t("office.devices.pairing.noAddresses")}</Alert>
              )}
              <DefinitionGrid items={details} />
              {payload !== null && (
                <RadioGroup
                  label={t("office.devices.pairing.card.paper")}
                  name="pairing-card-paper"
                  className="pairing-card-paper"
                  value={paper}
                  onValueChange={(value) => setPaper(value === "a5" ? "a5" : "a4")}
                  options={[
                    { value: "a4", label: t("office.forms.papers.a4") },
                    { value: "a5", label: t("office.forms.papers.a5") },
                  ]}
                />
              )}
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
