import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  BankAccountInput,
  BillingProfileInput,
  OperatorBillingProfileInput,
} from "@markiro/platform-contracts";
import { Alert, PageHeader } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { PanelState } from "../../components/PanelState.js";
import { LegalDataWorkspace } from "../legal/LegalDataWorkspace.js";
import { getDadataStatus } from "../legal/dadata.js";
import {
  archiveOperatorBankAccount,
  createOperatorBankAccount,
  getOperatorBillingProfile,
  listOperatorBankAccounts,
  setOperatorBillingProfile,
  setOperatorDefaultBankAccount,
} from "./api.js";

const PROFILE_KEY = ["platform", "billing", "operator-profile"] as const;
const ACCOUNTS_KEY = ["platform", "billing", "operator-accounts"] as const;

export function OrganizationPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const canRead = principal.capabilities.includes("billing.read");
  const canWrite = principal.capabilities.includes("billing.write");
  const profile = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: getOperatorBillingProfile,
    enabled: canRead,
  });
  const accounts = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: listOperatorBankAccounts,
    enabled: canRead,
  });
  const dadata = useQuery({
    queryKey: ["platform", "suggestions", "status"],
    queryFn: getDadataStatus,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PROFILE_KEY }),
      queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
    ]);
  };
  const saveProfile = useMutation({
    mutationFn: (input: BillingProfileInput | OperatorBillingProfileInput) =>
      setOperatorBillingProfile(input as OperatorBillingProfileInput),
    onSuccess: refresh,
  });
  const createAccount = useMutation({ mutationFn: createOperatorBankAccount, onSuccess: refresh });
  const setDefault = useMutation({
    mutationFn: setOperatorDefaultBankAccount,
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: ({ id, replacementAccountId }: { id: string; replacementAccountId?: string }) =>
      archiveOperatorBankAccount(id, replacementAccountId ? { replacementAccountId } : {}),
    onSuccess: refresh,
  });
  const busy =
    saveProfile.isPending || createAccount.isPending || setDefault.isPending || archive.isPending;

  return (
    <section className="organization-page">
      <PageHeader title={t("legal.organization.title")} />
      <p className="organization-page__subtitle">{t("legal.organization.subtitle")}</p>
      <div className="tenant-detail-coordinate" aria-hidden="true">
        SETTINGS / LEGAL / BANKING
      </div>
      {!canRead ? <Alert tone="warn">{t("legal.noAccess")}</Alert> : null}
      {canRead ? (
        <PanelState
          loading={profile.isPending || accounts.isPending || dadata.isPending}
          empty={false}
          error={profile.error ?? accounts.error ?? dadata.error}
          onRetry={() => {
            void profile.refetch();
            void accounts.refetch();
            void dadata.refetch();
          }}
        >
          <LegalDataWorkspace
            scope="operator"
            profile={profile.data ?? null}
            accounts={accounts.data ?? []}
            dadataStatus={dadata.data?.status ?? "unavailable"}
            canWrite={canWrite}
            busy={busy}
            onSaveProfile={(input) => saveProfile.mutateAsync(input)}
            onCreateAccount={(input: BankAccountInput) => createAccount.mutateAsync(input)}
            onSetDefault={(id) => setDefault.mutateAsync(id)}
            onArchive={(id, replacementAccountId) =>
              archive.mutateAsync({ id, ...(replacementAccountId ? { replacementAccountId } : {}) })
            }
          />
        </PanelState>
      ) : null}
    </section>
  );
}
