import type { NextConfig } from "next";

/**
 * FT-P0-02 — one API routing strategy, and a local path equivalent to production.
 *
 * PRODUCTION IS ALREADY CORRECT AND IS NOT CHANGED HERE. nginx serves the app and
 * the API from one origin:
 *
 *     /etc/nginx/sites-available/flowtracker-direct   (listen 3200)
 *       location /scraper-api/  ->  proxy_pass http://127.0.0.1:3100
 *       location /              ->  proxy_pass http://127.0.0.1:3201   (this app)
 *
 * That same-origin arrangement is what makes the operator session possible at all:
 * the session cookie is `SameSite=Strict`, so no CORS grant can make a browser send
 * it cross-site. Only a same-site route can. A second production proxy is therefore
 * neither needed nor authorised, and this config deliberately does not create one.
 *
 * WHAT WAS MISSING is the local equivalent. `API_BASE` resolves to `/scraper-api`
 * in the browser, and under `next dev` nothing serves that path, so every
 * browser-side call 404s against the app itself and the page renders as if the
 * market were empty. Developing against a route that only exists on the server is
 * how a contract drifts without anyone noticing.
 *
 * So the rewrite below exists ONLY where nginx is absent:
 *
 *   - development            -> on, pointing at the local scraper (127.0.0.1:3100)
 *   - production             -> OFF, because nginx owns the path
 *   - `SCRAPER_UPSTREAM` set -> on, whatever the environment, for deliberate cases
 *                               such as an SSH tunnel or a stub upstream in tests
 *
 * Next's rewrite is a real reverse proxy: method, body, query string and headers
 * travel in both directions, including `Cookie` upstream and `Set-Cookie` back, and
 * the upstream status is returned unchanged rather than coerced to 200. Those are
 * the properties the operator session depends on, and they are asserted in
 * `scraper/test_api_routing.js` rather than assumed.
 *
 * It never injects credentials. `ADMIN_API_KEY` must not reach a browser-facing
 * proxy: a route that added it would hand every anonymous caller operator rights.
 */
const SCRAPER_UPSTREAM =
  process.env.SCRAPER_UPSTREAM ??
  (process.env.NODE_ENV === "production" ? null : "http://127.0.0.1:3100");

const nextConfig: NextConfig = {
  async rewrites() {
    if (!SCRAPER_UPSTREAM) return [];
    return [
      {
        source: "/scraper-api/:path*",
        destination: `${SCRAPER_UPSTREAM}/:path*`,
      },
    ];
  },
};

export default nextConfig;
