import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  BankAccount,
  BankAccountInput,
  BillingProfile,
  BillingProfileInput,
  DadataSuggestionStatus,
  OperatorBillingProfileInput,
} from "@markiro/platform-contracts";
import { Alert, Card } from "@markiro/ui";

import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import { BankAccountsPanel } from "./BankAccountsPanel.js";
import { BillingReadiness } from "./BillingReadiness.js";
import { LegalProfileForm } from "./LegalProfileForm.js";

export function LegalDataWorkspace({
  scope,
  profile,
  accounts,
  dadataStatus,
  canWrite,
  busy,
  onSaveProfile,
  onCreateAccount,
  onSetDefault,
  onArchive,
}: {
  scope: "operator" | "tenant";
  profile: BillingProfile | null;
  accounts: BankAccount[];
  dadataStatus: DadataSuggestionStatus;
  canWrite: boolean;
  busy: boolean;
  onSaveProfile: (input: BillingProfileInput | OperatorBillingProfileInput) => Promise<unknown>;
  onCreateAccount: (input: BankAccountInput) => Promise<unknown>;
  onSetDefault: (accountId: string) => Promise<unknown>;
  onArchive: (accountId: string, replacementAccountId?: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  useNavigationGuard(dirty, busy);

  return (
    <div className="legal-workspace">
      <BillingReadiness profile={profile} accounts={accounts} />
      <Alert tone={dadataStatus === "ready" ? "ok" : "info"}>
        {t(`legal.dadata.health.${dadataStatus}`)}
      </Alert>
      <Card
        className="legal-profile-card"
        title={t(
          scope === "operator" ? "legal.profile.operatorTitle" : "legal.profile.tenantTitle",
        )}
        titleAs="h2"
      >
        <LegalProfileForm
          scope={scope}
          profile={profile}
          canWrite={canWrite}
          busy={busy}
          onSave={onSaveProfile}
          onDirtyChange={setDirty}
        />
      </Card>
      <BankAccountsPanel
        accounts={accounts}
        canWrite={canWrite}
        busy={busy}
        onCreate={onCreateAccount}
        onSetDefault={onSetDefault}
        onArchive={onArchive}
      />
    </div>
  );
}
