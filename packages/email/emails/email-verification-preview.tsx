import { EmailVerificationEmail } from "../src/email-verification.js";

export default function EmailVerificationPreview() {
  return (
    <EmailVerificationEmail
      recipientName="Мария Волкова"
      actionUrl="http://localhost:5173/verify-email?token=preview"
      expiresInMinutes={60}
    />
  );
}
