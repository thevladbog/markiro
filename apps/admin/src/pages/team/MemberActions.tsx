import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal, Select } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useEmployees } from "../employees/api.js";
import {
  useLinkEmployee,
  useRemoveMember,
  useUnlinkEmployee,
  useUpdateMember,
  type TeamMember,
  type TeamResponse,
  type TeamRole,
} from "./api.js";

export function MemberActions({ member, team }: { member: TeamMember; team: TeamResponse }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [role, setRole] = useState<TeamRole>(member.role === "admin" ? "admin" : "manager");
  const [position, setPosition] = useState(member.position ?? "");
  const [employeeId, setEmployeeId] = useState(member.employee?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const employees = useEmployees({ status: "active" });
  const update = useUpdateMember();
  const link = useLinkEmployee();
  const unlink = useUnlinkEmployee();
  const remove = useRemoveMember();

  const available = useMemo(() => {
    const claimed = new Set(
      [...team.members, ...team.invitations]
        .filter((item) => !("userId" in item && item.id === member.id))
        .map((item) => item.employee?.id)
        .filter((id): id is string => Boolean(id)),
    );
    return (employees.data ?? []).filter((employee) => !claimed.has(employee.id));
  }, [employees.data, member.id, team]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({
        id: member.id,
        input: { role, position: position.trim() || null },
      });
      if (employeeId !== (member.employee?.id ?? "")) {
        if (employeeId) await link.mutateAsync({ id: member.id, employeeId });
        else await unlink.mutateAsync(member.id);
      }
      setEditing(false);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : t("pages.team.member.saveError"),
      );
    }
  };

  const confirmRemove = async () => {
    setError(null);
    try {
      await remove.mutateAsync(member.id);
      setRemoving(false);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : t("pages.team.member.removeError"),
      );
    }
  };

  const fullName = [member.firstName, member.middleName, member.lastName].filter(Boolean).join(" ");
  const busy = update.isPending || link.isPending || unlink.isPending;

  const openEdit = () => {
    setRole(member.role === "admin" ? "admin" : "manager");
    setPosition(member.position ?? "");
    setEmployeeId(member.employee?.id ?? "");
    setError(null);
    setEditing(true);
  };

  const openRemove = () => {
    setError(null);
    setRemoving(true);
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button
          size="compact"
          variant="secondary"
          aria-label={t("pages.team.member.editNamed", { name: fullName || member.email })}
          onClick={openEdit}
        >
          {t("pages.team.member.edit")}
        </Button>
        <Button
          size="compact"
          variant="destructive"
          aria-label={t("pages.team.member.removeNamed", { name: fullName || member.email })}
          onClick={openRemove}
        >
          {t("pages.team.member.remove")}
        </Button>
      </div>
      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        closeLabel={t("common.close")}
        title={t("pages.team.member.editTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              {t("pages.team.cancel")}
            </Button>
            <Button type="submit" form={`member-${member.id}`} loading={busy}>
              {t("pages.team.member.save")}
            </Button>
          </>
        }
      >
        <form
          id={`member-${member.id}`}
          onSubmit={(event) => void submit(event)}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Select
            label={t("pages.team.invite.role")}
            value={role}
            onValueChange={(value) => setRole(value as TeamRole)}
            options={[
              { value: "manager", label: t("pages.team.roles.manager") },
              { value: "admin", label: t("pages.team.roles.admin") },
            ]}
          />
          <Input
            label={t("pages.team.invite.position")}
            value={position}
            maxLength={120}
            onChange={(event) => setPosition(event.target.value)}
          />
          <Select
            label={t("pages.team.invite.employee")}
            value={employeeId}
            disabled={employees.isPending || employees.isError}
            onValueChange={setEmployeeId}
            options={[
              { value: "", label: t("pages.team.invite.noEmployee") },
              ...available.map((employee) => ({ value: employee.id, label: employee.fullName })),
            ]}
            {...(employees.isError ? { hint: t("pages.team.invite.employeeLoadError") } : {})}
          />
        </form>
      </Modal>
      <Modal
        open={removing}
        onClose={() => setRemoving(false)}
        closeLabel={t("common.close")}
        title={t("pages.team.member.removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(false)}>
              {t("pages.team.cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => void confirmRemove()}
            >
              {t("pages.team.member.remove")}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <span>{t("pages.team.member.removeBody", { name: fullName || member.email })}</span>
        </div>
      </Modal>
    </>
  );
}
