const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Staging differs from production in DATA only (seeded demo rows, suppressed
// side effects) — never in which features exist or how the core logic runs.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

let shuttingDown = false;

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// Domain constants. Conditions and statuses are fixed vocabularies; prices
// are stored as integer cents.
const CONDITIONS = ['new', 'like-new', 'good', 'fair'];
const STATUSES = ['available', 'sold', 'given'];

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Who is looking. The frontend needs the viewer's id to decide whether an
// item's seller controls (mark sold / relist) should be shown.
app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

// Listing search: free-text over titles (ILIKE, so "bike" finds "Bike"),
// optional exact condition filter. Newest first.
app.get('/api/items', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const condition = typeof req.query.condition === 'string' ? req.query.condition : '';
    const params = [];
    const clauses = [];
    if (q) {
      params.push('%' + q + '%');
      clauses.push(`title ILIKE $${params.length}`);
    }
    if (CONDITIONS.includes(condition)) {
      params.push(condition);
      clauses.push(`condition = $${params.length}`);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT id, user_id, username, title, price_cents, is_giveaway, condition, status, created_at
       FROM items ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/items/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Item not found' });
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, username, title, price_cents, is_giveaway, condition, status, created_at
       FROM items WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post an item. The server is the validation authority (the form checks the
// same things first for a snappier experience): a title of at least 3
// characters, a known condition, and either a giveaway flag or a price
// above zero. Prices arrive in dollars, are stored as integer cents.
app.post('/api/items', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (title.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters.' });
  if (title.length > 120) return res.status(400).json({ error: 'Title must be 120 characters or fewer.' });
  const condition = req.body.condition;
  if (!CONDITIONS.includes(condition)) return res.status(400).json({ error: 'Pick a condition.' });
  const isGiveaway = req.body.is_giveaway === true;
  let priceCents = null;
  if (!isGiveaway) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Enter a price above zero, or mark the item a giveaway.' });
    }
    if (price > 1000000) return res.status(400).json({ error: 'Price must be under 1,000,000.' });
    priceCents = Math.round(price * 100);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (user_id, username, title, price_cents, is_giveaway, condition, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'available')
       RETURNING *`,
      [req.user.id, req.user.username, title, priceCents, isGiveaway, condition]
    );
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sellers flip their own item between available and taken — sold for priced
// items, given away for giveaways. Nobody else can.
app.patch('/api/items/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Item not found' });
  const status = req.body.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  try {
    const { rows } = await pool.query(
      'SELECT id, user_id, is_giveaway FROM items WHERE id = $1', [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = rows[0];
    if (item.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the seller can update this item.' });
    }
    const takenStatus = item.is_giveaway ? 'given' : 'sold';
    if (status !== 'available' && status !== takenStatus) {
      return res.status(400).json({
        error: item.is_giveaway
          ? 'Giveaways are marked as given away.'
          : 'Priced items are marked as sold.'
      });
    }
    const { rows: updated } = await pool.query(
      'UPDATE items SET status = $1 WHERE id = $2 RETURNING *', [status, id]
    );
    res.json({ item: updated[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Market news: short community announcements about the market itself.
// Anyone signed in can read and post, the same open model as listings.
app.get('/api/news', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, username, title, body, created_at
       FROM news_posts
       ORDER BY created_at DESC, id DESC
       LIMIT 50`
    );
    res.json({ news: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bodies are capped at 500 characters so every announcement reads in full
// on its card; there is no detail page.
app.post('/api/news', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (title.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters.' });
  if (title.length > 120) return res.status(400).json({ error: 'Title must be 120 characters or fewer.' });
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Write some news.' });
  if (body.length > 500) return res.status(400).json({ error: 'News must be 500 characters or fewer.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO news_posts (user_id, username, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, username, title, body, created_at`,
      [req.user.id, req.user.username, title, body]
    );
    res.json({ post: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/preloved-market-f8349c/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/preloved-market-f8349c/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Captured by start() so the shutdown handler can stop accepting
// connections.
let server = null;

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(120) NOT NULL,
      price_cents INTEGER,
      is_giveaway BOOLEAN NOT NULL DEFAULT false,
      condition VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'available',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      title VARCHAR(120) NOT NULL,
      body VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The starter template's demo press counter. Its endpoints are gone with
  // the template screen, and the table never held anything but demo press
  // counts, so it goes too.
  await pool.query('DROP TABLE IF EXISTS presses');

  // Staging previews start from an empty database; seed a handful of
  // obviously fake demo listings so the grid, detail view and filters have
  // something real to show. Fake identity only, idempotent, and skipped the
  // moment any real (or previously seeded) rows exist.
  if (IS_STAGING) {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
    if (rows[0].n === 0) {
      await pool.query(`
        INSERT INTO items (user_id, username, title, price_cents, is_giveaway, condition, status) VALUES
          (900001, 'staging-demo-user', 'Staging demo: Kids mountain bike', 45000, false, 'good', 'available'),
          (900001, 'staging-demo-user', 'Staging demo: Oak bookshelf', 80000, false, 'like-new', 'available'),
          (900001, 'staging-demo-user', 'Staging demo: Board game bundle', 12000, false, 'good', 'available'),
          (900001, 'staging-demo-user', 'Staging demo: Potted monstera', NULL, true, 'new', 'available'),
          (900001, 'staging-demo-user', 'Staging demo: Vintage film camera', 120000, false, 'fair', 'available'),
          (900001, 'staging-demo-user', 'Staging demo: Winter jacket', 25000, false, 'good', 'sold')
      `);
    }
    const { rows: newsRows } = await pool.query('SELECT COUNT(*)::int AS n FROM news_posts');
    if (newsRows[0].n === 0) {
      await pool.query(`
        INSERT INTO news_posts (user_id, username, title, body, created_at) VALUES
          (900001, 'staging-demo-user', 'Staging demo: Pickup point moves to the community hall',
            'From next week, please arrange pickups at the community hall by the front entrance instead of sending items by mail. It is open every weekday from 9 am to 6 pm.',
            NOW() - INTERVAL '3 days'),
          (900001, 'staging-demo-user', 'Staging demo: Giveaway weekend starts Friday',
            'Clearing out the garage or the toy box? Post your free items this weekend and mark them as giveaways so neighbours can find them with the filters.',
            NOW() - INTERVAL '1 day'),
          (900001, 'staging-demo-user', 'Staging demo: Flea market this Saturday',
            'Bring a blanket and anything you want to sell to the park on Saturday from 10 am. Tables are first come, first served. Bring your own change.',
            NOW())
      `);
    }
  }

  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });

// Every container is stopped and replaced on each deploy: stop accepting
// connections, let in-flight requests finish under a hard deadline, close
// the pool, exit. Idempotent so a second signal is a no-op.
const DRAIN_MS = 3000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  try { server.close(() => {}); } catch {}
  try { server.closeIdleConnections?.(); } catch {}
  const t = setTimeout(() => { try { server.closeAllConnections?.(); } catch {} }, DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));