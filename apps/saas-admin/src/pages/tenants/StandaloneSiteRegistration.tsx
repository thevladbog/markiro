import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox, FileDropZone, Input, Modal, RadioGroup } from "@markiro/ui";
import type { StandaloneSite, StandaloneSiteInspection } from "@markiro/platform-contracts";

import {
  ActivationFileError,
  inspectActivationRequest,
  readActivationRequestFile,
  registerStandaloneSite,
  type ActivationRequest,
} from "./standalone-api.js";
import { standaloneErrorKey, standaloneSitesKey } from "./standalone-format.js";

const CREATE = "create";

/** Spec §6.2 step 1 and §6.3: a site from an activation request, or a new host id for a site. */
export function StandaloneSiteRegistration({
  tenantId,
  sites,
  onClose,
}: {
  tenantId: string;
  sites: readonly StandaloneSite[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<ActivationRequest | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [fileError, setFileError] = useState<ActivationFileError["reason"] | null>(null);
  const [mode, setMode] = useState(CREATE);
  const [name, setName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const inspect = useMutation({
    mutationFn: (value: ActivationRequest) =>
      inspectActivationRequest(tenantId, { request: value }),
  });
  const inspection: StandaloneSiteInspection | undefined = inspect.data;
  const register = useMutation({
    mutationFn: () => {
      if (!request || !inspection) throw new Error("activation request required");
      return mode === CREATE
        ? registerStandaloneSite(tenantId, {
            intent: "create",
            requestId,
            name: name.trim(),
            request,
            acknowledgedWarnings: inspection.warnings,
          })
        : registerStandaloneSite(tenantId, {
            intent: "rebind",
            requestId,
            siteId: mode,
            request,
            acknowledgedWarnings: inspection.warnings,
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: standaloneSitesKey(tenantId) });
      onClose();
    },
  });
  const readFile = async (file: File) => {
    setFileError(null);
    setRequest(null);
    setAcknowledged(false);
    inspect.reset();
    register.reset();
    try {
      const value = await readActivationRequestFile(file);
      setRequest(value);
      setRequestId(crypto.randomUUID());
      inspect.mutate(value);
    } catch (error) {
      setFileError(error instanceof ActivationFileError ? error.reason : "invalid");
    }
  };
  const noValue = t("tenants.detail.standalone.noValue");
  const canSubmit =
    inspection !== undefined &&
    inspection.blocking === null &&
    (inspection.warnings.length === 0 || acknowledged) &&
    (mode !== CREATE || name.trim() !== "") &&
    !register.isPending;
  return (
    <Modal
      open
      title={t("tenants.detail.standalone.register.title")}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.register.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("tenants.detail.standalone.register.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => register.mutate()}>
            {mode === CREATE
              ? t("tenants.detail.standalone.register.submit")
              : t("tenants.detail.standalone.register.submitRebind")}
          </Button>
        </>
      }
    >
      <FileDropZone
        label={t("tenants.detail.standalone.register.drop")}
        hint={t("tenants.detail.standalone.register.dropHint")}
        ariaLabel={t("tenants.detail.standalone.register.drop")}
        accept=".json,application/json"
        busy={inspect.isPending}
        onFile={(file) => void readFile(file)}
      />
      {fileError ? (
        <Alert tone="error" role="alert">
          {t(`tenants.detail.standalone.register.fileErrors.${fileError}`)}
        </Alert>
      ) : null}
      {inspect.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(inspect.error))}
        </Alert>
      ) : null}
      {inspection ? (
        <>
          <dl className="tenant-facts">
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.host")}</dt>
              <dd className="mono">{inspection.hostId}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.version")}</dt>
              <dd>{inspection.hostVersion ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.organization")}</dt>
              <dd>{inspection.organizationName ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.requestInn")}</dt>
              <dd className="mono">{inspection.innFacts.requestInn ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.orgInn")}</dt>
              <dd className="mono">{inspection.innFacts.orgInn ?? noValue}</dd>
            </div>
            <div>
              <dt>{t("tenants.detail.standalone.register.facts.billingInn")}</dt>
              <dd className="mono">{inspection.innFacts.billingInn ?? noValue}</dd>
            </div>
          </dl>
          <p>{t("tenants.detail.standalone.register.facts.usage", inspection.usage)}</p>
          {inspection.blocking ? (
            <Alert tone="error" role="alert">
              {t(`tenants.detail.standalone.register.blocking.${inspection.blocking}`, {
                name: inspection.registeredSite?.name ?? "",
              })}
            </Alert>
          ) : (
            <>
              {inspection.warnings.length ? (
                <Alert tone="warn" title={t("tenants.detail.standalone.register.warningsTitle")}>
                  <ul>
                    {inspection.warnings.map((code) => (
                      <li key={code}>{t(`tenants.detail.standalone.warnings.${code}`)}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <RadioGroup
                label={t("tenants.detail.standalone.register.mode.label")}
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: CREATE, label: t("tenants.detail.standalone.register.mode.create") },
                  ...sites.map((site) => ({
                    value: site.id,
                    label: t("tenants.detail.standalone.register.mode.rebind", { name: site.name }),
                  })),
                ]}
              />
              {mode === CREATE ? (
                <Input
                  label={t("tenants.detail.standalone.register.name")}
                  value={name}
                  maxLength={200}
                  onChange={(event) => setName(event.target.value)}
                />
              ) : null}
              {inspection.warnings.length ? (
                <Checkbox
                  label={t("tenants.detail.standalone.register.acknowledge")}
                  checked={acknowledged}
                  onCheckedChange={setAcknowledged}
                />
              ) : null}
            </>
          )}
        </>
      ) : null}
      {register.isError ? (
        <Alert tone="error" role="alert">
          {t(standaloneErrorKey(register.error))}
        </Alert>
      ) : null}
    </Modal>
  );
}
