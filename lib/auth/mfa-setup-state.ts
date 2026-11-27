import type { TotpQr } from "./totp-qr";

// What the enrollment screen holds between its steps. The setup key, its QR drawing and the backup
// codes are secrets: each is dropped the moment it has done its job (see the reducer below), and
// all of them when the page is hidden. Kept as a pure reducer so that is testable without a browser.

export type Step = "password" | "code" | "codes";

export type SetupState = {
  step: Step;
  setupKey: string;
  qr: TotpQr | null;
  backupCodes: string[];
};

export type SetupAction =
  | { type: "enabled"; setupKey: string; qr: TotpQr | null; backupCodes: string[] }
  | { type: "verified" }
  | { type: "done" }
  | { type: "hidden" };

export const INITIAL_SETUP: SetupState = { step: "password", setupKey: "", qr: null, backupCodes: [] };

export function setupReducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case "enabled":
      return { step: "code", setupKey: action.setupKey, qr: action.qr, backupCodes: action.backupCodes };
    case "verified":
      // The authenticator has the key now: drop the key and the drawing, keep the backup codes to show.
      return { ...state, step: "codes", setupKey: "", qr: null };
    case "done":
      // "I have saved them": nothing secret is left in state before the page is left.
      return { step: "codes", setupKey: "", qr: null, backupCodes: [] };
    case "hidden":
      return INITIAL_SETUP;
  }
}
