import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  EmptyState,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useAuthClient } from "../../auth/client.js";
import { InvitationForm } from "./InvitationForm.js";
import { MemberActions } from "./MemberActions.js";
import {
  useCancelInvitation,
  useResendInvitation,
  useTeam,
  type TeamInvitation,
  type TeamEmployee,
  type TeamMember,
  type TeamResponse,
} from "./api.js";

const DELIVERY_TONE: Record<string, StatusChipStatus> = {
  queued: "info",
  sending: "info",
  sent: "ok",
  delivered: "ok",
  failed: "error",
  canceled: "neutral",
};

export function TeamPage() {
  const { t } = useTranslation();
  const auth = useAuthClient();
  const { data: session } = auth.useSession();
  const team = useTeam();
  const [inviting, setInviting] = useState(false);

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <PageHeader
        title={t("pages.team.title")}
        actions={<Button onClick={() => setInviting(true)}>{t("pages.team.inviteAction")}</Button>}
      />
      {team.isPending ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      ) : team.isError ? (
        <Alert tone="error">{t("pages.team.loadError")}</Alert>
      ) : (
        <TeamContent team={team.data} currentUserId={session?.user.id ?? ""} />
      )}
      {team.data ? (
        <InvitationForm open={inviting} team={team.data} onClose={() => setInviting(false)} />
      ) : null}
    </div>
  );
}

function TeamContent({ team, currentUserId }: { team: TeamResponse; currentUserId: string }) {
  const { t } = useTranslation();
  const memberColumns: TableColumn<TeamMember>[] = useMemo(
    () => [
      {
        key: "person",
        title: t("pages.team.table.person"),
        render: (member) => <PersonCell member={member} />,
      },
      {
        key: "role",
        title: t("pages.team.table.role"),
        render: (member) => t(`pages.team.roles.${member.role}`, { defaultValue: member.role }),
      },
      {
        key: "position",
        title: t("pages.team.table.position"),
        render: (member) => member.position ?? "—",
      },
      {
        key: "operator",
        title: t("pages.team.table.operator"),
        render: (member) => <EmployeeCell employee={member.employee} />,
      },
      {
        key: "actions",
        title: t("pages.team.table.actions"),
        align: "right",
        render: (member) =>
          member.userId === currentUserId || member.role === "owner" ? null : (
            <MemberActions member={member} team={team} />
          ),
      },
    ],
    [currentUserId, t, team],
  );

  const invitationColumns: TableColumn<TeamInvitation>[] = useMemo(
    () => [
      { key: "email", title: t("pages.team.table.email") },
      {
        key: "role",
        title: t("pages.team.table.role"),
        render: (invitation) =>
          t(`pages.team.roles.${invitation.role ?? "manager"}`, {
            defaultValue: invitation.role ?? "—",
          }),
      },
      {
        key: "position",
        title: t("pages.team.table.position"),
        render: (invitation) => invitation.position ?? "—",
      },
      {
        key: "access",
        title: t("pages.team.table.access"),
        render: (invitation) => (
          <StatusChip
            status={invitation.accessStatus === "pending" ? "info" : "neutral"}
            label={t(`pages.team.access.${invitation.accessStatus}`, {
              defaultValue: invitation.accessStatus,
            })}
          />
        ),
      },
      {
        key: "operator",
        title: t("pages.team.table.operator"),
        render: (invitation) => <EmployeeCell employee={invitation.employee} />,
      },
      {
        key: "delivery",
        title: t("pages.team.table.delivery"),
        render: (invitation) => (
          <StatusChip
            status={DELIVERY_TONE[invitation.delivery?.status ?? ""] ?? "neutral"}
            label={t(`pages.team.delivery.${invitation.delivery?.status ?? "none"}`, {
              defaultValue: invitation.delivery?.status ?? "—",
            })}
          />
        ),
      },
      {
        key: "actions",
        title: t("pages.team.table.actions"),
        align: "right",
        render: (invitation) => <InvitationActions invitation={invitation} />,
      },
    ],
    [t],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card title={t("pages.team.membersTitle")} padding={0}>
        {team.members.length ? (
          <Table columns={memberColumns} rows={team.members} />
        ) : (
          <EmptyState title={t("pages.team.emptyTitle")} hint={t("pages.team.emptyHint")} />
        )}
      </Card>
      <Card title={t("pages.team.invitationsTitle")} padding={0}>
        {team.invitations.length ? (
          <Table columns={invitationColumns} rows={team.invitations} />
        ) : (
          <EmptyState
            title={t("pages.team.noInvitationsTitle")}
            hint={t("pages.team.noInvitationsHint")}
          />
        )}
      </Card>
    </div>
  );
}

function PersonCell({ member }: { member: TeamMember }) {
  const { t } = useTranslation();
  const name = [member.firstName, member.middleName, member.lastName].filter(Boolean).join(" ");
  const displayName = name || member.email;
  const initials = [member.firstName, member.lastName]
    .filter(Boolean)
    .map((part) => part?.[0])
    .join("")
    .toUpperCase();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        aria-label={member.avatarAssetId ? "avatar" : undefined}
        style={{
          width: 32,
          height: 32,
          borderRadius: "var(--r-2)",
          background: member.avatarAssetId ? "var(--accent-module)" : "var(--surface-inverse)",
          color: "var(--fg-on-inverse)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          font: "600 12px/1 var(--font-ui)",
        }}
      >
        {initials || "?"}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ color: "var(--fg-1)", font: "600 13px/17px var(--font-ui)" }}>
          {displayName}
        </span>
        {member.avatarAssetId ? (
          <span style={{ color: "var(--fg-3)", font: "var(--text-body-sm)" }}>
            {t("pages.team.photoUploaded")}
          </span>
        ) : null}
        <span style={{ color: "var(--fg-3)", font: "var(--text-body-sm)" }}>{member.email}</span>
      </span>
    </div>
  );
}

function EmployeeCell({ employee }: { employee: TeamEmployee | null }) {
  const { t } = useTranslation();
  if (!employee) return "—";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <span>{t("pages.team.operator.employee", { name: employee.fullName })}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <StatusChip
          status={employee.status === "active" ? "ok" : "neutral"}
          label={t(`pages.team.employeeStatus.${employee.status}`)}
        />
        <StatusChip
          status={employee.operatorAccess ? "ok" : "neutral"}
          label={
            employee.operatorAccess
              ? t("pages.team.operator.enabled")
              : t("pages.team.operator.disabled")
          }
        />
      </div>
    </div>
  );
}

function InvitationActions({ invitation }: { invitation: TeamInvitation }) {
  const { t } = useTranslation();
  const resend = useResendInvitation();
  const cancel = useCancelInvitation();
  const [error, setError] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  if (invitation.accessStatus !== "pending") {
    return (
      <StatusChip
        status="neutral"
        label={t("pages.team.actionsUnavailable")}
        title={t("pages.team.actionsUnavailableHint")}
      />
    );
  }

  const run = async (action: "resend" | "cancel") => {
    setError(null);
    try {
      if (action === "resend") await resend.mutateAsync(invitation.id);
      else {
        await cancel.mutateAsync(invitation.id);
        setConfirmingCancel(false);
      }
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : t("pages.team.actionError"));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          size="compact"
          variant="secondary"
          loading={resend.isPending}
          onClick={() => void run("resend")}
        >
          {t("pages.team.resend")}
        </Button>
        <Button
          size="compact"
          variant="destructive"
          loading={cancel.isPending}
          onClick={() => setConfirmingCancel(true)}
        >
          {t("pages.team.cancelInvitation")}
        </Button>
      </div>
      {error ? (
        <span style={{ color: "var(--err-fg)", font: "var(--text-body-sm)" }}>{error}</span>
      ) : null}
      <Modal
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        closeLabel={t("common.close")}
        title={t("pages.team.cancelConfirmTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingCancel(false)}>
              {t("pages.team.cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={cancel.isPending}
              onClick={() => void run("cancel")}
            >
              {t("pages.team.cancelInvitation")}
            </Button>
          </>
        }
      >
        {t("pages.team.cancelConfirmBody", { email: invitation.email })}
      </Modal>
    </div>
  );
}
