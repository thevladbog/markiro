import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";

export const organizationAccessControl = createAccessControl({
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
});

export const organizationRoles = {
  owner: organizationAccessControl.newRole({
    ...ownerAc.statements,
    apiKey: ["create", "read", "update", "delete"],
  }),
  admin: organizationAccessControl.newRole({
    ...memberAc.statements,
    invitation: ["create", "cancel"],
    member: ["create", "update", "delete"],
    apiKey: ["create"],
  }),
  manager: organizationAccessControl.newRole({
    ...memberAc.statements,
    apiKey: [],
  }),
  member: organizationAccessControl.newRole({
    ...memberAc.statements,
    apiKey: [],
  }),
};
