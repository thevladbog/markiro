import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { HostNetwork } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

/**
 * «Адрес хоста может измениться» (plan ТСД-П, spec 9.1): shown to an administrator while some address of the
 * host is not static and nobody confirmed that it stays. The addresses and the MAC are what the router's
 * reservation needs. Nothing blocks: the notice stays until «Я зарезервировал адрес».
 */
export function HostAddressNotice() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const network = useOfficeQuery(
    officeKeys.hostNetwork,
    (api, token) => api.getHostNetwork(token),
    {
      staleTime: 60_000,
    },
  );
  const confirm = useOfficeMutation((api, token, confirmed: boolean) =>
    api.confirmHostNetwork(token, { confirmed }),
  );
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  if (!network.isSuccess) return null;
  const { addresses, confirmedAt } = network.data;
  const floating = addresses.filter((address) => address.mode !== "static");
  if (confirmedAt !== null || floating.length === 0) return null;
  const submit = async () => {
    setFailure(null);
    try {
      const saved = await confirm.mutateAsync(true);
      client.setQueryData<HostNetwork>(officeKeys.hostNetwork, saved);
    } catch (error) {
      setFailure(alertFailure(error));
    }
  };
  return (
    <Alert
      tone="warn"
      aria-label={t("office.hostAddress.title")}
      title={t("office.hostAddress.title")}
      action={
        <Button variant="secondary" loading={confirm.isPending} onClick={() => void submit()}>
          {t("office.hostAddress.confirm")}
        </Button>
      }
    >
      <p>
        {t("office.hostAddress.body", {
          addresses: floating
            .map((address) =>
              address.mac === null ? address.address : `${address.address} (MAC ${address.mac})`,
            )
            .join(", "),
        })}
      </p>
      <WriteFailureAlert failure={failure} />
    </Alert>
  );
}
