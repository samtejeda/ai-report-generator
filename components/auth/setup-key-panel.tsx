import { SAME_PHONE_NOTE } from "@/lib/auth/mfa-setup-messages";
import type { TotpQr } from "@/lib/auth/totp-qr";
import { TotpQrCode } from "./totp-qr-code";

// Step 2 of enrollment: the QR code (when it could be drawn) and, always, the text key as the way
// to finish without a camera or on the same phone. Shows only what it is given; keeps nothing.
export function SetupKeyPanel({ qr, setupKey }: { qr: TotpQr | null; setupKey: string }) {
  return (
    <div className="flex flex-col gap-3">
      {qr ? (
        <>
          <TotpQrCode qr={qr} />
          <p className="text-sm">{SAME_PHONE_NOTE}</p>
        </>
      ) : null}
      <p className="text-sm font-medium">Setup key</p>
      <code className="break-all rounded-md border border-zinc-300 p-2 text-sm" data-testid="setup-key">
        {setupKey}
      </code>
    </div>
  );
}
