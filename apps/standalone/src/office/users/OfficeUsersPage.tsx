import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  Card,
  PageHeader,
  RowActions,
  StatusChip,
  type TableColumn,
} from "@markiro/ui";

import { PagedTable } from "../paging/PagedTable.js";
import type { OfficeUserRecord } from "../../host/protocol.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import { CreateUserDialog } from "./CreateUserDialog.js";
import { EditUserDialog } from "./EditUserDialog.js";
import { SetPasswordDialog } from "./SetPasswordDialog.js";

type UsersDialog =
  | { kind: "create" }
  | { kind: "edit"; user: OfficeUserRecord }
  | { kind: "password"; user: OfficeUserRecord };

/** The host's order: `ORDER BY login COLLATE NOCASE` (ASCII case folded, then bytes). */
function byLogin(a: OfficeUserRecord, b: OfficeUserRecord): number {
  const left = a.login.toLowerCase();
  const right = b.login.toLowerCase();
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Replace or add `user`, keeping the host's order (by login, case-insensitive). */
function withUser(list: readonly OfficeUserRecord[], user: OfficeUserRecord): OfficeUserRecord[] {
  return [...list.filter((each) => each.id !== user.id), user].sort(byLogin);
}

/** Office users (spec §4.8, administrators only; the route is wrapped in `RequireRole`). */
export function OfficeUsersPage() {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const queryClient = useQueryClient();
  const users = useOfficeQuery(officeKeys.users, (api, token) => api.listUsers(token));
  const [dialog, setDialog] = useState<UsersDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: UsersDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const store = (user: OfficeUserRecord) => {
    const list = queryClient.getQueryData<OfficeUserRecord[]>(officeKeys.users);
    if (list) {
      queryClient.setQueryData(officeKeys.users, withUser(list, user));
    } else {
      // No loaded list to update: read the whole list again rather than show one row.
      void queryClient.invalidateQueries({ queryKey: officeKeys.users });
    }
  };

  const columns: TableColumn<OfficeUserRecord>[] = [
    {
      key: "login",
      title: t("office.users.table.login"),
      mono: true,
      render: (user) => user.login,
    },
    {
      key: "name",
      title: t("office.users.table.name"),
      render: (user) => (
        <>
          {user.name}
          {user.id === session.user.id && (
            <>
              {" "}
              <Badge tone="info">{t("office.users.you")}</Badge>
            </>
          )}
        </>
      ),
    },
    {
      key: "role",
      title: t("office.users.table.role"),
      render: (user) => t(`office.users.roles.${user.role}`),
    },
    {
      key: "status",
      title: t("office.users.table.status"),
      render: (user) => (
        <StatusChip
          phase={user.active ? "active" : "retired"}
          label={t(user.active ? "office.users.status.active" : "office.users.status.inactive")}
        />
      ),
    },
    {
      key: "actions",
      stickyEnd: true,
      title: t("office.users.table.actions"),
      render: (user) => (
        <RowActions>
          <Button
            variant="secondary"
            size="compact"
            aria-label={t("office.users.editNamed", { login: user.login })}
            onClick={() => open({ kind: "edit", user })}
          >
            {t("office.users.edit")}
          </Button>
          {user.id !== session.user.id && (
            <Button
              variant="secondary"
              size="compact"
              aria-label={t("office.users.passwordNamed", { login: user.login })}
              onClick={() => open({ kind: "password", user })}
            >
              {t("office.users.password")}
            </Button>
          )}
        </RowActions>
      ),
    },
  ];

  const content = () => {
    if (users.isPending) return <PageLoading />;
    if (users.isError)
      return <LoadError error={users.error} onRetry={() => void users.refetch()} />;
    return (
      <Card>
        <PagedTable
          tableId="users"
          columns={columns}
          rows={users.data}
          getRowKey={(user) => user.id}
          empty={t("office.users.empty")}
          scrollLabel={t("office.users.title")}
        />
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title={t("office.users.title")}
        actions={<Button onClick={() => open({ kind: "create" })}>{t("office.users.add")}</Button>}
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      {content()}
      {dialog?.kind === "create" && (
        <CreateUserDialog
          onClose={() => setDialog(null)}
          onCreated={(user) => {
            store(user);
            setDialog(null);
            setNotice(t("office.users.created", { login: user.login }));
          }}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditUserDialog
          user={dialog.user}
          own={dialog.user.id === session.user.id}
          onClose={() => setDialog(null)}
          onSaved={(user) => {
            store(user);
            setDialog(null);
            setNotice(t("office.common.saved"));
            // The header shows the signed-in user's own name.
            if (user.id === session.user.id) void session.refreshUser().catch(() => undefined);
          }}
          onReload={() => {
            setDialog(null);
            void users.refetch();
          }}
        />
      )}
      {dialog?.kind === "password" && (
        <SetPasswordDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onChanged={() => {
            setDialog(null);
            setNotice(t("office.users.passwordSet", { login: dialog.user.login }));
          }}
        />
      )}
    </>
  );
}
