'use strict';
/**
 * FT-P0-02 — the /scraper-api proxy contract, exercised rather than asserted.
 *
 * This starts a STUB UPSTREAM that reports exactly what it received, spawns a real
 * Next dev server with `SCRAPER_UPSTREAM` pointed at the stub, and drives requests
 * through `/scraper-api/*`. Reading `next.config.ts` and checking that a rewrite is
 * declared would prove only that someone wrote a rewrite; it would not prove that a
 * `Set-Cookie` survives the trip, which is the property the operator session
 * actually depends on.
 *
 * A stub is used instead of the real scraper on purpose: it can be asked for a 503,
 * and it can report the headers it saw, so "the cookie reached upstream" is
 * observed rather than inferred from a downstream side effect.
 *
 * Not in `test:unit` — it spawns a dev server and takes ~20s. Run it directly:
 *
 *     node scraper/test_api_routing.js
 */
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STARTUP_TIMEOUT_MS = 90_000;

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}

/** Stub upstream: echoes what it received, and can be told to fail. */
function startStub() {
  return new Promise(resolve => {
    const seen = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });

        if (req.url.startsWith('/api/stub/down')) {
          // A refusal must arrive as a refusal. If the proxy rewrites this to 200
          // the UI cannot tell "unavailable" from "nothing here".
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'UPSTREAM_DOWN' }));
        }
        if (req.url.startsWith('/api/stub/unauthorized')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'no valid operator session' }));
        }
        if (req.url.startsWith('/api/stub/setcookie')) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': [
              'ft_op=stubsession; HttpOnly; Path=/; SameSite=Strict',
              'ft_csrf=stubcsrf; Path=/; SameSite=Strict',
            ],
          });
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method, url: req.url, body,
          cookie: req.headers.cookie || null,
          csrf: req.headers['x-csrf-token'] || null,
          adminKey: req.headers['x-admin-key'] || null,
          authorization: req.headers.authorization || null,
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function waitFor(url, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() > deadline) return reject(new Error('dev server did not become ready in time'));
      http.get(url, res => { res.resume(); resolve(); }).on('error', () => setTimeout(tick, 500));
    };
    tick();
  });
}

function request(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async () => {
  const stub = await startStub();
  const appPort = 3400 + (process.pid % 100);

  const dev = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(appPort)], {
    cwd: ROOT,
    env: { ...process.env, SCRAPER_UPSTREAM: `http://127.0.0.1:${stub.port}`, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let devLog = '';
  dev.stdout.on('data', d => { devLog += d; });
  dev.stderr.on('data', d => { devLog += d; });

  const cleanup = () => { try { dev.kill(); } catch {} try { stub.server.close(); } catch {} };
  process.on('exit', cleanup);

  try {
    await waitFor(`http://127.0.0.1:${appPort}/scraper-api/api/stub/ping`, Date.now() + STARTUP_TIMEOUT_MS);

    console.log(`\nFT-P0-02 proxy contract — app :${appPort}  ->  stub upstream :${stub.port}\n`);

    // ── method, path, query and body ────────────────────────────────────────
    const echoed = await request(appPort, '/scraper-api/api/stub/echo?a=1&b=two', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const e = JSON.parse(echoed.body);
    check('method survives the proxy', () => assert.strictEqual(e.method, 'POST'));
    check('path is rewritten without the /scraper-api prefix', () =>
      assert.ok(e.url.startsWith('/api/stub/echo'), `upstream saw ${e.url}`));
    check('query string survives', () => assert.ok(e.url.includes('a=1') && e.url.includes('b=two'), e.url));
    check('request body survives', () => assert.strictEqual(e.body, '{"hello":"world"}'));

    // ── the session headers, in both directions ─────────────────────────────
    const withCookie = await request(appPort, '/scraper-api/api/stub/echo', {
      headers: { Cookie: 'ft_op=abc123; ft_csrf=tok', 'X-CSRF-Token': 'tok' },
    });
    const c = JSON.parse(withCookie.body);
    check('Cookie reaches upstream — the session depends on it', () =>
      assert.ok(c.cookie && c.cookie.includes('ft_op=abc123'), `upstream saw cookie: ${c.cookie}`));
    check('X-CSRF-Token reaches upstream', () => assert.strictEqual(c.csrf, 'tok'));

    const setCookie = await request(appPort, '/scraper-api/api/stub/setcookie');
    check('Set-Cookie comes back through the proxy', () => {
      const sc = setCookie.headers['set-cookie'];
      assert.ok(Array.isArray(sc) && sc.length === 2, `got ${JSON.stringify(sc)}`);
      assert.ok(sc.some(v => v.includes('ft_op=stubsession')), 'session cookie missing');
    });
    check('cookie attributes are not stripped (HttpOnly/SameSite survive)', () => {
      const sc = (setCookie.headers['set-cookie'] || []).join(' ');
      assert.ok(/HttpOnly/i.test(sc), 'HttpOnly was dropped');
      assert.ok(/SameSite=Strict/i.test(sc), 'SameSite=Strict was dropped');
    });

    // ── status pass-through: a refusal must stay a refusal ───────────────────
    const down = await request(appPort, '/scraper-api/api/stub/down');
    check('503 is propagated, not coerced to 200', () => assert.strictEqual(down.status, 503));
    check('the upstream error body survives', () => assert.ok(down.body.includes('UPSTREAM_DOWN'), down.body));

    const unauth = await request(appPort, '/scraper-api/api/stub/unauthorized');
    check('401 is propagated', () => assert.strictEqual(unauth.status, 401));

    // ── the proxy must never hand out credentials ───────────────────────────
    check('no ADMIN_API_KEY is injected by the proxy', () => {
      const withKey = stub.seen.filter(r => r.headers['x-admin-key']);
      assert.deepStrictEqual(withKey.map(r => r.url), [],
        'the proxy added x-admin-key — an anonymous caller would gain operator rights');
    });
    check('no Authorization header is injected by the proxy', () => {
      const withAuth = stub.seen.filter(r => r.headers.authorization);
      assert.deepStrictEqual(withAuth.map(r => r.url), []);
    });
    check('the upstream saw every request we made (nothing was answered locally)', () =>
      assert.ok(stub.seen.length >= 6, `upstream saw only ${stub.seen.length}`));

  } catch (err) {
    fail++;
    results.push(['FAIL', 'harness', err.message]);
    if (devLog) console.error('\n--- dev server output ---\n' + devLog.slice(-1500));
  } finally {
    cleanup();
  }

  for (const [state, name, detail] of results) {
    console.log(`  ${state}  ${name}${detail ? '\n        ' + detail : ''}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
