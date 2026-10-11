import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Input } from "@markiro/ui";

import { DeviceError } from "../host/device.js";
import { errorMessageKey } from "../host/errors.js";
import { errorProp } from "../lib/form-error.js";
import { FormDialog } from "../office/FormDialog.js";
import { parseHostAddress } from "./host-search.js";

export interface HostAddressDialogProps {
  /**
   * Moves the pairing to the address (`https://host:port`); rejects with a
   * `DeviceError` the dialog explains. A function-typed property, passed
   * unbound.
   */
  onChange: (address: string) => Promise<void>;
  onClose: () => void;
}

/**
 * What a refused change says. `unreachable` is about the typed address here,
 * not about the service on this computer (`errors.device.unreachable`), and
 * `invalid_request` is the shell refusing the spelling of the address.
 */
function failureKey(error: unknown): string {
  if (error instanceof DeviceError) {
    if (error.code === "unreachable") return "office.login.address.unreachable";
    if (error.code === "invalid_request") return "office.login.address.invalid";
  }
  return errorMessageKey(error);
}

/**
 * «Сменить адрес хоста» (plan УСТ, pilot spec §9.4): the host PC got another
 * IP address. The address is typed as for pairing (`parseHostAddress`: the
 * port 45710 when left out, Cyrillic read by key position); the shell keeps
 * it only if the same host answers there, so a typo never loses the pairing.
 */
export function HostAddressDialog({ onChange, onClose }: HostAddressDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setFailure(null);
    const address = parseHostAddress(value);
    setInvalid(address === null);
    if (address === null) return;
    try {
      await onChange(address);
    } catch (error) {
      setFailure(failureKey(error));
    }
  };

  return (
    <FormDialog
      title={t("office.login.address.title")}
      submitLabel={t("office.login.address.submit")}
      onSubmit={submit}
      onClose={onClose}
      alert={failure && <Alert tone="error">{t(failure)}</Alert>}
    >
      <Input
        label={t("office.login.address.label")}
        hint={t("office.login.address.hint")}
        value={value}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
        {...errorProp(invalid ? t("office.login.address.invalid") : undefined)}
      />
    </FormDialog>
  );
}
