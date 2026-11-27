import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QR_LABEL } from "@/lib/auth/mfa-setup-messages";
import { totpQr } from "@/lib/auth/totp-qr";
import { SetupKeyPanel } from "./setup-key-panel";

const KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/AI%20Report%20Generator:owner%40example.test?secret=${KEY}&issuer=AI%20Report%20Generator&algorithm=SHA1&digits=6&period=30`;

/** Every attribute value in the markup, so a leak into any attribute (alt, title, aria-*, data-*, d, class...) is caught. */
const attributeValues = (html: string) => [...html.matchAll(/\s[\w:-]+="([^"]*)"/g)].map((m) => m[1]);

describe("the enrollment key panel (step 2)", () => {
  const html = renderToStaticMarkup(<SetupKeyPanel qr={totpQr(URI)} setupKey={KEY} />);

  it("shows the QR as an inline svg with a plain accessible name, and the text key as the fallback", () => {
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toContain(`aria-label="${QR_LABEL}"`);
    expect(html).toContain('data-testid="setup-key"');
    expect(html).toMatch(new RegExp(`<code[^>]*>${KEY}</code>`));
  });

  it("puts the key in the page exactly once, as text, and in no attribute or address", () => {
    expect(html.split(KEY)).toHaveLength(2); // exactly one occurrence
    for (const v of attributeValues(html)) {
      expect(v).not.toContain(KEY);
      expect(v).not.toContain("otpauth");
      expect(v).not.toMatch(/owner|example\.test/);
    }
    expect(html).not.toContain("otpauth");
    expect(html).not.toMatch(/<title/);
  });

  it("loads nothing from outside: no img, no url, no script, no link, no embedded data", () => {
    expect(html).not.toMatch(/<img|<script|<link|<iframe|<image|<use|<foreignObject/i);
    expect(html).not.toMatch(/https?:|\/\/|data:|blob:|url\(/i);
  });

  it("paints dark on white whatever the theme is, with the quiet zone inside the white square", () => {
    expect(html).toContain('fill="#ffffff"');
    expect(html).toContain('fill="#000000"');
    const qr = totpQr(URI)!;
    expect(html).toContain(`viewBox="0 0 ${qr.size} ${qr.size}"`);
    expect(html).toContain(`<rect width="${qr.size}" height="${qr.size}" fill="#ffffff"></rect>`);
  });

  it("shrinks to the screen (no fixed width wider than the card) so there is no sideways scroll at 375 px", () => {
    expect(html).toMatch(/class="[^"]*\bw-64\b[^"]*\bmax-w-full\b/);
    expect(html).toMatch(/<code[^>]*class="[^"]*\bbreak-all\b/);
  });

  it("still gives the text key alone when the QR could not be drawn", () => {
    const noQr = renderToStaticMarkup(<SetupKeyPanel qr={null} setupKey={KEY} />);
    expect(noQr).not.toContain("<svg");
    expect(noQr).toContain(KEY);
    expect(noQr).toContain('data-testid="setup-key"');
  });

  it("renders nothing secret once the state is cleared (what a hidden or finished page leaves behind)", () => {
    const cleared = renderToStaticMarkup(<SetupKeyPanel qr={null} setupKey="" />);
    expect(cleared).not.toContain("<svg");
    expect(cleared).not.toContain(KEY);
  });
});
