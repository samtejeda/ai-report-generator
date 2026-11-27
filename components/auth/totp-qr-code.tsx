import { QR_LABEL } from "@/lib/auth/mfa-setup-messages";
import type { TotpQr } from "@/lib/auth/totp-qr";

// The authenticator QR code as an inline <svg>: no <img>, no external URL, no script, so the page's
// Content-Security-Policy needs no change. The colors are fixed (dark on white, quiet zone inside the
// white square) on purpose: a scanner needs that contrast whatever the page theme is. Its accessible
// name is fixed text; the key is never in an attribute (the person finishes with the text key alone).
export function TotpQrCode({ qr }: { qr: TotpQr }) {
  return (
    <svg
      role="img"
      aria-label={QR_LABEL}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className="aspect-square h-auto w-64 max-w-full self-center ring-1 ring-zinc-300"
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.path} fill="#000000" />
    </svg>
  );
}
