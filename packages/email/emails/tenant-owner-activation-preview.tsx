import { TenantOwnerActivationEmail } from "../src/tenant-owner-activation.js";

export default function TenantOwnerActivationPreview() {
  return (
    <TenantOwnerActivationEmail
      recipientName="Елена Морозова"
      organizationName="Первый завод"
      actionUrl="http://localhost:5173/activate-owner#token=preview"
      expiresInMinutes={60}
    />
  );
}
