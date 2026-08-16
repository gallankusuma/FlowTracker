/**
 * Operator session client (FT-P0-01A).
 *
 * Replaces admin-key forwarding from the browser. The key is typed once into the
 * login form, POSTed to the server, and exchanged for an httpOnly cookie the
 * page cannot read. Nothing here writes to localStorage, sessionStorage, or a
 * URL — that is the acceptance criterion "no admin secret appears in the client
 * bundle, browser storage, URL, or logs", and the way to satisfy it is to never
 * hold the secret at all.
 *
 * The CSRF token IS held, in a module variable, for the lifetime of the page. It
 * is not a secret on its own: without the httpOnly session cookie it authorises
 * nothing, and an attacker's page cannot read our cookie to pair with it.
 * Keeping it in memory rather than storage means a new tab re-derives it from
 * /whoami instead of inheriting a stale one.
 */
import { API_BASE } from '@/lib/apiConfig';

let csrfToken: string | null = null;

export type OperatorState =
  | { authenticated: true; actor: string; expiresAt: number }
  | { authenticated: false };

/** Ask the server who we are. Also refreshes the in-memory CSRF token. */
export async function whoami(): Promise<OperatorState> {
  try {
    const r = await fetch(`${API_BASE}/api/operator/whoami`, { credentials: 'include' });
    if (!r.ok) { csrfToken = null; return { authenticated: false }; }
    const d = await r.json();
    csrfToken = d.csrfToken || null;
    return { authenticated: true, actor: d.actor, expiresAt: d.expiresAt };
  } catch {
    csrfToken = null;
    return { authenticated: false };
  }
}

/**
 * Exchange the operator key for a session. The key is passed in the BODY, never
 * a query string, so it cannot land in access logs, proxy logs or history.
 */
export async function login(key: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${API_BASE}/api/operator/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: d.error || `HTTP ${r.status}` };
  csrfToken = d.csrfToken || null;
  return { ok: true };
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/operator/logout`, { method: 'POST', credentials: 'include' });
  } finally {
    csrfToken = null;
  }
}

/**
 * fetch() for operator-protected routes.
 *
 * Sends the session cookie and, on mutations, the CSRF token. A 401 clears the
 * cached token so the caller's next whoami() reflects reality rather than a
 * stale "still logged in".
 */
export async function opFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  if (res.status === 401) csrfToken = null;
  return res;
}

/** True when a token is held — used only to decide whether to re-run whoami(). */
export function hasCsrfToken(): boolean { return csrfToken !== null; }
