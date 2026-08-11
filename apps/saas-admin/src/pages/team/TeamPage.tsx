import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Input,
  PageHeader,
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
  if (team.isPending) return <Spinner label={t("team.loading")} />;
  if (team.error) return <Alert tone="error">{t("team.loadError")}</Alert>;
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
        <Select<PlatformRole>
          aria-label={t("team.roleFor", { email: user.email })}
          options={roles.map((item) => ({ value: item, label: t(`roles.${item}`) }))}
          value={user.role}
          disabled={!canWrite || changeRole.isPending}
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
    <section className="catalog-page">
      <PageHeader title={t("team.title")} />
      {canWrite ? (
        <Card title={t("team.inviteTitle")}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <Input
              label={t("team.email")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Select<PlatformRole>
              label={t("team.role")}
              options={roles.map((item) => ({ value: item, label: t(`roles.${item}`) }))}
              value={role}
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
        </Card>
      ) : null}
      <Table columns={columns} rows={team.data ?? []} empty={t("team.empty")} />
    </section>
  );
}
