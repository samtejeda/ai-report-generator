# Audit: Auth and Permissions

**Owning agent:** `auth-access-builder` (paired with `04-security-and-rls.md`)

**Status:** active: build to this and self-check against it. Re-read this file fresh before every check; don't rely on memory.

This is a pass/fail checklist and a definition of done, not build instructions.

For each item, tell me pass or fail with a specific example.

1. Proven auth provider (NextAuth/Auth.js or Clerk), not hand-rolled: bcrypt hashing, session management, email verification.
2. Every protected page and endpoint checks logged-in AND authorized (role and organization), at layout level and again in the handler.
3. Users can only reach their own organization's data (and, for associates, only assigned clients); verified with a cross-tenant test.
4. Sessions expire, invalidate on logout, and refresh securely.
5. Password reset links expire, are single-use, and notify the account owner.
6. No unprotected backdoor routes (seed routes, debug routes, test endpoints).
7. (Added) Login, logout, failed login, and password change are written to `audit_log`.

Give me an overall score out of 7 and list the top 3 things to fix first.
