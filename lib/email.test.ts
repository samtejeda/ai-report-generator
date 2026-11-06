import { describe, expect, it } from "vitest";
import { createConsoleTransport, mailTemplates } from "./email";

describe("mail templates carry no PHI and no names", () => {
  const url = "https://app.example.com/api/auth/reset-password/TOKEN?callbackURL=%2Freset-password";
  const mails = [
    mailTemplates.verifyEmail("a@example.com", url, 24),
    mailTemplates.resetPassword("a@example.com", url, 60),
    mailTemplates.passwordChanged("a@example.com"),
    mailTemplates.mfaReset("a@example.com"),
    mailTemplates.invitation("a@example.com", "https://app.example.com/accept-invitation?token=TOKEN", 7),
  ];

  it("addresses only the recipient and contains no other personal field", () => {
    for (const m of mails) {
      expect(m.to).toBe("a@example.com");
      expect(m.text).not.toMatch(/client|student|patient|report|evaluation|diagnos|school|IEP|organization|practice name/i);
    }
  });

  it("links appear only in the verification, reset and invitation mails", () => {
    expect(mails[0].text).toContain(url);
    expect(mails[1].text).toContain(url);
    expect(mails[2].text).not.toMatch(/https?:\/\//);
    expect(mails[3].text).not.toMatch(/https?:\/\//);
  });

  it("the owner-reset notice has no link, tells the person what happens next and what to do if unexpected", () => {
    expect(mails[3].text).not.toMatch(/https?:\/\//);
    expect(mails[3].text).toMatch(/set up an authenticator app again/);
    expect(mails[3].text).toMatch(/If you did not expect this/);
    expect(mails[3].subject).toBe("Your two-step sign-in was reset");
  });

  it("the invitation is a link and fixed sentences: it says it works once and expires, and names no person or practice", () => {
    const m = mails[4];
    expect(m.text).toContain("https://app.example.com/accept-invitation?token=TOKEN");
    expect(m.text).toMatch(/works once/);
    expect(m.text).toMatch(/expires in 7 days/);
    expect(m.text).toMatch(/If you did not expect this email, you can ignore it/);
    expect(m.subject).toBe("You have been invited to create an account");
    // Nothing in it varies except the recipient, the link and the number of days.
    const other = mailTemplates.invitation("b@example.com", "https://other.example.com/x", 7);
    expect(other.text.replace("https://other.example.com/x", "L")).toBe(m.text.replace("https://app.example.com/accept-invitation?token=TOKEN", "L"));
  });

  it("the reset mail says the link works once and expires", () => {
    expect(mails[1].text).toMatch(/works once/);
    expect(mails[1].text).toMatch(/60 minutes/);
  });
});

describe("console transport", () => {
  it("writes the message outside production", async () => {
    const lines: string[] = [];
    await createConsoleTransport({ production: false, write: (l) => lines.push(l) }).send(mailTemplates.passwordChanged("a@example.com"));
    expect(lines.join("\n")).toContain("a@example.com");
  });

  it("refuses to run in production", async () => {
    await expect(createConsoleTransport({ production: true }).send(mailTemplates.passwordChanged("a@example.com"))).rejects.toThrow(/production/);
  });
});

describe("MFA notice", () => {
  it("is a fixed sentence with no link, no code and no name", () => {
    const mail = mailTemplates.mfaEnabled("a@example.com");
    expect(mail.to).toBe("a@example.com");
    expect(mail.text).not.toMatch(/https?:\/\/|\d{6}/);
    expect(mail.text).toMatch(/not you/);
  });
});
