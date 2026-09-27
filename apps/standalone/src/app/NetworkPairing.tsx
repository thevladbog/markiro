import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input } from "@markiro/ui";

import { DeviceError, type ClaimInput, type DeviceErrorCode } from "../host/device.js";
import { hasCyrillic, normalizePairingCode, parsePairingPayload } from "../host/pairing-code.js";
import { HostProbeError, type HostProbe } from "../host/probe.js";
import { errorProp } from "../lib/form-error.js";
import { personNameRule } from "../lib/rules.js";
import { formatFingerprint } from "./fingerprint.js";
import { findHost, hostUrl, parseHostAddress, type HostSearch } from "./host-search.js";

/** What a typed code that cannot be a code is told. */
const CODE_ERRORS = {
  invalid: "shell.networkPairing.codeInvalid",
  // Cyrillic is not read by key position, as a scan is: a Cyrillic letter
  // typed for its Latin look-alike would become another valid symbol and
  // count against every live code on the host.
  layout: "shell.networkPairing.codeLayout",
} as const;

export interface NetworkPairingProps {
  probe: HostProbe;
  /** Pairs with the confirmed host; rejects with a `DeviceError` the screen explains. */
  onClaim: (input: ClaimInput) => Promise<void>;
  onBack: () => void;
}

/** A typed code waiting for a person to compare the host's fingerprint with the office screen. */
interface Confirmation {
  address: string;
  fingerprint: string;
  code: string;
  name: string;
}

/** An i18n key with its values. */
interface Notice {
  key: string;
  values?: Record<string, string>;
}

/** The device texts that speak of "this computer" get network words here. */
function failureKey(error: unknown): string {
  let code: DeviceErrorCode | null = null;
  if (error instanceof DeviceError || error instanceof HostProbeError) code = error.code;
  if (code === "unreachable") return "shell.networkPairing.errors.unreachable";
  if (code === "not_markiro_host") return "shell.networkPairing.errors.notHost";
  return code === null ? "errors.unknown" : `errors.device.${code}`;
}

/**
 * Failures that can come after the host already took the code (its answer
 * was unreadable, came from another host, or could not be saved here): the
 * code may be spent, so the text asks for a new one instead of a retry.
 */
const MAYBE_SPENT: ReadonlySet<DeviceErrorCode> = new Set([
  "invalid_response",
  "host_changed",
  "storage",
]);

function claimFailureKey(error: unknown): string {
  if (error instanceof DeviceError && MAYBE_SPENT.has(error.code)) {
    return "shell.networkPairing.errors.codeMaybeSpent";
  }
  return failureKey(error);
}

function searchNotice(search: Exclude<HostSearch, { kind: "found" }>, addresses: string): Notice {
  switch (search.kind) {
    case "other_host":
      return { key: "shell.networkPairing.errors.otherHost" };
    case "incompatible":
      return { key: `errors.device.${search.reason}` };
    case "unreachable":
      return { key: "shell.networkPairing.errors.notFound", values: { addresses } };
  }
}

/**
 * Pairing with a host in the network (spec §4.7). A scanned office code
 * carries the host's addresses and certificate fingerprint: every address is
 * probed at once, and the code goes out only to the one whose certificate
 * matches. A typed address and code show the host's fingerprint first; the
 * code goes out only after a person confirmed it against the office screen.
 * A refused claim is never retried on its own.
 */
export function NetworkPairing({ probe, onClaim, onBack }: NetworkPairingProps) {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const [name, setName] = useState(() => t("shell.networkPairing.defaultName"));
  const [nameInvalid, setNameInvalid] = useState(false);
  const [scan, setScan] = useState("");
  const [address, setAddress] = useState("");
  const [addressInvalid, setAddressInvalid] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<keyof typeof CODE_ERRORS | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const checkedName = (): string | null => {
    const parsed = personNameRule.safeParse(name);
    setNameInvalid(!parsed.success);
    return parsed.success ? parsed.data : null;
  };

  const claim = async (input: ClaimInput) => {
    try {
      // On success the shell leaves this screen.
      await onClaim(input);
    } catch (error) {
      setConfirmation(null);
      setNotice({ key: claimFailureKey(error) });
      setBusy(false);
    }
  };

  const submitScan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const text = scan;
    // A scan is read once: the next one starts in an empty field.
    setScan("");
    setNotice(null);
    const deviceName = checkedName();
    const payload = parsePairingPayload(text);
    if (payload === null) {
      setNotice({ key: "shell.networkPairing.errors.notPayload" });
      return;
    }
    if (payload.addresses.length === 0) {
      setNotice({ key: "shell.networkPairing.errors.noAddresses" });
      return;
    }
    if (deviceName === null) return;
    setBusy(true);
    const candidates = payload.addresses.map((host) => hostUrl(host, payload.port));
    const search = await findHost(probe, candidates, payload.fingerprint);
    if (search.kind !== "found") {
      setNotice(searchNotice(search, payload.addresses.join(", ")));
      setBusy(false);
      return;
    }
    await claim({
      address: search.address,
      fingerprint: payload.fingerprint,
      code: payload.code,
      name: deviceName,
    });
  };

  const submitManual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const deviceName = checkedName();
    const url = parseHostAddress(address);
    // A code that cannot be a code never reaches the host, where a wrong one
    // counts against every live code.
    const canonical = normalizePairingCode(code);
    setAddressInvalid(url === null);
    let codeProblem: keyof typeof CODE_ERRORS | null = null;
    if (canonical === null) codeProblem = hasCyrillic(code) ? "layout" : "invalid";
    setCodeError(codeProblem);
    if (deviceName === null || url === null || canonical === null) return;
    setBusy(true);
    try {
      const observation = await probe.hello(url);
      setConfirmation({
        address: url,
        fingerprint: observation.fingerprint,
        code: canonical,
        name: deviceName,
      });
    } catch (error) {
      setNotice({ key: failureKey(error) });
    }
    setBusy(false);
  };

  const confirm = async (confirmed: Confirmation) => {
    setBusy(true);
    setNotice(null);
    await claim(confirmed);
  };

  const nameField = (
    <Input
      label={t("shell.networkPairing.name")}
      hint={t("shell.networkPairing.nameHint")}
      value={name}
      onChange={(event) => setName(event.target.value)}
      {...errorProp(nameInvalid ? t("rules.name") : undefined)}
    />
  );

  const body = () => {
    if (confirmation) {
      return (
        <>
          <p>{t("shell.networkPairing.fingerprintBody")}</p>
          <p className="standalone-fingerprint-label">
            {t("shell.networkPairing.fingerprintLabel", { address: confirmation.address })}
          </p>
          <p className="standalone-fingerprint">{formatFingerprint(confirmation.fingerprint)}</p>
          <div className="standalone-form__actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                setNotice({ key: "shell.networkPairing.fingerprintDiffersNote" });
              }}
            >
              {t("shell.networkPairing.fingerprintDiffers")}
            </Button>
            <Button loading={busy} onClick={() => void confirm(confirmation)}>
              {t("shell.networkPairing.fingerprintMatches")}
            </Button>
          </div>
        </>
      );
    }
    if (manual) {
      return (
        <form className="standalone-form" onSubmit={(event) => void submitManual(event)} noValidate>
          {nameField}
          <Input
            label={t("shell.networkPairing.address")}
            hint={t("shell.networkPairing.addressHint")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            {...errorProp(addressInvalid ? t("shell.networkPairing.addressInvalid") : undefined)}
          />
          <Input
            label={t("shell.networkPairing.code")}
            hint={t("shell.networkPairing.codeHint")}
            mono
            value={code}
            onChange={(event) => setCode(event.target.value)}
            {...errorProp(codeError === null ? undefined : t(CODE_ERRORS[codeError]))}
          />
          <div className="standalone-form__actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setManual(false);
                setNotice(null);
              }}
            >
              {t("shell.networkPairing.scanInstead")}
            </Button>
            <Button type="submit" loading={busy}>
              {t("shell.networkPairing.next")}
            </Button>
          </div>
        </form>
      );
    }
    return (
      <form className="standalone-form" onSubmit={(event) => void submitScan(event)} noValidate>
        {nameField}
        {/* A keyboard-wedge scanner types into the focused field and presses Enter. */}
        <Input
          label={t("shell.networkPairing.scan")}
          hint={t("shell.networkPairing.scanHint")}
          value={scan}
          onChange={(event) => setScan(event.target.value)}
          autoFocus
          spellCheck={false}
        />
        <div className="standalone-form__actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setManual(true);
              setNotice(null);
            }}
          >
            {t("shell.networkPairing.manual")}
          </Button>
          <Button type="submit" loading={busy}>
            {t("shell.networkPairing.pair")}
          </Button>
        </div>
      </form>
    );
  };

  return (
    <Card className="standalone-card" title={t("shell.networkPairing.title")} titleAs="h2">
      <div className="standalone-form">
        <p>{t("shell.networkPairing.intro")}</p>
        {notice && <Alert tone="error">{t(notice.key, notice.values ?? {})}</Alert>}
        {body()}
        <div className="standalone-form__actions">
          <Button variant="secondary" disabled={busy} onClick={onBack}>
            {t("shell.networkPairing.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
