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

/**
 * The kind of failure, kept distinct on purpose (correction 6).
 *
 * The first version called `.json()` on every response and spread the result
 * into state, so a 401, a 403 and a 503 all arrived as `d.data || []` — an empty
 * array that renders as a legitimately empty broker list. "You are signed out",
 * "you are forbidden" and "the backend is down" became indistinguishable from
 * "there is nothing here", which is the same fail-open UI pattern the review
 * objects to on the market pages.
 */
export type OpFailureKind = 'auth' | 'forbidden' | 'unavailable' | 'error';

export class OpError extends Error {
  kind: OpFailureKind;
  status: number;
  constructor(kind: OpFailureKind, status: number, message: string) {
    super(message);
    this.name = 'OpError';
    this.kind = kind;
    this.status = status;
  }
}

function kindFor(status: number): OpFailureKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 429 || status === 503 || status >= 500) return 'unavailable';
  return 'error';
}

/**
 * The single checked path every protected call must go through. Non-2xx THROWS
 * an OpError rather than returning a body, so no caller can accidentally treat
 * a refusal as data. A caller that wants to tolerate failure has to say so.
 */
export async function opJson<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await opFetch(path, init);
  } catch (e: any) {
    // Transport failure is not "no data" either.
    throw new OpError('unavailable', 0, e?.message || 'network error');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* body may not be JSON */ }
    throw new OpError(kindFor(res.status), res.status,
      detail || `HTTP ${res.status}`);
  }
  try {
    return await res.json() as T;
  } catch (e: any) {
    throw new OpError('error', res.status, 'response was not valid JSON');
  }
}
