import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Checkbox,
  FileDropZone,
  Input,
  Modal,
  RadioGroup,
  Textarea,
} from "@markiro/ui";
import type { StandaloneSite, StandaloneSiteInspection } from "@markiro/platform-contracts";

import {
  ActivationFileError,
  inspectActivationRequest,
  readActivationRequestFile,
  readActivationRequestText,
  registerStandaloneSite,
  type ActivationRequest,
} from "./standalone-api.js";
import { standaloneErrorKey, standaloneSitesKey } from "./standalone-format.js";
import { diagnosticsKey } from "./diagnostics-api.js";
import { diagnosticsErrorCode, diagnosticsErrorKey } from "./diagnostics-format.js";

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
  const [paste, setPaste] = useState("");
  const [request, setRequest] = useState<ActivationRequest | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [fileError, setFileError] = useState<ActivationFileError["reason"] | null>(null);
  const [mode, setMode] = useState(CREATE);
  const [name, setName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const inspect = useMutation({
    gcTime: 0,
    mutationFn: (input: { request: ActivationRequest; acknowledge?: boolean }) =>
      inspectActivationRequest(tenantId, {
        request: input.request,
        ...(input.acknowledge ? { acknowledgeUnboundHost: true } : {}),
      }),
    onSuccess: async (response) => {
      if (response.diagnostics)
        await queryClient.invalidateQueries({ queryKey: diagnosticsKey(tenantId) });
    },
  });
  const inspection: StandaloneSiteInspection | undefined = inspect.data;
  const register = useMutation({
    gcTime: 0,
    mutationFn: () => {
      if (!request || !inspection) throw new Error("activation request required");
      const activation = { ...request };
      delete activation.supportToken;
      return mode === CREATE
        ? registerStandaloneSite(tenantId, {
            intent: "create",
            requestId,
            name: name.trim(),
            request: activation,
            acknowledgedWarnings: inspection.warnings,
          })
        : registerStandaloneSite(tenantId, {
            intent: "rebind",
            requestId,
            siteId: mode,
            request: activation,
            acknowledgedWarnings: inspection.warnings,
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: standaloneSitesKey(tenantId) });
      close();
    },
  });
  function close(): void {
    setPaste("");
    setRequest(null);
    inspect.reset();
    register.reset();
    onClose();
  }
  const resetInspect = inspect.reset;
  const resetRegister = register.reset;
  useEffect(
    () => () => {
      resetInspect();
      resetRegister();
    },
    [resetInspect, resetRegister],
  );
  const read = async (load: () => ActivationRequest | Promise<ActivationRequest>) => {
    setFileError(null);
    setRequest(null);
    setAcknowledged(false);
    inspect.reset();
    register.reset();
    try {
      const value = await load();
      setRequest(value);
      setRequestId(crypto.randomUUID());
      inspect.mutate({ request: value });
    } catch (error) {
      setFileError(error instanceof ActivationFileError ? error.reason : "invalid");
    }
  };
  const unbound =
    inspect.isError &&
    diagnosticsErrorCode(inspect.error) === "standalone_diagnostics_host_unbound";
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
      onClose={close}
      closeLabel={t("tenants.detail.standalone.register.cancel")}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
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
        onFile={(file) => void read(() => readActivationRequestFile(file))}
      />
      <Textarea
        label={t("tenants.detail.standalone.register.pasteLabel")}
        rows={4}
        value={paste}
        readOnly={inspect.isPending}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setPaste(event.target.value)}
      />
      <Button
        variant="secondary"
        disabled={paste.trim() === "" || inspect.isPending}
        onClick={() => void read(() => readActivationRequestText(paste))}
      >
        {t("tenants.detail.standalone.register.pasteSubmit")}
      </Button>
      {fileError ? (
        <Alert tone="error" role="alert">
          {t(`tenants.detail.standalone.register.fileErrors.${fileError}`)}
        </Alert>
      ) : null}
      {unbound ? (
        <Alert
          tone="warn"
          action={
            <Button
              variant="secondary"
              disabled={inspect.isPending || request === null}
              onClick={() => {
                if (request !== null) inspect.mutate({ request, acknowledge: true });
              }}
            >
              {t("tenants.detail.diagnostics.ingest.confirmUnboundAction")}
            </Button>
          }
        >
          {t("tenants.detail.diagnostics.ingest.confirmUnbound")}
        </Alert>
      ) : inspect.isError ? (
        <Alert tone="error" role="alert">
          {t(
            diagnosticsErrorCode(inspect.error)?.startsWith("standalone_diagnostics_")
              ? diagnosticsErrorKey(inspect.error)
              : standaloneErrorKey(inspect.error),
          )}
        </Alert>
      ) : null}
      {inspection?.diagnostics ? (
        <Alert tone="ok" role="status">
          {t("tenants.detail.standalone.register.statisticsUpdated", {
            n: inspection.diagnostics.monthsApplied,
          })}
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
