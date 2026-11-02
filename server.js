// CreatorOne — real product backend (v1).
// Express + node:sqlite (builtin, no native deps). Serves the static site from this
// same folder and provides /api/* for accounts, pages, links, products, courses,
// bookings, subscribers, posts and real analytics.
// Honest limits in v1 (see README note in index FAQ + privacy):
//  - Payments are TEST ONLY (YouPI pattern, no gateway call): Buy/Enroll create
//    a pending_verification test order only. No real money moves, no real UPI
//    QR is shown, and a test order is never a confirmed payment. Real YouPI
//    needs a separate gateway deployment + merchant VPA + observer setup.
//  - Instagram auto-DMs are a placeholder: real auto-DMs need Meta API approval.
//  - Newsletter subscribe STORES the email; no welcome email is sent yet
//    (email provider onboarding is still pending).
// Free-tier caveat: on Render free tier the SQLite file is ephemeral — a redeploy
// or restart can reset data. A managed Postgres move is the next step once the
// product has real users; do not promise permanence on this tier.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CREATORONE_DB || path.join(__dirname, 'creatorone.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  pass_salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, price TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, price TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, slot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, email)
);
CREATE TABLE IF NOT EXISTS page_stats (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0
);
-- YouPI-style TEST orders only. No real money, no real UPI, no gateway call yet.
-- Status flow follows the YouPI manual-UPI guide: an order stays
-- pending_verification until the page owner (admin) marks it verified/rejected
-- after checking their own bank records. In TEST mode that bank check is
-- simulated — never treat a test order as a real payment.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  price_text TEXT NOT NULL DEFAULT '',
  buyer_name TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_verification',
  gateway TEXT NOT NULL DEFAULT 'youpi_test',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// CORS: same-origin (Render) + GitHub Pages frontend calling the Render API.
const ALLOWED_ORIGINS = new Set(['https://tabi02.github.io']);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Tiny in-memory rate limit for auth endpoints only (per IP, per minute).
const authHits = new Map();
function authLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const hits = (authHits.get(ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  authHits.set(ip, hits);
  if (hits.length > 30) return res.status(429).json({ error: 'Too many attempts — try again in a minute.' });
  next();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function publicUser(u) {
  return { id: u.id, email: u.email, handle: u.handle, display_name: u.display_name, bio: u.bio };
}
function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim()); }
function validHandle(h) { return typeof h === 'string' && /^[a-z0-9_]{3,30}$/.test(h); }
function validUrl(u) {
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}
const RESERVED = new Set(['admin', 'creatorone', 'app', 'api', 'demo', 'support', 'login', 'signup', 'privacy', 'about']);

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Login required.' });
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'Session expired — please log in again.' });
  req.user = row;
  req.token = token;
  next();
}
function ownerPage(handle) {
  return db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
}
function pagePayload(user) {
  const links = db.prepare('SELECT id, title, url, clicks FROM links WHERE user_id = ? ORDER BY id').all(user.id);
  const products = db.prepare('SELECT id, name, price, description FROM products WHERE user_id = ? ORDER BY id').all(user.id);
  const courses = db.prepare('SELECT id, name, price, description FROM courses WHERE user_id = ? ORDER BY id').all(user.id);
  const posts = db.prepare('SELECT id, text, created_at FROM posts WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id);
  const stats = db.prepare('SELECT views, clicks FROM page_stats WHERE user_id = ?').get(user.id) || { views: 0, clicks: 0 };
  const subCount = db.prepare('SELECT COUNT(*) c FROM subscribers WHERE user_id = ?').get(user.id).c;
  const bookCount = db.prepare('SELECT COUNT(*) c FROM bookings WHERE user_id = ?').get(user.id).c;
  return {
    handle: user.handle, display_name: user.display_name, bio: user.bio,
    links, products, courses, posts,
    stats: { views: stats.views, clicks: stats.clicks, subscribers: subCount, bookings: bookCount },
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'creatorone' }));

app.post('/api/signup', authLimit, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const handle = String(req.body?.handle || '').trim().toLowerCase();
  const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
  const password = String(req.body?.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!validHandle(handle) || RESERVED.has(handle)) return res.status(400).json({ error: 'Handle must be 3–30 letters, numbers or underscore, and not a reserved word.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'That email is already registered — try logging in.' });
  if (db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return res.status(409).json({ error: 'That handle is already taken — pick another.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare('INSERT INTO users (email, handle, display_name, pass_salt, pass_hash) VALUES (?, ?, ?, ?, ?)')
    .run(email, handle, displayName || handle, salt, hashPassword(password, salt));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  db.prepare('INSERT INTO page_stats (user_id) VALUES (?)').run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', authLimit, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || hashPassword(password, user.pass_salt) !== user.pass_hash) {
    return res.status(401).json({ error: 'Email or password is wrong.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.patch('/api/me', auth, (req, res) => {
  const displayName = String(req.body?.display_name ?? req.user.display_name).trim().slice(0, 80);
  const bio = String(req.body?.bio ?? req.user.bio).trim().slice(0, 500);
  db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.get('/api/me/dashboard', auth, (req, res) => {
  const bookings = db.prepare('SELECT id, name, email, slot, created_at FROM bookings WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const subscribers = db.prepare('SELECT id, email, created_at FROM subscribers WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  const orders = db.prepare('SELECT id, kind, item_name, price_text, buyer_name, buyer_email, status, gateway, created_at FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  res.json({ page: pagePayload(req.user), bookings, subscribers, orders });
});

// TEST checkout: create a pending_verification order. Price is always read
// from the creator's own product/course row — never trusted from the client.
app.post('/api/pages/:handle/orders', (req, res) => {
  const user = ownerPage(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No page with that handle.' });
  const kind = req.body?.kind === 'course' ? 'course' : 'product';
  const table = kind === 'course' ? 'courses' : 'products';
  const item = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(req.body?.item_id, user.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this page.' });
  const buyerName = String(req.body?.buyer_name || '').trim().slice(0, 100);
  const buyerEmail = String(req.body?.buyer_email || '').trim().toLowerCase();
  if (!buyerName || !validEmail(buyerEmail)) return res.status(400).json({ error: 'Name and a valid email are required for a test order.' });
  const info = db.prepare('INSERT INTO orders (user_id, kind, item_id, item_name, price_text, buyer_name, buyer_email) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, kind, item.id, item.name, item.price || '', buyerName, buyerEmail);
  res.status(201).json({
    ok: true,
    order: { id: info.lastInsertRowid, kind, item_name: item.name, price_text: item.price || '', status: 'pending_verification' },
    note: 'TEST ORDER ONLY — no real money was taken, no real UPI payment was made, and this order is NOT a confirmed payment. The page owner must verify it separately.',
  });
});

// Owner marks a test order verified/rejected (manual-review pattern).
app.post('/api/me/orders/:id/decision', auth, (req, res) => {
  const decision = req.body?.decision === 'verified' ? 'verified' : req.body?.decision === 'rejected' ? 'rejected' : null;
  if (!decision) return res.status(400).json({ error: 'Decision must be verified or rejected.' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.status !== 'pending_verification') return res.status(409).json({ error: 'This order already has a final decision.' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(decision, order.id);
  res.json({ ok: true, status: decision });
});

// Owner CRUD — one generic helper keeps the four lists identical in behaviour.
function crud(table, fields, validate) {
  app.post(`/api/me/${table}`, auth, (req, res) => {
    const err = validate ? validate(req.body) : null;
    if (err) return res.status(400).json({ error: err });
    const cols = fields.join(', ');
    const vals = fields.map((f) => String(req.body[f] ?? '').trim());
    const info = db.prepare(`INSERT INTO ${table} (user_id, ${cols}) VALUES (?, ${fields.map(() => '?').join(', ')})`).run(req.user.id, ...vals);
    res.status(201).json({ id: info.lastInsertRowid });
  });
  app.delete(`/api/me/${table}/:id`, auth, (req, res) => {
    const r = db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  });
}
crud('links', ['title', 'url'], (b) => {
  if (!String(b.title || '').trim()) return 'Link title is required.';
  if (!validUrl(String(b.url || ''))) return 'Link URL must start with http:// or https://';
  return null;
});
crud('products', ['name', 'price', 'description'], (b) => (!String(b.name || '').trim() ? 'Product name is required.' : null));
crud('courses', ['name', 'price', 'description'], (b) => (!String(b.name || '').trim() ? 'Course name is required.' : null));
crud('posts', ['text'], (b) => (!String(b.text || '').trim() ? 'Post text is required.' : null));

// Public page + visitor actions.
app.get('/api/pages/:handle', (req, res) => {
  const user = ownerPage(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No page with that handle.' });
  res.json({ page: pagePayload(user) });
});
app.post('/api/pages/:handle/view', (req, res) => {
  const user = ownerPage(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No page with that handle.' });
  db.prepare('INSERT INTO page_stats (user_id, views) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET views = views + 1').run(user.id);
  res.json({ ok: true });
});
app.post('/api/pages/:handle/links/:id/click', (req, res) => {
  const user = ownerPage(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No page with that handle.' });
  const link = db.prepare('SELECT id FROM links WHERE id = ? AND user_id = ?').get(req.params.id, user.id);
  if (!link) return res.status(404).json({ error: 'Link not found.' });
  db.prepare('UPDATE links SET clicks = clicks + 1 WHERE id = ?').run(link.id);
  db.prepare('INSERT INTO page_stats (user_id, clicks) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET clicks = clicks + 1').run(user.id);
  res.json({ ok: true });
});
app.post('/api/pages/:handle/book', (req, res) => {
  const user = ownerPage(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No page with that handle.' });
  const name = String(req.body?.name || '').trim().slice(0, 100);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const slot = String(req.body?.slot || '').trim().slice(0, 100);
  if (!name || !validEmail(email) || !slot) return res.status(400).json({ error: 'Name, valid email and a slot are required.' });
  db.prepare('INSERT INTO bookings (user_id, name, email, slot) VALUES (?, ?, ?, ?)').run(user.id, name, email, slot);
  res.status(201).json({ ok: true, note: 'Booking saved. The creator will contact you — no calendar invite is sent yet.' });
});
app.post('/api/pages/:handle/subscribe', (req, res) => {
  const user = ownerPage(req.params.handle.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No page with that handle.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  try {
    db.prepare('INSERT INTO subscribers (user_id, email) VALUES (?, ?)').run(user.id, email);
  } catch {
    return res.json({ ok: true, already: true, note: 'Already subscribed.' });
  }
  res.status(201).json({ ok: true, note: 'Subscribed. No welcome email is sent yet — the creator can see your email in their dashboard.' });
});

// Static site (same folder). Never serve the server, db or package files.
app.use((req, res, next) => {
  if (/(^|\/)(server\.js|package\.json|package-lock\.json|creatorone\.db.*)$/.test(req.path)) return res.sendStatus(404);
  next();
});
app.use(express.static(__dirname, { extensions: ['html'] }));
app.use((req, res) => res.status(404).send('Not found.'));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => console.log(`CreatorOne running on 0.0.0.0:${PORT}`));
