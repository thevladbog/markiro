import { PasswordResetEmail } from "../src/password-reset.js";

export default function PasswordResetPreview() {
  return (
    <PasswordResetEmail
      recipientName="Алексей Петров"
      actionUrl="http://localhost:5173/reset-password?token=preview"
      expiresInMinutes={30}
    />
  );
}
