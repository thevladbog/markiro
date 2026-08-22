import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  bankAccountInputSchema,
  type BankAccount,
  type BankAccountInput,
  type DadataBankSuggestion,
} from "@markiro/platform-contracts";
import { Alert, Button, ConfirmDialog, Input, Select, StatusChip } from "@markiro/ui";

import { BankSuggestField } from "./BankSuggestField.js";

const EMPTY_ACCOUNT: BankAccountInput = {
  label: "",
  settlementAccount: "",
  bic: "",
  bankName: "",
  correspondentAccount: "",
  currency: "RUB",
};

export function BankAccountsPanel({
  accounts,
  canWrite,
  busy,
  onCreate,
  onSetDefault,
  onArchive,
}: {
  accounts: BankAccount[];
  canWrite: boolean;
  busy: boolean;
  onCreate: (input: BankAccountInput) => Promise<unknown>;
  onSetDefault: (accountId: string) => Promise<unknown>;
  onArchive: (accountId: string, replacementAccountId?: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<BankAccountInput>(EMPTY_ACCOUNT);
  const [bankSearch, setBankSearch] = useState("");
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [replacementId, setReplacementId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = accounts.filter((account) => account.status === "active");
  const archived = accounts.filter((account) => account.status === "archived");
  const archiveAccount = accounts.find((account) => account.id === archiveId) ?? null;
  const replacements = useMemo(
    () => active.filter((account) => account.id !== archiveId),
    [active, archiveId],
  );

  const patch = (next: Partial<BankAccountInput>) =>
    setDraft((current) => ({ ...current, ...next }));
  const selectBank = (suggestion: DadataBankSuggestion) => {
    setBankSearch(suggestion.value);
    patch({
      bic: suggestion.bic,
      bankName: suggestion.bankName,
      correspondentAccount: suggestion.correspondentAccount ?? "",
    });
  };

  return (
    <section className="bank-accounts-panel" aria-labelledby="bank-accounts-title">
      <header className="legal-section-heading">
        <div>
          <span className="panel-coordinate">BANK / RUB</span>
          <h2 id="bank-accounts-title">{t("legal.accounts.title")}</h2>
        </div>
        {canWrite ? (
          <Button variant="secondary" onClick={() => setCreating((current) => !current)}>
            {creating ? t("legal.accounts.cancelCreate") : t("legal.accounts.add")}
          </Button>
        ) : null}
      </header>

      {creating ? (
        <form
          className="bank-account-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const parsed = bankAccountInputSchema.safeParse(draft);
            if (!parsed.success) {
              setError(t("legal.accounts.invalid"));
              return;
            }
            void onCreate(parsed.data).then(
              () => {
                setDraft(EMPTY_ACCOUNT);
                setBankSearch("");
                setCreating(false);
              },
              () => setError(t("legal.accounts.saveFailed")),
            );
          }}
        >
          <BankSuggestField
            value={bankSearch}
            onValueChange={setBankSearch}
            onSelect={selectBank}
            disabled={busy}
          />
          <Input
            label={t("legal.accounts.label")}
            value={draft.label}
            onChange={(event) => patch({ label: event.target.value })}
            required
          />
          <Input
            label={t("legal.accounts.settlement")}
            value={draft.settlementAccount}
            onChange={(event) => patch({ settlementAccount: digits(event.target.value, 20) })}
            inputMode="numeric"
            mono
            required
          />
          <Input
            label={t("legal.accounts.bic")}
            value={draft.bic}
            onChange={(event) => patch({ bic: digits(event.target.value, 9) })}
            inputMode="numeric"
            mono
            required
          />
          <Input
            label={t("legal.accounts.bankName")}
            value={draft.bankName}
            onChange={(event) => patch({ bankName: event.target.value })}
            required
          />
          <Input
            label={t("legal.accounts.correspondent")}
            value={draft.correspondentAccount}
            onChange={(event) => patch({ correspondentAccount: digits(event.target.value, 20) })}
            inputMode="numeric"
            mono
            required
          />
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" loading={busy}>
            {t("legal.accounts.save")}
          </Button>
        </form>
      ) : null}

      {active.length ? (
        <div className="bank-account-list">
          {active.map((account) => (
            <article key={account.id} className="bank-account-card" aria-label={account.label}>
              <div className="bank-account-card__identity">
                <div>
                  <strong>{account.label}</strong>
                  <span>{account.bankName}</span>
                </div>
                {account.isDefault ? (
                  <StatusChip status="ok" label={t("legal.accounts.default")} />
                ) : null}
              </div>
              <dl>
                <div>
                  <dt>{t("legal.accounts.settlementShort")}</dt>
                  <dd className="mono">{mask(account.settlementAccount)}</dd>
                </div>
                <div>
                  <dt>{t("legal.accounts.bic")}</dt>
                  <dd className="mono">{account.bic}</dd>
                </div>
                <div>
                  <dt>{t("legal.accounts.currency")}</dt>
                  <dd>{account.currency}</dd>
                </div>
              </dl>
              {canWrite ? (
                <div className="bank-account-card__actions">
                  {!account.isDefault ? (
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void onSetDefault(account.id)}
                    >
                      {t("legal.accounts.makeDefault")}
                    </Button>
                  ) : null}
                  <Button
                    size="compact"
                    variant="destructive-outline"
                    disabled={busy || (account.isDefault && replacements.length === 0)}
                    onClick={() => {
                      setArchiveId(account.id);
                      setReplacementId(replacements[0]?.id ?? "");
                    }}
                  >
                    {t("legal.accounts.archive")}
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="legal-empty-state">{t("legal.accounts.empty")}</div>
      )}

      {archived.length ? (
        <details className="archived-accounts">
          <summary>{t("legal.accounts.archived", { count: archived.length })}</summary>
          <ul>
            {archived.map((account) => (
              <li key={account.id}>
                {account.label} · <span className="mono">{mask(account.settlementAccount)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ConfirmDialog
        open={archiveAccount !== null}
        title={t("legal.accounts.archiveTitle")}
        description={
          <div className="archive-account-confirmation">
            <p>{t("legal.accounts.archiveBody", { label: archiveAccount?.label })}</p>
            {archiveAccount?.isDefault && replacements.length ? (
              <Select
                native
                label={t("legal.accounts.replacement")}
                value={replacementId}
                onValueChange={setReplacementId}
                options={replacements.map((account) => ({
                  value: account.id,
                  label: `${account.label} · ${mask(account.settlementAccount)}`,
                }))}
              />
            ) : null}
          </div>
        }
        confirmLabel={t("legal.accounts.confirmArchive")}
        cancelLabel={t("legal.accounts.cancelArchive")}
        tone="destructive"
        busy={busy}
        onCancel={() => setArchiveId(null)}
        onConfirm={() => {
          if (!archiveAccount) return;
          const replacement = archiveAccount.isDefault ? replacementId || undefined : undefined;
          void onArchive(archiveAccount.id, replacement).then(() => setArchiveId(null));
        }}
      />
    </section>
  );
}

function digits(value: string, max: number): string {
  return value.replace(/\D/g, "").slice(0, max);
}

function mask(value: string): string {
  return `•••• ${value.slice(-4)}`;
}
