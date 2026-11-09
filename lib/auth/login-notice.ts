/**
 * The short message the sign-in page shows right after an invitation was accepted. The accept page
 * ends with a full page load of `/login?invited=1`: a fixed flag that carries no name, address or
 * token, so the address bar and history hold nothing about the person. The page turns the flag into
 * one fixed sentence here; any other value shows nothing.
 */

export const INVITED_FLAG = "invited";
export const INVITED_PATH = `/login?${INVITED_FLAG}=1`;
export const INVITED_NOTICE = "Your account is ready. Sign in now. You will set up your authenticator app after you sign in.";

export function loginNotice(flag: string | string[] | undefined): string | null {
  return flag === "1" ? INVITED_NOTICE : null;
}
