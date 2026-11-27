import { encode } from "uqr";

// Turns the authenticator setup address (the `otpauth://totp/...` URI the server returned) into a
// drawing of a QR code, entirely in the browser: nothing here touches the network, storage or the
// DOM, and the address is never kept (the caller holds only the drawing).
//
// The drawing is a size and ONE svg path (dark squares only), so the component can paint it as an
// inline <svg>: no <img>, no data: or external URL, no change to the page's Content-Security-Policy.

/** Light squares around the code. The QR standard asks for 4; phone cameras need them. */
export const QUIET_ZONE_MODULES = 4;

// The most a real address needs is about 150 characters (issuer, address, 32-character key). A very
// long label is refused here, before any work, and the person is left with the text key.
const MAX_URI_LENGTH = 1024;

// Version 12 at error-correction level M holds 274 bytes in a 65-square grid. Larger grids get small
// on a 240 px drawing and scan worse, so a label that needs more is refused rather than shrunk.
const MAX_VERSION = 12;

export type TotpQr = {
  /** Width and height in squares, quiet zone included (the svg viewBox is `0 0 size size`). */
  size: number;
  /** Dark squares as one run per row: `M x y h w v1 h-w z`. */
  path: string;
};

/**
 * Draws the QR code for an authenticator setup address, or returns null for anything that is not
 * one (not `otpauth://totp/`, no `secret`, too long to scan). Never throws, and the answer is the
 * same every time for the same address.
 */
export function totpQr(uri: string): TotpQr | null {
  try {
    if (typeof uri !== "string" || uri.length === 0 || uri.length > MAX_URI_LENGTH) return null;
    const parsed = new URL(uri);
    if (parsed.protocol !== "otpauth:" || parsed.host !== "totp") return null;
    if (!parsed.searchParams.get("secret")) return null;

    const { data, size } = encode(uri, { ecc: "M", border: 0, maxVersion: MAX_VERSION });
    const offset = QUIET_ZONE_MODULES;
    let path = "";
    for (let y = 0; y < size; y++) {
      const row = data[y];
      let x = 0;
      while (x < size) {
        if (!row[x]) {
          x++;
          continue;
        }
        let end = x;
        while (end < size && row[end]) end++;
        const width = end - x;
        path += `M${x + offset} ${y + offset}h${width}v1h-${width}z`;
        x = end;
      }
    }
    return { size: size + offset * 2, path };
  } catch {
    return null;
  }
}
