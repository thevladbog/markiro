import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal, Select } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useEmployees } from "../employees/api.js";
import { useCreateInvitation, type CreateInvitationInput, type TeamResponse } from "./api.js";

export function InvitationForm({
  open,
  team,
  onClose,
}: {
  open: boolean;
  team: TeamResponse;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const employees = useEmployees({ status: "active" });
  const create = useCreateInvitation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CreateInvitationInput["role"]>("manager");
  const [position, setPosition] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const claimedIds = useMemo(
    () =>
      new Set(
        [...team.members, ...team.invitations]
          .map((item) => item.employee?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    [team],
  );
  const availableEmployees = (employees.data ?? []).filter(
    (employee) => employee.status === "active" && !claimedIds.has(employee.id),
  );

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({
        email: email.trim().toLowerCase(),
        role,
        position: position.trim() || null,
        employeeId: employeeId || null,
      });
      setEmail("");
      setRole("manager");
      setPosition("");
      setEmployeeId("");
      close();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : t("pages.team.invite.genericError"),
      );
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      closeLabel={t("common.close")}
      title={t("pages.team.invite.title")}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t("pages.team.cancel")}
          </Button>
          <Button type="submit" form="team-invitation-form" loading={create.isPending}>
            {t("pages.team.invite.submit")}
          </Button>
        </>
      }
    >
      <form
        id="team-invitation-form"
        onSubmit={(event) => void submit(event)}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Input
          required
          type="email"
          autoComplete="email"
          label={t("pages.team.invite.email")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Select
          label={t("pages.team.invite.role")}
          value={role}
          onChange={(value) => setRole(value as CreateInvitationInput["role"])}
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
          onChange={setEmployeeId}
          options={[
            { value: "", label: t("pages.team.invite.noEmployee") },
            ...availableEmployees.map((employee) => ({
              value: employee.id,
              label: employee.role ? `${employee.fullName} — ${employee.role}` : employee.fullName,
            })),
          ]}
          {...(employees.isError ? { hint: t("pages.team.invite.employeeLoadError") } : {})}
        />
      </form>
    </Modal>
  );
}
