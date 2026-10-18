import { useTranslation } from "react-i18next";

import { RadioGroup } from "@markiro/ui";

import { officeRoleSchema, type OfficeRole } from "../../host/protocol.js";

export interface RoleRadiosProps {
  value: OfficeRole;
  onChange: (role: OfficeRole) => void;
  disabled: boolean;
  /** Why the role cannot change, when it cannot. */
  hint: string | null;
}

export function RoleRadios({ value, onChange, disabled, hint }: RoleRadiosProps) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      label={t("office.users.fields.role")}
      options={[
        { value: "technologist", label: t("office.users.roles.technologist") },
        { value: "admin", label: t("office.users.roles.admin") },
      ]}
      value={value}
      onValueChange={(next) => {
        const role = officeRoleSchema.safeParse(next);
        if (role.success) onChange(role.data);
      }}
      disabled={disabled}
      {...(hint === null ? {} : { hint })}
    />
  );
}
