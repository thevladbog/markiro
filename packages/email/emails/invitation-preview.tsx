import { OrganizationInvitationEmail } from "../src/invitation.js";

export default function InvitationPreview() {
  return (
    <OrganizationInvitationEmail
      recipientName="Алексей Петров"
      organizationName="Молочный завод № 1"
      inviterName="Ирина Соколова"
      actionUrl="http://localhost:5173/invitations/demo"
      expiresAt={new Date("2026-08-10T00:00:00Z")}
    />
  );
}
