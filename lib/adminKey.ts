/**
 * Admin key handling for the browser.
 *
 * WHY NOT A SERVER-SIDE PROXY
 * ---------------------------
 * The obvious fix for "the dashboard buttons return 401" is a Next.js route that
 * injects the admin key server-side. That would be wrong here. This application
 * has no login of any kind, so such a proxy would give every anonymous visitor
 * an authenticated path to the optimizer, the weight reset and a shell-executing
 * endpoint. It would not close the gap — it would widen it, while looking like a
 * fix.
 *
 * Embedding the key in the client bundle via NEXT_PUBLIC_* is worse still: it
 * ships the secret to everyone who loads the page, permanently, in a file served
 * from a public IP.
 *
 * So: the operator supplies the key once and it lives in their own browser's
 * localStorage. The secret is never in the bundle, never in the repository, and
 * never handed to anonymous visitors. This is appropriate because these buttons
 * are single-operator tools, not a product feature. If this ever gains real
 * users, it needs real authentication — not this.
 */

const STORAGE_KEY = 'ft_admin_key';

export function getAdminKey(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminKey(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (key) window.localStorage.setItem(STORAGE_KEY, key);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private browsing / storage disabled — the call below will simply 401 */
  }
}

export function hasAdminKey(): boolean {
  return getAdminKey().length > 0;
}

/**
 * fetch() for endpoints behind requireAdminKey.
 *
 * Returns a normal Response so callers keep their existing error handling, but
 * turns the two failure modes that are otherwise indistinguishable from a bug
 * into readable messages: no key stored (401 never sent), and a server with no
 * ADMIN_API_KEY configured (503).
 */
export async function adminFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const key = getAdminKey();
  if (!key) {
    return new Response(
      JSON.stringify({ error: 'No admin key set. Open the admin-key box on this page and paste the value of ADMIN_API_KEY from the server .env file.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const headers = new Headers(init.headers || {});
  headers.set('x-admin-key', key);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}
