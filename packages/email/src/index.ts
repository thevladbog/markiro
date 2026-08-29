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
import {
  LandingDemoNotificationEmail,
  type LandingDemoNotificationEmailProps,
} from "./landing-demo-notification.js";
import {
  LandingDemoConfirmationEmail,
  type LandingDemoConfirmationEmailProps,
} from "./landing-demo-confirmation.js";
import {
  boundedBillingSubjectName,
  TenantBillingNotificationEmail,
  tenantBillingNotificationSubject,
  type TenantBillingNotificationEmailProps,
} from "./tenant-billing-notification.js";

export type EmailTemplateInput =
  | ({ kind: "organization-invitation" } & OrganizationInvitationEmailProps)
  | ({ kind: "password-reset" } & PasswordResetEmailProps)
  | ({ kind: "tenant-owner-activation" } & TenantOwnerActivationEmailProps)
  | ({ kind: "platform-user-activation" } & PlatformUserActivationEmailProps)
  | ({ kind: "landing-demo-notification" } & LandingDemoNotificationEmailProps)
  | ({ kind: "landing-demo-confirmation" } & LandingDemoConfirmationEmailProps)
  | ({ kind: "tenant-billing-notification" } & TenantBillingNotificationEmailProps)
  | ({ kind: "email-verification" } & EmailVerificationEmailProps);

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export async function renderEmail(input: EmailTemplateInput): Promise<RenderedEmail> {
  const { subject, element, replyTo } = resolveTemplate(input);
  const html = await render(element);
  return {
    subject,
    html,
    text: toPlainText(html),
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

function resolveTemplate(input: EmailTemplateInput): {
  subject: string;
  element: ReactElement;
  replyTo?: string;
} {
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
    case "landing-demo-notification": {
      return {
        subject: "Новая заявка с markiro.app — Маркиро",
        replyTo: input.email,
        element: createElement(LandingDemoNotificationEmail, {
          locale: input.locale,
          requestId: input.requestId,
          receivedAt: input.receivedAt,
          sourcePath: input.sourcePath,
          consentVersion: input.consentVersion,
          recipientName: input.recipientName,
          company: input.company,
          email: input.email,
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
        }),
      };
    }
    case "landing-demo-confirmation": {
      return {
        subject:
          input.locale === "ru"
            ? "Мы получили вашу заявку — Маркиро"
            : "We received your request — Markiro",
        replyTo: input.contactEmail,
        element: createElement(LandingDemoConfirmationEmail, {
          locale: input.locale,
          requestId: input.requestId,
          recipientName: input.recipientName,
          company: input.company,
          email: input.email,
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          contactEmail: input.contactEmail,
        }),
      };
    }
    case "tenant-billing-notification": {
      const subjectName = boundedBillingSubjectName(input.subjectName);
      return {
        subject: tenantBillingNotificationSubject(input.locale, input.eventKind, subjectName),
        element: createElement(TenantBillingNotificationEmail, {
          locale: input.locale,
          recipientName: input.recipientName,
          organizationName: input.organizationName,
          eventKind: input.eventKind,
          subjectName,
          actionUrl: input.actionUrl,
        }),
      };
    }
  }
}

export type {
  EmailVerificationEmailProps,
  LandingDemoConfirmationEmailProps,
  LandingDemoNotificationEmailProps,
  OrganizationInvitationEmailProps,
  PasswordResetEmailProps,
  PlatformUserActivationEmailProps,
  TenantBillingNotificationEmailProps,
  TenantOwnerActivationEmailProps,
};
export type { LandingLocale } from "./landing-demo-notification.js";
export type { TenantBillingEventKind } from "./tenant-billing-notification.js";
export { TENANT_BILLING_EVENT_KINDS } from "./tenant-billing-notification.js";
