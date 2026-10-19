/**
 * Transactional email, kept deliberately small. Account email only: verification link,
 * password-reset link, "your password was changed". Bodies carry NO PHI and no names: a link
 * or a fixed sentence, nothing about clients, reports or the practice's work (Resend's content
 * policy and CLAUDE.md both require this).
 *
 * Only the console transport exists. A real transport (Resend, free tier) is a separate,
 * Sam-approved change; until then a deployed environment cannot send mail, and the env schema
 * refuses the console transport in production so links can never reach deployed logs.
 */

export type Mail = { to: string; subject: string; text: string };
export type MailTransport = { send(mail: Mail): Promise<void> };

/** Prints the message to the server log. Local development and tests only. */
export function createConsoleTransport(options: { production: boolean; write?: (line: string) => void }): MailTransport {
  const write = options.write ?? ((line: string) => console.info(line));
  return {
    async send(mail) {
      if (options.production) throw new Error("The console email transport is not allowed in production");
      write(`[dev email] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
    },
  };
}

const FOOTER = "If you did not expect this email, you can ignore it.";

export const mailTemplates = {
  verifyEmail(to: string, url: string, expiresInHours: number): Mail {
    return {
      to,
      subject: "Verify your email address",
      text: `Open this link to verify your email address. It expires in ${expiresInHours} hours.\n\n${url}\n\n${FOOTER}`,
    };
  },
  resetPassword(to: string, url: string, expiresInMinutes: number): Mail {
    return {
      to,
      subject: "Reset your password",
      text: `Open this link to choose a new password. It expires in ${expiresInMinutes} minutes and works once.\n\n${url}\n\nIf you did not ask for this, ignore this email: your password has not changed.`,
    };
  },
  /** Sent after any password change or reset, to the account's own address. No link. */
  passwordChanged(to: string): Mail {
    return {
      to,
      subject: "Your password was changed",
      text: "The password for your account was just changed, and all other sessions were signed out.\n\nIf this was not you, contact your practice owner right away.",
    };
  },
};
