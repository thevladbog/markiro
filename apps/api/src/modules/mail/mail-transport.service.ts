import * as nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { RenderedEmail } from "@markiro/email";
import type { Env } from "../../env";
import type { MailHealth, MailTransport } from "./mail.types";

type SmtpEnv = Pick<
  Env,
  | "NODE_ENV"
  | "SMTP_HOST"
  | "SMTP_PORT"
  | "SMTP_SECURE"
  | "SMTP_USER"
  | "SMTP_PASSWORD"
  | "SMTP_FROM_EMAIL"
  | "SMTP_FROM_NAME"
  | "SMTP_REPLY_TO"
>;

@Injectable()
export class MailTransportService implements MailTransport, OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(MailTransportService.name);
  readonly #transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;
  #health: MailHealth = { status: "unknown" };

  constructor(private readonly env: SmtpEnv) {
    this.#transporter = nodemailer.createTransport(buildSmtpOptions(env));
  }

  onModuleInit(): void {
    if (this.env.NODE_ENV !== "test") void this.verify();
  }

  onModuleDestroy(): void {
    this.#transporter.close();
  }

  get health(): MailHealth {
    return this.#health;
  }

  async verify(): Promise<boolean> {
    try {
      await this.#transporter.verify();
      this.#health = { status: "healthy", checkedAt: new Date() };
      return true;
    } catch {
      this.#health = {
        status: "degraded",
        checkedAt: new Date(),
        category: "smtp_unavailable",
      };
      this.#logger.warn("SMTP verification failed; mail health is degraded");
      return false;
    }
  }

  async send(rendered: RenderedEmail, recipient: string): Promise<void> {
    await this.#transporter.sendMail({
      from: { name: this.env.SMTP_FROM_NAME, address: this.env.SMTP_FROM_EMAIL },
      to: recipient,
      ...(this.env.SMTP_REPLY_TO ? { replyTo: this.env.SMTP_REPLY_TO } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }
}

export function buildSmtpOptions(env: SmtpEnv): SMTPTransport.Options {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: env.NODE_ENV === "production" && !env.SMTP_SECURE,
    ...(env.SMTP_USER && env.SMTP_PASSWORD
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
    tls: { rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}
