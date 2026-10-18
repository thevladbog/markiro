import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  PageHeader,
  StatusChip,
  type TableColumn,
} from "@markiro/ui";

import { canDeleteAvatar } from "../avatar/avatar-rules.js";
import { listViewState } from "../list/list-state.js";
import { ListCard } from "../list/ListCard.js";
import { ListEmpty, ListError, ListSkeleton } from "../list/ListStates.js";
import { RowActionBar } from "../list/RowActionBar.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { PagedTable } from "../paging/PagedTable.js";
import type { OfficeUserRecord } from "../../host/protocol.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { WriteFailureAlert } from "../page-state.js";
import { UserAvatar } from "../UserAvatar.js";
import { CreateUserDialog } from "./CreateUserDialog.js";
import { EditUserDialog } from "./EditUserDialog.js";
import { SetPasswordDialog } from "./SetPasswordDialog.js";

type UsersDialog =
  | { kind: "create" }
  | { kind: "edit"; user: OfficeUserRecord }
  | { kind: "password"; user: OfficeUserRecord }
  | { kind: "removePhoto"; user: OfficeUserRecord };

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
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const clearPhoto = useOfficeMutation((api, token, userId: string) =>
    api.deleteUserAvatar(token, userId),
  );

  const open = (next: UsersDialog) => {
    setNotice(null);
    setFailure(null);
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

  const removePhoto = async (user: OfficeUserRecord) => {
    setDialog(null);
    try {
      await clearPhoto.mutateAsync(user.id);
      void queryClient.invalidateQueries({ queryKey: officeKeys.users, exact: true });
      setNotice(t("office.users.photoRemoved", { login: user.login }));
      // The header shows the signed-in user's own photo.
      if (user.id === session.user.id) void session.refreshUser().catch(() => undefined);
    } catch (error) {
      setFailure(alertFailure(error));
    }
  };

  const columns: TableColumn<OfficeUserRecord>[] = [
    {
      key: "user",
      title: t("office.users.table.user"),
      wrap: true,
      minWidth: 260,
      render: (user) => (
        <span className="user-cell">
          <UserAvatar
            name={user.name}
            size={40}
            userId={user.id}
            avatarVersion={user.avatarVersion}
            label={t("office.profile.photo.label", { name: user.name })}
          />
          <span className="user-cell__text">
            <span className="user-cell__name">
              {user.name}
              {user.id === session.user.id && (
                <>
                  {" "}
                  <Badge tone="info">{t("office.users.you")}</Badge>
                </>
              )}
            </span>
            <span className="user-cell__login">{user.login}</span>
          </span>
        </span>
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
        <RowActionBar
          actions={[
            {
              key: "edit",
              label: t("office.users.editNamed", { login: user.login }),
              icon: "pencil",
              onSelect: () => open({ kind: "edit", user }),
            },
          ]}
          menu={{
            label: t("office.common.rowActions", { name: user.login }),
            items: [
              ...(user.id !== session.user.id
                ? [
                    {
                      key: "password",
                      label: t("office.users.password"),
                      ariaLabel: t("office.users.passwordNamed", { login: user.login }),
                      icon: "key" as const,
                      onSelect: () => open({ kind: "password", user }),
                    },
                  ]
                : []),
              // An administrator takes any photo down (never replaces it: the owner alone does).
              ...(canDeleteAvatar(session.user, user.id, user.avatarVersion != null)
                ? [
                    {
                      key: "photo",
                      label: t("office.users.photoRemove"),
                      ariaLabel: t("office.users.photoRemoveNamed", { login: user.login }),
                      icon: "trash" as const,
                      destructive: true,
                      onSelect: () => open({ kind: "removePhoto", user }),
                    },
                  ]
                : []),
            ],
          }}
        />
      ),
    },
  ];

  const view = listViewState({
    pending: users.isPending,
    failed: users.isError,
    total: users.data?.length ?? 0,
    found: users.data?.length ?? 0,
  });
  const state =
    view === "loading" ? (
      <ListSkeleton />
    ) : view === "error" ? (
      <ListError error={users.error} onRetry={() => void users.refetch()} />
    ) : view === "empty" ? (
      <ListEmpty icon="users" title={t("office.users.empty")} />
    ) : null;
  const content = () => (
    <ListCard>
      <PagedTable
        tableId="users"
        columns={columns}
        rows={view === "error" ? [] : (users.data ?? [])}
        getRowKey={(user) => user.id}
        empty={state}
        scrollLabel={t("office.users.title")}
      />
    </ListCard>
  );

  return (
    <>
      <PageHeader
        title={t("office.users.title")}
        actions={
          <Button
            icon={<OfficeIcon name="plus" size={20} />}
            onClick={() => open({ kind: "create" })}
          >
            {t("office.users.add")}
          </Button>
        }
      />
      {notice && <Alert tone="ok">{notice}</Alert>}
      <WriteFailureAlert failure={failure} />
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
      {dialog?.kind === "removePhoto" && (
        <ConfirmDialog
          open
          title={t("office.users.photoRemoveTitle", { login: dialog.user.login })}
          description={t("office.users.photoRemoveBody")}
          confirmLabel={t("office.users.photoRemove")}
          cancelLabel={t("office.common.cancel")}
          tone="destructive"
          onConfirm={() => void removePhoto(dialog.user)}
          onCancel={() => setDialog(null)}
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
