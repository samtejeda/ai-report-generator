import { getAuthDb } from "@/lib/db/auth-db";
import { RATE_LIMITS } from "./config";
import { consumeAddressLimit } from "./invitation-accept";
import { createResetLinkLimit } from "./reset-link-limit";

/** The real wiring for the reset-link address limit (logic and order in reset-link-limit.ts, unit tested with injected counters). */
export const limitResetLink = createResetLinkLimit({
  limit: (key) => consumeAddressLimit(getAuthDb(), key, RATE_LIMITS.resetLink),
});
