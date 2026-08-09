import { createElement, type ReactElement } from "react";
import { render, toPlainText } from "react-email";
import { EmailVerificationEmail, type EmailVerificationEmailProps } from "./email-verification.js";
import {
  OrganizationInvitationEmail,
  type OrganizationInvitationEmailProps,
} from "./invitation.js";
import { PasswordResetEmail, type PasswordResetEmailProps } from "./password-reset.js";
import {
  TenantOwnerActivationEmail,
  type TenantOwnerActivationEmailProps,
} from "./tenant-owner-activation.js";
import {
  PlatformUserActivationEmail,
  type PlatformUserActivationEmailProps,
} from "./emails/platform-user-activation.js";

export type EmailTemplateInput =
  | ({ kind: "organization-invitation" } & OrganizationInvitationEmailProps)
  | ({ kind: "password-reset" } & PasswordResetEmailProps)
  | ({ kind: "tenant-owner-activation" } & TenantOwnerActivationEmailProps)
  | ({ kind: "platform-user-activation" } & PlatformUserActivationEmailProps)
  | ({ kind: "email-verification" } & EmailVerificationEmailProps);

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail(input: EmailTemplateInput): Promise<RenderedEmail> {
  const { subject, element } = resolveTemplate(input);
  const html = await render(element);
  return { subject, html, text: toPlainText(html) };
}

function resolveTemplate(input: EmailTemplateInput): { subject: string; element: ReactElement } {
  switch (input.kind) {
    case "organization-invitation": {
      return {
        subject: "Приглашение в " + input.organizationName + " — Маркиро",
        element: createElement(OrganizationInvitationEmail, {
          recipientName: input.recipientName,
          organizationName: input.organizationName,
          inviterName: input.inviterName,
          actionUrl: input.actionUrl,
          expiresAt: input.expiresAt,
        }),
      };
    }
    case "password-reset": {
      return {
        subject: "Восстановление пароля — Маркиро",
        element: createElement(PasswordResetEmail, {
          recipientName: input.recipientName,
          actionUrl: input.actionUrl,
          expiresInMinutes: input.expiresInMinutes,
        }),
      };
    }
    case "tenant-owner-activation": {
      return {
        subject: "Доступ к " + input.organizationName + " — Маркиро",
        element: createElement(TenantOwnerActivationEmail, {
          recipientName: input.recipientName,
          organizationName: input.organizationName,
          actionUrl: input.actionUrl,
          expiresInMinutes: input.expiresInMinutes,
        }),
      };
    }
    case "email-verification": {
      return {
        subject: "Подтвердите email — Маркиро",
        element: createElement(EmailVerificationEmail, {
          recipientName: input.recipientName,
          actionUrl: input.actionUrl,
          expiresInMinutes: input.expiresInMinutes,
        }),
      };
    }
    case "platform-user-activation": {
      return {
        subject: "Доступ к платформе Маркиро",
        element: createElement(PlatformUserActivationEmail, {
          recipientName: input.recipientName,
          actionUrl: input.actionUrl,
          expiresInMinutes: input.expiresInMinutes,
        }),
      };
    }
  }
}

export type {
  EmailVerificationEmailProps,
  OrganizationInvitationEmailProps,
  PasswordResetEmailProps,
  PlatformUserActivationEmailProps,
  TenantOwnerActivationEmailProps,
};
