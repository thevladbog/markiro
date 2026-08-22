import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Input,
  SectionHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import {
  changePlatformRole,
  invitePlatformUser,
  listPlatformTeam,
  recoverPlatformTwoFactor,
  renewPlatformActivation,
  suspendPlatformUser,
  type PlatformRole,
  type PlatformUser,
} from "./api.js";

const roles: PlatformRole[] = ["platform_admin", "support", "accountant"];

export function TeamPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  const team = useQuery({ queryKey: ["platform", "team"], queryFn: listPlatformTeam });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PlatformRole>("support");
  const refresh = () => void client.invalidateQueries({ queryKey: ["platform", "team"] });
  const invite = useMutation({
    mutationFn: () => invitePlatformUser(email, role),
    onSuccess: refresh,
  });
  const mutation = (fn: (id: string) => Promise<unknown>) =>
    useMutation({ mutationFn: (id: string) => fn(id), onSuccess: refresh });
  const suspend = mutation(suspendPlatformUser);
  const renew = mutation(renewPlatformActivation);
  const recover = mutation(recoverPlatformTwoFactor);
  const changeRole = useMutation({
    mutationFn: ({ id, nextRole }: { id: string; nextRole: PlatformRole }) =>
      changePlatformRole(id, nextRole),
    onSuccess: refresh,
  });
  if (team.isPending)
    return (
      <section className="platform-page">
        <SectionHeader
          eyebrow="PLATFORM / ACCESS"
          title={t("team.title")}
          description={t("team.description")}
        />
        <Spinner label={t("team.loading")} />
      </section>
    );
  if (team.error)
    return (
      <section className="platform-page">
        <SectionHeader
          eyebrow="PLATFORM / ACCESS"
          title={t("team.title")}
          description={t("team.description")}
        />
        <Alert tone="error">{t("team.loadError")}</Alert>
      </section>
    );
  const canWrite = principal.capabilities.includes("platformTeam.write");
  const columns = [
    {
      key: "email",
      title: t("team.email"),
      render: (user: PlatformUser) => <strong>{user.email}</strong>,
    },
    {
      key: "role",
      title: t("team.role"),
      render: (user: PlatformUser) => (
        <Select
          aria-label={t("team.roleFor", { email: user.email })}
          value={user.role}
          disabled={!canWrite || changeRole.isPending}
          options={roles.map((item) => ({ value: item, label: t(`roles.${item}`) }))}
          onValueChange={(nextRole) => void changeRole.mutate({ id: user.id, nextRole })}
        />
      ),
    },
    {
      key: "status",
      title: t("team.status"),
      render: (user: PlatformUser) => (
        <StatusChip
          status={user.status === "active" ? "ok" : user.status === "suspended" ? "error" : "warn"}
          label={t(`team.statuses.${user.status}`)}
        />
      ),
    },
    {
      key: "actions",
      title: t("team.actions"),
      render: (user: PlatformUser) =>
        canWrite ? (
          <div className="team-row-actions">
            {user.status === "active" ? (
              <Button variant="secondary" onClick={() => void suspend.mutateAsync(user.id)}>
                {t("team.suspend")}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void renew.mutateAsync(user.id)}>
                {t("team.renew")}
              </Button>
            )}
            <Button variant="secondary" onClick={() => void recover.mutateAsync(user.id)}>
              {t("team.recover2fa")}
            </Button>
          </div>
        ) : null,
    },
  ];
  return (
    <section className="platform-page">
      <SectionHeader
        eyebrow="PLATFORM / ACCESS"
        title={t("team.title")}
        description={t("team.description")}
      />
      {canWrite ? (
        <section className="platform-action-panel" aria-labelledby="team-invite-title">
          <header>
            <span className="commerce-ledger__eyebrow">ACCESS CONTROL</span>
            <h2 id="team-invite-title">{t("team.inviteTitle")}</h2>
          </header>
          <div className="team-invite-form">
            <Input
              label={t("team.email")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Select
              label={t("team.role")}
              value={role}
              options={roles.map((item) => ({ value: item, label: t(`roles.${item}`) }))}
              onValueChange={setRole}
            />
            <Button
              loading={invite.isPending}
              disabled={!email.trim()}
              onClick={() => void invite.mutateAsync()}
            >
              {t("team.invite")}
            </Button>
          </div>
        </section>
      ) : null}
      <section className="commerce-ledger" aria-labelledby="team-ledger-title">
        <header className="commerce-ledger__header">
          <div>
            <span className="commerce-ledger__eyebrow">PLATFORM OPERATORS</span>
            <h2 id="team-ledger-title">{t("team.registryTitle")}</h2>
          </div>
          <span className="commerce-ledger__count">{team.data?.length ?? 0}</span>
        </header>
        <Table columns={columns} rows={team.data ?? []} empty={t("team.empty")} />
      </section>
    </section>
  );
}
