import { getAuthDb } from "@/lib/db/auth-db";
import { getAuthEnv } from "@/lib/env";
import { RATE_LIMITS } from "./config";
import { callAcceptInvitation, consumeAddressLimit, createAcceptHandler } from "./invitation-accept";
import { getAuth } from "./server";

/**
 * The real wiring for POST /api/invitations/accept (the logic and its order are in
 * invitation-accept.ts, tested with injected dependencies). The password is hashed with Better Auth's
 * own configured hasher, so the credential row is exactly what a Better Auth sign-in verifies.
 */
export const acceptInvitationHandler = createAcceptHandler({
  allowedOrigin: () => new URL(getAuthEnv().BETTER_AUTH_URL).origin,
  limit: (bucket) => consumeAddressLimit(getAuthDb(), `${bucket}|/invitations/accept`, RATE_LIMITS.acceptInvitation),
  hashPassword: async (password) => (await getAuth().$context).password.hash(password),
  accept: (input) => callAcceptInvitation(getAuthDb(), input),
  log: (event, fields = {}) => console.warn(JSON.stringify({ event, ...fields })),
});
