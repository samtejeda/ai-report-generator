import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newInvitationToken } from "@/lib/auth/invitation-token";

// What /accept-invitation decides on the server. The lookup itself is tested in
// lib/auth/invitation-link.test.ts (and against the real database in the integration suite); here the
// check is a stub, so the question is only: does the page look the same for every unusable link?
const leaveIfSignedIn = vi.fn<(options?: { resetLink?: boolean }) => Promise<void>>(async () => {});
const invitationTokenForForm = vi.fn<(token: string | undefined) => Promise<string | null>>();
vi.mock("@/lib/auth/visitor", () => ({ leaveIfSignedIn: (o?: { resetLink?: boolean }) => leaveIfSignedIn(o) }));
vi.mock("@/lib/auth/check-invitation-link", () => ({ invitationTokenForForm: (t: string | undefined) => invitationTokenForForm(t) }));

const { AcceptInvitationGate } = await import("./accept-invitation-gate");

const render = async (token?: string | string[]) => renderToStaticMarkup(await AcceptInvitationGate({ searchParams: Promise.resolve({ token: token as string | undefined }) }));

beforeEach(() => {
  leaveIfSignedIn.mockClear();
  invitationTokenForForm.mockReset();
});

describe("the accept-invitation gate", () => {
  it("a usable link shows the form, and the token is not written into the markup", async () => {
    const { token } = newInvitationToken();
    invitationTokenForForm.mockResolvedValue(token);
    const html = await render(token);
    expect(html).toContain("<form");
    expect(html).toMatch(/name="name"/);
    expect(html).toMatch(/name="password"/);
    expect(html).toMatch(/name="confirm"/);
    expect(html).not.toContain(token);
  });

  it("every unusable link renders the SAME page as a missing or malformed token: no form, one sentence, byte for byte", async () => {
    invitationTokenForForm.mockResolvedValue(null);
    const { token } = newInvitationToken();
    // The check answers null for unknown, used, revoked, expired and replaced links alike (it cannot say why).
    const unusable = await render(token);
    const missing = await render(undefined);
    const malformed = await render("not-a-token");
    const other = await render(newInvitationToken().token);
    expect(unusable).toBe(missing);
    expect(unusable).toBe(malformed);
    expect(unusable).toBe(other);
    expect(unusable).not.toContain("<form");
    expect(unusable).toContain("This invitation link is not valid. Ask the practice owner to send you a new one.");
    expect(unusable).toContain('href="/login"');
    expect(unusable).not.toContain(token);
    expect(unusable).not.toMatch(/used|revoked|expired|replaced|already/i);
  });

  it("is not the same page as a usable link", async () => {
    const { token } = newInvitationToken();
    invitationTokenForForm.mockResolvedValueOnce(token);
    const usable = await render(token);
    invitationTokenForForm.mockResolvedValueOnce(null);
    expect(usable).not.toBe(await render(token));
  });

  it("a signed-in visitor keeps today's behaviour: sent home without a token, shown the page with one, before any lookup", async () => {
    invitationTokenForForm.mockResolvedValue(null);
    await render(undefined);
    expect(leaveIfSignedIn).toHaveBeenLastCalledWith({ resetLink: false });
    const order: string[] = [];
    leaveIfSignedIn.mockImplementationOnce(async () => void order.push("leave"));
    invitationTokenForForm.mockImplementationOnce(async () => (order.push("check"), null));
    await render(newInvitationToken().token);
    expect(leaveIfSignedIn).toHaveBeenLastCalledWith({ resetLink: true });
    expect(order).toEqual(["leave", "check"]);
  });

  it("a repeated ?token=a&token=b parameter is not passed on as a string", async () => {
    invitationTokenForForm.mockResolvedValue(null);
    await render(["a", "b"]);
    expect(invitationTokenForForm).toHaveBeenLastCalledWith(undefined);
  });
});
