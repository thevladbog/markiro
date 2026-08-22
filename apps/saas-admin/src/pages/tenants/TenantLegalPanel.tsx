import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BankAccountInput,
  BillingProfileInput,
  OperatorBillingProfileInput,
} from "@markiro/platform-contracts";

import { PanelState } from "../../components/PanelState.js";
import { LegalDataWorkspace } from "../legal/LegalDataWorkspace.js";
import { getDadataStatus } from "../legal/dadata.js";
import {
  archiveTenantBankAccount,
  createTenantBankAccount,
  getTenantBillingProfile,
  listTenantBankAccounts,
  setTenantBillingProfile,
  setTenantDefaultBankAccount,
} from "./api.js";

export function TenantLegalPanel({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const profileKey = ["platform", "billing", "tenant-profile", tenantId] as const;
  const accountsKey = ["platform", "billing", "tenant-accounts", tenantId] as const;
  const profile = useQuery({
    queryKey: profileKey,
    queryFn: () => getTenantBillingProfile(tenantId),
  });
  const accounts = useQuery({
    queryKey: accountsKey,
    queryFn: () => listTenantBankAccounts(tenantId),
  });
  const dadata = useQuery({
    queryKey: ["platform", "suggestions", "status"],
    queryFn: getDadataStatus,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: profileKey }),
      queryClient.invalidateQueries({ queryKey: accountsKey }),
    ]);
  };
  const saveProfile = useMutation({
    mutationFn: (input: BillingProfileInput | OperatorBillingProfileInput) =>
      setTenantBillingProfile(tenantId, input),
    onSuccess: refresh,
  });
  const createAccount = useMutation({
    mutationFn: (input: BankAccountInput) => createTenantBankAccount(tenantId, input),
    onSuccess: refresh,
  });
  const setDefault = useMutation({
    mutationFn: (accountId: string) => setTenantDefaultBankAccount(tenantId, accountId),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: ({ id, replacementAccountId }: { id: string; replacementAccountId?: string }) =>
      archiveTenantBankAccount(tenantId, id, replacementAccountId ? { replacementAccountId } : {}),
    onSuccess: refresh,
  });
  const busy =
    saveProfile.isPending || createAccount.isPending || setDefault.isPending || archive.isPending;

  return (
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
        scope="tenant"
        profile={profile.data ?? null}
        accounts={accounts.data ?? []}
        dadataStatus={dadata.data?.status ?? "unavailable"}
        canWrite={canWrite}
        busy={busy}
        onSaveProfile={(input) => saveProfile.mutateAsync(input)}
        onCreateAccount={(input) => createAccount.mutateAsync(input)}
        onSetDefault={(id) => setDefault.mutateAsync(id)}
        onArchive={(id, replacementAccountId) =>
          archive.mutateAsync({ id, ...(replacementAccountId ? { replacementAccountId } : {}) })
        }
      />
    </PanelState>
  );
}
