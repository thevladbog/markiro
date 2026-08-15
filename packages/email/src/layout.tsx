import type { ReactNode } from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";

interface EmailLayoutProps {
  locale?: EmailLocale;
  preview: string;
  eyebrow?: string;
  heading: string;
  footer?: string;
  children: ReactNode;
}

export type EmailLocale = "ru" | "en";

const palette = {
  ink: "#17161a",
  paper: "#fafaf8",
  white: "#ffffff",
  panel: "#f0efea",
  line: "#e0ded7",
  muted: "#6b6862",
  accent: "#0faf56",
  accentModule: "#3ddc7a",
} as const;

const fontSans = '"IBM Plex Sans", Arial, Helvetica, sans-serif';
const fontMono = '"IBM Plex Mono", "Courier New", monospace';

const logoRows = [
  ["ink", null, "ink"],
  [null, "ink", null],
  ["ink", null, "ink"],
  ["ink", null, "ink"],
  [null, "accent", null],
] as const;

const responsiveStyles = `
  @media (max-width: 480px) {
    .mk-email-hero { padding-left: 24px !important; padding-right: 24px !important; }
    .mk-email-content { padding-left: 24px !important; padding-right: 24px !important; }
    .mk-email-footer { padding-left: 24px !important; padding-right: 24px !important; }
  }
`;

const localizedShell = {
  ru: {
    brandLabel: "Маркиро",
    wordmark: "маркиро",
    eyebrow: "Маркиро",
    footer:
      "Это автоматическое письмо от Маркиро. Если вы не запрашивали это действие, письмо можно удалить.",
    signature: "МАРКИРО · ПРОИЗВОДСТВО И МАРКИРОВКА",
  },
  en: {
    brandLabel: "Markiro",
    wordmark: "MARKIRO",
    eyebrow: "Markiro",
    footer:
      "This is an automated email from Markiro. If you did not request this action, you can delete this message.",
    signature: "MARKIRO · MANUFACTURING AND LABELLING",
  },
} as const;

function EmailBrand({ locale }: { locale: EmailLocale }) {
  const copy = localizedShell[locale];
  return (
    <table aria-label={copy.brandLabel} role="img" cellPadding="0" cellSpacing="0">
      <tbody>
        <tr>
          <td style={styles.markCell}>
            <table role="presentation" cellPadding="0" cellSpacing="2">
              <tbody>
                {logoRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((module, columnIndex) => (
                      <td
                        key={columnIndex}
                        {...(module ? { "data-markiro-module": "true" } : {})}
                        style={{
                          backgroundColor:
                            module === "accent"
                              ? palette.accentModule
                              : module === "ink"
                                ? palette.ink
                                : "transparent",
                          fontSize: "0",
                          height: "5px",
                          lineHeight: "5px",
                          width: "5px",
                        }}
                      >
                        &nbsp;
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
          <td style={styles.wordmark}>{copy.wordmark}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function EmailLayout({
  locale = "ru",
  preview,
  eyebrow,
  heading,
  footer,
  children,
}: EmailLayoutProps) {
  const copy = localizedShell[locale];
  return (
    <Html lang={locale}>
      <Head>
        <style>{responsiveStyles}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section className="mk-email-hero" style={styles.hero}>
            <EmailBrand locale={locale} />
            <Text style={styles.eyebrow}>{eyebrow ?? copy.eyebrow}</Text>
            <Heading style={styles.heading}>{heading}</Heading>
          </Section>
          <Section className="mk-email-content" style={styles.content}>
            {children}
          </Section>
          <Section className="mk-email-footer" style={styles.footer}>
            <Text style={styles.footerText}>{footer ?? copy.footer}</Text>
            <Text style={styles.footerSignature}>{copy.signature}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function EmailAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={styles.actionSection}>
      <Button href={href} style={styles.button}>
        {children}
      </Button>
    </Section>
  );
}

export function EmailExpiryNotice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Section aria-label="Срок действия ссылки" style={styles.expiryNotice}>
      <Text style={styles.expiryLabel}>{label}</Text>
      <Text style={styles.expiryText}>{children}</Text>
    </Section>
  );
}

export function EmailFallbackLink({ actionUrl }: { actionUrl: string }) {
  return (
    <Section style={styles.fallbackSection}>
      <Text style={styles.fallbackLabel}>Если кнопка не работает, скопируйте ссылку:</Text>
      <Link href={actionUrl} style={styles.fallbackLink}>
        {actionUrl}
      </Link>
    </Section>
  );
}

export const emailStyles = {
  greeting: {
    color: palette.ink,
    fontSize: "16px",
    fontWeight: "600",
    lineHeight: "24px",
    margin: 0,
  },
  paragraph: {
    color: "#45433e",
    fontSize: "16px",
    lineHeight: "26px",
    margin: "18px 0 0",
  },
  actionSection: {
    margin: "30px 0 0",
  },
  button: {
    backgroundColor: palette.accent,
    borderRadius: "4px",
    boxSizing: "border-box" as const,
    color: palette.white,
    display: "block",
    fontSize: "15px",
    fontWeight: "600",
    lineHeight: "20px",
    padding: "15px 18px",
    textAlign: "center" as const,
    textDecoration: "none",
    width: "100%",
  },
  muted: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "24px 0 0",
  },
  fallback: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "26px 0 0",
    wordBreak: "break-all" as const,
  },
  fallbackLink: {
    color: "#1a4f9c",
    fontFamily: fontMono,
    fontSize: "11px",
    lineHeight: "20px",
    textDecoration: "underline",
    wordBreak: "break-all" as const,
  },
  summary: {
    border: `1px solid ${palette.line}`,
    borderRadius: "4px",
    margin: "26px 0 0",
    overflow: "hidden",
  },
  summaryTable: {
    borderCollapse: "collapse" as const,
    width: "100%",
  },
  summaryLabel: {
    color: palette.muted,
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "18px",
    padding: "12px 10px 12px 16px",
    textAlign: "left" as const,
    verticalAlign: "top",
    width: "34%",
  },
  summaryValue: {
    color: palette.ink,
    fontSize: "14px",
    lineHeight: "20px",
    padding: "11px 16px 11px 10px",
    textAlign: "left" as const,
    verticalAlign: "top",
    wordBreak: "break-word" as const,
  },
} as const;

const styles = {
  body: {
    backgroundColor: palette.panel,
    fontFamily: fontSans,
    margin: 0,
    padding: "32px 12px",
  },
  container: {
    backgroundColor: palette.white,
    border: `1px solid ${palette.line}`,
    borderRadius: "8px",
    margin: "0 auto",
    maxWidth: "600px",
    overflow: "hidden",
  },
  hero: {
    backgroundColor: palette.ink,
    padding: "28px 46px 38px",
  },
  markCell: {
    backgroundColor: palette.paper,
    height: "40px",
    padding: "5px",
    width: "40px",
  },
  wordmark: {
    color: palette.paper,
    fontFamily: fontMono,
    fontSize: "22px",
    fontWeight: "600",
    letterSpacing: "-0.4px",
    paddingLeft: "14px",
    verticalAlign: "middle",
  },
  eyebrow: {
    color: "#b6b3ab",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "20px",
    margin: "32px 0 8px",
  },
  heading: {
    color: palette.paper,
    fontSize: "34px",
    fontWeight: "700",
    letterSpacing: "-0.8px",
    lineHeight: "38px",
    margin: 0,
  },
  content: {
    padding: "42px 46px",
  },
  footer: {
    backgroundColor: palette.paper,
    borderTop: `1px solid ${palette.line}`,
    padding: "24px 46px 28px",
  },
  footerText: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
  },
  footerSignature: {
    color: "#a5a29a",
    fontFamily: fontMono,
    fontSize: "10px",
    letterSpacing: "0.6px",
    lineHeight: "16px",
    margin: "9px 0 0",
  },
  actionSection: {
    margin: "30px 0 0",
  },
  button: {
    backgroundColor: palette.accent,
    borderRadius: "4px",
    boxSizing: "border-box" as const,
    color: palette.white,
    display: "block",
    fontSize: "15px",
    fontWeight: "600",
    lineHeight: "20px",
    padding: "15px 18px",
    textAlign: "center" as const,
    textDecoration: "none",
    width: "100%",
  },
  expiryNotice: {
    backgroundColor: palette.paper,
    border: `1px solid ${palette.line}`,
    borderRadius: "4px",
    margin: "24px 0 0",
    padding: "14px 16px",
  },
  expiryLabel: {
    color: palette.ink,
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "18px",
    margin: 0,
  },
  expiryText: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "3px 0 0",
  },
  fallbackSection: {
    margin: "26px 0 0",
  },
  fallbackLabel: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 9px",
  },
  fallbackLink: {
    color: "#1a4f9c",
    fontFamily: fontMono,
    fontSize: "11px",
    lineHeight: "20px",
    textDecoration: "underline",
    wordBreak: "break-all" as const,
  },
} as const;
