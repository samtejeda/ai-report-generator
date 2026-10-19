"use client";

import { createAuthClient } from "better-auth/react";

// Browser side of Better Auth: same origin, so no base URL. Used by the login, reset and
// sign-out forms only; it holds no secrets and enforces nothing (the server does).
export const authClient = createAuthClient();
