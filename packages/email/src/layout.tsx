import type { ReactNode } from "react";
import { Body, Container, Head, Heading, Hr, Html, Preview, Section, Text } from "react-email";

interface EmailLayoutProps {
  preview: string;
  heading: string;
  children: ReactNode;
}

export function EmailLayout({ preview, heading, children }: EmailLayoutProps) {
  return (
    <Html lang="ru">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.brandBar}>
            <Text style={styles.brand}>МАРКИРО</Text>
            <Text style={styles.brandCaption}>Производство и маркировка</Text>
          </Section>
          <Section style={styles.content}>
            <Heading style={styles.heading}>{heading}</Heading>
            {children}
            <Hr style={styles.divider} />
            <Text style={styles.footer}>
              Это автоматическое письмо от Маркиро. Если вы не запрашивали это действие, письмо
              можно удалить.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export const emailStyles = {
  paragraph: {
    color: "#24272b",
    fontSize: "16px",
    lineHeight: "25px",
    margin: "0 0 16px",
  },
  muted: {
    color: "#646a73",
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 16px",
  },
  button: {
    backgroundColor: "#17191c",
    borderRadius: "6px",
    color: "#ffffff",
    display: "inline-block",
    fontSize: "15px",
    fontWeight: "600",
    lineHeight: "20px",
    padding: "13px 20px",
    textDecoration: "none",
  },
  actionSection: {
    margin: "28px 0",
  },
  fallback: {
    color: "#646a73",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "22px 0 0",
    wordBreak: "break-all" as const,
  },
  fallbackLink: {
    color: "#3b62d0",
    textDecoration: "underline",
  },
};

const styles = {
  body: {
    backgroundColor: "#f2f3f4",
    fontFamily: "Arial, Helvetica, sans-serif",
    margin: 0,
    padding: "32px 12px",
  },
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #dfe1e4",
    borderRadius: "8px",
    margin: "0 auto",
    maxWidth: "600px",
    overflow: "hidden",
  },
  brandBar: {
    backgroundColor: "#17191c",
    padding: "18px 28px 16px",
  },
  brand: {
    color: "#ffffff",
    fontSize: "18px",
    fontWeight: "700",
    letterSpacing: "2px",
    lineHeight: "22px",
    margin: 0,
  },
  brandCaption: {
    color: "#b8bdc5",
    fontSize: "11px",
    letterSpacing: "0.4px",
    lineHeight: "16px",
    margin: "3px 0 0",
  },
  content: {
    padding: "32px 28px 28px",
  },
  heading: {
    color: "#17191c",
    fontSize: "26px",
    fontWeight: "700",
    letterSpacing: "-0.4px",
    lineHeight: "33px",
    margin: "0 0 24px",
  },
  divider: {
    borderColor: "#e4e6e8",
    margin: "30px 0 20px",
  },
  footer: {
    color: "#777d86",
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
  },
};
