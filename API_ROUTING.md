# API routing contract

FT-P0-02. One strategy, written down, so the browser path stops being folklore
recovered by reading nginx on the box.

---

## The rule

**Every browser-side call goes to `/scraper-api/*` on the app's own origin.**
Never to a host and port. Server-side rendering is the one exception and calls
the scraper directly on loopback.

```ts
// lib/apiConfig.ts — the single authority
export const API_BASE = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_API_BASE || "/scraper-api")   // browser: same origin
  : (process.env.API_BASE || "http://127.0.0.1:3100");     // SSR: loopback
```

### Why same-origin is required, not merely tidy

The operator session cookie is `SameSite=Strict`. A browser will not attach it to
a cross-site request **no matter what CORS allows** — CORS governs whether a
response may be *read*, never whether a cookie is *sent*. So a cross-origin call
to `http://<host>:3100` cannot carry the session, and the page silently behaves
as an anonymous caller. Only a same-site route works. This is why hardcoded
absolute API origins are a correctness defect and not a style preference.

---

## Production: nginx owns the path

`/etc/nginx/sites-available/flowtracker-direct`, listening on **3200**:

```nginx
location /scraper-api/ {
    rewrite ^/scraper-api/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    ...
}
location / {
    proxy_pass http://127.0.0.1:3201;   # this Next app
}
```

`location /scraper-api/` is a prefix match and is selected ahead of `location /`,
so nginx serves the API path and Next never sees it. Frontend and API therefore
share the origin `:3200`.

**The app does not proxy in production.** `next.config.ts` returns no rewrite
when `NODE_ENV=production` unless `SCRAPER_UPSTREAM` is set deliberately. A
second proxy is not authorised: it would duplicate a working contract and give
two places for it to drift.

---

## Local development: the same path, provided by Next

Before FT-P0-02 nothing served `/scraper-api` locally, so `next dev` returned 404
for every browser-side call and pages rendered as though the market were empty.
The contract only existed on the server, which is how it drifted unnoticed.

`next.config.ts` now rewrites `/scraper-api/:path*` to `SCRAPER_UPSTREAM`,
defaulting to `http://127.0.0.1:3100` outside production:

| environment | rewrite | upstream |
|---|---|---|
| `next dev` | on | `SCRAPER_UPSTREAM` or `127.0.0.1:3100` |
| `next build` / `next start` | off | — unless `SCRAPER_UPSTREAM` was set **at build time** |
| explicit `SCRAPER_UPSTREAM` | on | that value |

**`next start` bakes rewrites at build time.** `rewrites()` runs during `next
build` and is written into the routes manifest, so setting `SCRAPER_UPSTREAM`
only at runtime does nothing for a built app. Set it for the build:

```bash
SCRAPER_UPSTREAM=http://127.0.0.1:3100 npm run build && npx next start -p 3210
```

A local upstream is usually an SSH tunnel to the box:

```bash
ssh -N -L 3100:127.0.0.1:3100 root@<host>
```

---

## What the proxy must preserve, and must never add

Preserve, in both directions:

- method, request body and query string
- `Cookie` upstream and `Set-Cookie` downstream — the session depends on both
- `X-CSRF-Token` upstream
- the upstream **status code**, unchanged. A 401, 403 or 503 must arrive as
  itself; coercing it to 200 turns a refusal into data.

Never add:

- `ADMIN_API_KEY`, or any credential, to a browser-facing route. A proxy that
  injected it would hand operator rights to every anonymous caller.
- a synthesised body on failure — no empty arrays, zeros, or neutral market
  state. See below.

Asserted by `scraper/test_api_routing.js` against a stub upstream, rather than
assumed.

---

## Failure is rendered, not simulated

When the upstream is unreachable the UI must say so and keep whatever it already
had. It must never present absence as a measurement — an empty broker list reads
as "no brokers are configured", which is a claim about the market rather than
about the connection.

The mechanism is `lib/operatorSession.ts`: `opJson()` throws a typed `OpError`
with `kind` in `auth | forbidden | unavailable | error`, and callers render the
distinction. Previous data is deliberately left in place on failure.

---

## Known deviations, enumerated

These pages still hardcode an absolute API origin and therefore bypass the
same-site contract. They are enumerated in `scraper/test_api_origins.js`, and
**that list may only shrink** — a new hardcoded origin fails the suite.

| file | origin |
|---|---|
| `app/daily-picks/page.tsx` | `http://76.13.22.155:3100` |
| `app/journey/page.tsx` | `http://localhost:3100` |
| `app/screener/page.tsx` | `http://76.13.22.155:3100` |
| `app/stockbit-connector/page.tsx` | `http://76.13.22.155:3100` |

Each is a page outside this vertical slice. They work today only because port
3100 is reachable directly, which is itself a finding (see the P0-01 exposure
note), and none of them can carry an operator session.
