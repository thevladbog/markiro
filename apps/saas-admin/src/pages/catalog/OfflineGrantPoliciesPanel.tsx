import { offlineGrantPolicySchema } from "@markiro/platform-contracts";
import { Alert, Button, Input, StatusChip, Table, Textarea, type TableColumn } from "@markiro/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiRequestError } from "../../api/client.js";
import {
  approveOfflineGrantPolicy,
  createOfflineGrantPolicy,
  listOfflineGrantPolicies,
  type OfflineGrantPolicyDto,
} from "./api.js";

const POLICY_QUERY_KEY = ["platform", "catalog", "lifecycle-policies"] as const;
const EMPTY_BOUNDS = "{}";

export function OfflineGrantPoliciesPanel({
  canWrite,
  onDirtyChange,
}: {
  canWrite: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const policies = useQuery({ queryKey: POLICY_QUERY_KEY, queryFn: listOfflineGrantPolicies });
  const [policyKey, setPolicyKey] = useState("");
  const [version, setVersion] = useState("1");
  const [maxOfflineHours, setMaxOfflineHours] = useState("");
  const [maxCompletionHours, setMaxCompletionHours] = useState("");
  const [taskBounds, setTaskBounds] = useState(EMPTY_BOUNDS);
  const [selectedDraft, setSelectedDraft] = useState<string | null>(null);
  const [decisionReference, setDecisionReference] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    onDirtyChange?.(
      Boolean(
        policyKey ||
        version !== "1" ||
        maxOfflineHours ||
        maxCompletionHours ||
        taskBounds !== EMPTY_BOUNDS ||
        decisionReference,
      ),
    );
  }, [
    decisionReference,
    maxCompletionHours,
    maxOfflineHours,
    onDirtyChange,
    policyKey,
    taskBounds,
    version,
  ]);

  const replace = (policy: OfflineGrantPolicyDto) => {
    queryClient.setQueryData<{ items: OfflineGrantPolicyDto[] }>(POLICY_QUERY_KEY, (current) => {
      if (!current) return { items: [policy] };
      const exists = current.items.some((item) => item.id === policy.id);
      return {
        items: exists
          ? current.items.map((item) => (item.id === policy.id ? policy : item))
          : [policy, ...current.items],
      };
    });
  };
  const create = useMutation({
    mutationFn: () => {
      const hours = Number(maxOfflineHours);
      const completion = Number(maxCompletionHours);
      return createOfflineGrantPolicy({
        policyKey,
        version: Number(version),
        offlineGrant: offlineGrantPolicySchema.parse({
          version: 1,
          maxOfflineMs: hours * 60 * 60 * 1_000,
          maxCompletionMs: completion * 60 * 60 * 1_000,
          taskBounds: JSON.parse(taskBounds) as unknown,
        }),
      });
    },
    onSuccess: (policy) => {
      replace(policy);
      setPolicyKey("");
      setVersion("1");
      setMaxOfflineHours("");
      setMaxCompletionHours("");
      setTaskBounds(EMPTY_BOUNDS);
      setSelectedDraft(policy.id);
      setMessage({ tone: "ok", text: t("catalog.offlinePolicies.created") });
    },
    onError: (error) =>
      setMessage({
        tone: "error",
        text:
          error instanceof SyntaxError
            ? t("catalog.offlinePolicies.invalidJson")
            : error instanceof ApiRequestError && error.status === 409
              ? t("catalog.offlinePolicies.conflict")
              : t("catalog.offlinePolicies.createError"),
      }),
  });
  const approve = useMutation({
    mutationFn: () => {
      if (!selectedDraft) throw new Error("draft_required");
      return approveOfflineGrantPolicy(selectedDraft, { decisionReference });
    },
    onSuccess: (policy) => {
      replace(policy);
      setSelectedDraft(null);
      setDecisionReference("");
      setMessage({ tone: "ok", text: t("catalog.offlinePolicies.approved") });
      void queryClient.invalidateQueries({ queryKey: ["platform", "catalog", "editor-context"] });
    },
    onError: () => setMessage({ tone: "error", text: t("catalog.offlinePolicies.approveError") }),
  });

  const columns: TableColumn<OfflineGrantPolicyDto>[] = [
    { key: "policyKey", title: t("catalog.offlinePolicies.columns.key") },
    { key: "version", title: t("catalog.offlinePolicies.columns.version"), mono: true },
    {
      key: "status",
      title: t("catalog.offlinePolicies.columns.status"),
      render: (policy) => (
        <StatusChip
          status={policy.status === "approved" ? "ok" : "warn"}
          label={t(`catalog.offlinePolicies.status.${policy.status}`)}
        />
      ),
    },
    {
      key: "maxOffline",
      title: t("catalog.offlinePolicies.columns.offline"),
      render: (policy) =>
        t("catalog.offlinePolicies.hours", {
          count: policy.offlineGrant.maxOfflineMs / 3_600_000,
        }),
    },
  ];

  if (policies.isPending) return <p role="status">{t("catalog.offlinePolicies.loading")}</p>;
  if (policies.isError) return <Alert tone="error">{t("catalog.offlinePolicies.loadError")}</Alert>;

  return (
    <div className="catalog-form">
      <Alert tone="info">{t("catalog.offlinePolicies.observeOnly")}</Alert>
      <Table
        columns={columns}
        rows={policies.data.items}
        empty={t("catalog.offlinePolicies.empty")}
        onRowClick={(policy) => setSelectedDraft(policy.status === "draft" ? policy.id : null)}
      />
      {canWrite ? (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setMessage(null);
              create.mutate();
            }}
          >
            <fieldset disabled={create.isPending || approve.isPending}>
              <legend>{t("catalog.offlinePolicies.newDraft")}</legend>
              <div className="form-grid form-grid--two">
                <Input
                  label={t("catalog.offlinePolicies.key")}
                  value={policyKey}
                  onChange={(event) => setPolicyKey(event.target.value)}
                  required
                />
                <Input
                  label={t("catalog.offlinePolicies.version")}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                  inputMode="numeric"
                  required
                />
                <Input
                  label={t("catalog.offlinePolicies.maxOffline")}
                  value={maxOfflineHours}
                  onChange={(event) => setMaxOfflineHours(event.target.value)}
                  inputMode="numeric"
                  required
                />
                <Input
                  label={t("catalog.offlinePolicies.maxCompletion")}
                  value={maxCompletionHours}
                  onChange={(event) => setMaxCompletionHours(event.target.value)}
                  inputMode="numeric"
                  required
                />
                <Textarea
                  className="catalog-form__full-width"
                  label={t("catalog.offlinePolicies.taskBounds")}
                  value={taskBounds}
                  onChange={(event) => setTaskBounds(event.target.value)}
                  rows={10}
                  required
                />
              </div>
              <Button type="submit" disabled={create.isPending}>
                {t("catalog.offlinePolicies.create")}
              </Button>
            </fieldset>
          </form>
          {selectedDraft ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setMessage(null);
                approve.mutate();
              }}
            >
              <fieldset disabled={approve.isPending}>
                <legend>{t("catalog.offlinePolicies.approval")}</legend>
                <Input
                  label={t("catalog.offlinePolicies.decisionReference")}
                  value={decisionReference}
                  onChange={(event) => setDecisionReference(event.target.value)}
                  required
                />
                <Button type="submit" disabled={approve.isPending}>
                  {t("catalog.offlinePolicies.approve")}
                </Button>
              </fieldset>
            </form>
          ) : null}
        </>
      ) : null}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </div>
  );
}
