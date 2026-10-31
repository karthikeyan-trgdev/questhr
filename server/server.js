#!/usr/bin/env node
/*  QuestHR server · Chandramari Group
    One file, no npm install. Node.js 22 or newer.
    - Serves the QuestHR app, a REST + live-stream API, files, AI and diagnostics.
    - Database: SQLite (built into Node) with an automatic JSON fallback.
    - Nothing is ever deleted: every change is versioned in the audit trail.            */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const VERSION = '5.0.0';
const ROOT = __dirname, PKG = path.resolve(ROOT, '..');
process.removeAllListeners('warning'); process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w.message); });

/* ---------------- configuration ---------------- */
const CFG_FILE = process.env.QUESTHR_CONFIG || path.join(PKG, 'config.json');
const DEF = { port: 8080, host: '0.0.0.0', dataDir: './data', backupDir: '', backupEveryHours: 6, keepBackups: 120,
  anthropicApiKey: '', aiModel: 'claude-sonnet-5-5', aiModelQuick: 'claude-haiku-5-5', sessionHours: 12, publicUrl: '' };
let CFG = { ...DEF };
try { CFG = { ...DEF, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') console.error('config.json could not be read:', e.message); }
const argv = process.argv.slice(2), arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
if (arg('--port')) CFG.port = +arg('--port');
if (arg('--data')) CFG.dataDir = arg('--data');
if (process.env.PORT) CFG.port = +process.env.PORT;
if (process.env.QUESTHR_DATA) CFG.dataDir = process.env.QUESTHR_DATA;
if (process.env.ANTHROPIC_API_KEY && !CFG.anthropicApiKey) CFG.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
if (process.env.QUESTHR_PUBLIC_URL) CFG.publicUrl = process.env.QUESTHR_PUBLIC_URL;
const DATA = path.resolve(PKG, CFG.dataDir);
const BACKUPS = path.resolve(PKG, CFG.backupDir || path.join(CFG.dataDir, 'backups'));
const FILES = path.join(DATA, 'files'), AUDITDIR = path.join(DATA, 'audit');
[DATA, BACKUPS, FILES, AUDITDIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

/* ---------------- storage ---------------- */
const D = new Map();            // path -> data (all documents kept in memory for speed)
let store;                      // persistence engine
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
function sqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(DATA, 'questhr.db');
  const open = () => { const db = new DatabaseSync(file); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); return db; };
  let db = null;
  try { db = open(); } catch (e) { db = null; }
  const check = () => { try { return !!db && db.prepare('PRAGMA quick_check').get().quick_check === 'ok'; } catch (e) { return false; } };
  if (!check()) { try { db && db.close(); } catch (e) {} db = recoverSqlite(file, open); }
  db.exec(`CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, col TEXT, data TEXT, updated TEXT, by TEXT);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, user TEXT, path TEXT, prev TEXT, next TEXT, ip TEXT);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, at TEXT, by TEXT);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT, exp INTEGER);
    CREATE INDEX IF NOT EXISTS docs_col ON docs(col); CREATE INDEX IF NOT EXISTS audit_path ON audit(path);`);
  const put = db.prepare('INSERT INTO docs(path,col,data,updated,by) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated, by=excluded.by');
  const aud = db.prepare('INSERT INTO audit(at,user,path,prev,next,ip) VALUES(?,?,?,?,?,?)');
  return {
    kind: 'SQLite', file,
    load() { for (const r of db.prepare('SELECT path,data FROM docs').iterate()) D.set(r.path, JSON.parse(r.data)); },
    write(p, data, by, prev, ip) { const at = new Date().toISOString(), j = JSON.stringify(data);
      db.exec('BEGIN'); try { put.run(p, p.split('/')[0], j, at, by || ''); aud.run(at, by || '', p, prev === undefined ? null : JSON.stringify(prev), j, ip || ''); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    remove(p, by, prev, ip) { const at = new Date().toISOString();   // the audit row keeps the removed document
      db.exec('BEGIN'); try { db.prepare('DELETE FROM docs WHERE path=?').run(p); aud.run(at, by || '', p, prev === undefined ? null : JSON.stringify(prev), null, ip || ''); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
    file_put(m) { db.prepare('INSERT OR IGNORE INTO files(id,name,type,size,at,by) VALUES(?,?,?,?,?,?)').run(m.id, m.name, m.type, m.size, m.at, m.by); },
    file_get(id) { return db.prepare('SELECT * FROM files WHERE id=?').get(id); },
    sess_put(t, u, exp) { db.prepare('INSERT OR REPLACE INTO sessions(token,user,exp) VALUES(?,?,?)').run(t, u, exp); },
    sess_get(t) { return db.prepare('SELECT * FROM sessions WHERE token=?').get(t); },
    sess_end(t) { db.prepare('UPDATE sessions SET exp=0 WHERE token=?').run(t); },
    auditCount() { return db.prepare('SELECT count(*) n FROM audit').get().n; },
    integrity() { return check(); },
    backup(dest) { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); },
    checkpoint() { db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;'); },
    ext: '.db'
  };
}
function recoverSqlite(file, open) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  log('Database check failed. Keeping the damaged copy and restoring the latest backup.');
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.renameSync(file + s, file + '.damaged-' + stamp + s);
  const b = latestBackup('.db');
  if (b) fs.copyFileSync(b.file, file);
  const db = open();
  db.exec('CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, col TEXT, data TEXT, updated TEXT, by TEXT)');
  const n = replayAudit(b ? b.at : '', (p, data, at, by) => data === 'null' ? db.prepare('DELETE FROM docs WHERE path=?').run(p) : db.prepare('INSERT INTO docs(path,col,data,updated,by) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated').run(p, p.split('/')[0], data, at, by));
  log(`Restored ${b ? path.basename(b.file) : 'an empty database'} and replayed ${n} later changes from the audit journal.`);
  return db;
}
function jsonStore() {
  const file = path.join(DATA, 'questhr-docs.json'); let timer = null, sess = {}, files = {};
  const meta = path.join(DATA, 'questhr-meta.json');
  try { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); sess = m.sess || {}; files = m.files || {}; } catch (e) {}
  const flush = () => { timer = null; const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(D))); fs.renameSync(tmp, file); fs.writeFileSync(meta + '.tmp', JSON.stringify({ sess, files })); fs.renameSync(meta + '.tmp', meta); };
  return {
    kind: 'JSON files', file,
    load() { try { Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).forEach(([k, v]) => D.set(k, v)); }
      catch (e) { if (e.code !== 'ENOENT') { const b = latestBackup('.json'); log('Data file unreadable; restoring from backup and audit journal.'); fs.renameSync(file, file + '.damaged-' + Date.now()); if (b) Object.entries(JSON.parse(fs.readFileSync(b.file, 'utf8'))).forEach(([k, v]) => D.set(k, v)); replayAudit(b ? b.at : '', (p, data) => data === 'null' ? D.delete(p) : D.set(p, JSON.parse(data))); } } },
    write() { if (!timer) timer = setTimeout(flush, 400); }, remove() { this.write(); },
    file_put(m) { files[m.id] = m; this.write(); }, file_get(id) { return files[id]; },
    sess_put(t, u, exp) { sess[t] = { token: t, user: u, exp }; this.write(); }, sess_get(t) { return sess[t]; }, sess_end(t) { if (sess[t]) sess[t].exp = 0; this.write(); },
    auditCount() { return null; }, integrity() { try { if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch (e) { return false; } },
    backup(dest) { if (timer) { clearTimeout(timer); flush(); } if (fs.existsSync(file)) fs.copyFileSync(file, dest); }, checkpoint() { if (timer) { clearTimeout(timer); flush(); } }, flush: () => timer && (clearTimeout(timer), flush()),
    ext: '.json'
  };
}
/* the audit journal: one JSON line per change, per month — used to rebuild after any failure */
function journal(p, data, by, ip) { const at = new Date().toISOString(); fs.appendFileSync(path.join(AUDITDIR, `audit-${at.slice(0, 7)}.jsonl`), JSON.stringify({ at, by, ip, path: p, data }) + '\n'); }
function replayAudit(since, apply) { let n = 0; for (const f of fs.readdirSync(AUDITDIR).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(AUDITDIR, f), 'utf8').split('\n')) { if (!line) continue; try { const r = JSON.parse(line); if (r.at > since) { apply(r.path, JSON.stringify(r.data), r.at, r.by); n++; } } catch (e) {} } } return n; }
function latestBackup(ext) { try { const l = fs.readdirSync(BACKUPS).filter(f => f.startsWith('questhr-') && f.endsWith(ext)).sort(); if (!l.length) return null; const f = l[l.length - 1]; const m = f.match(/questhr-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/); return { file: path.join(BACKUPS, f), at: m ? `${m[1]}T${m[2]}:${m[3]}` : '' }; } catch (e) { return null; } }
try { if (process.env.QUESTHR_STORE === 'json') throw new Error('JSON store requested'); store = sqliteStore(); } catch (e) { log('SQLite is not available in this Node.js (' + e.message.split('\n')[0] + '). Using JSON files.'); store = jsonStore(); }
store.load();
let lastBackup = latestBackup(store.ext);
function backupNow() { const t = new Date(), s = t.toISOString(); const name = `questhr-${s.slice(0, 10)}_${s.slice(11, 13)}${s.slice(14, 16)}${store.ext}`; const dest = path.join(BACKUPS, name);
  if (fs.existsSync(dest)) return dest; store.backup(dest); lastBackup = { file: dest, at: s.slice(0, 16) };
  try { const ad = path.join(BACKUPS, 'audit'); fs.mkdirSync(ad, { recursive: true }); fs.readdirSync(AUDITDIR).forEach(f => fs.copyFileSync(path.join(AUDITDIR, f), path.join(ad, f))); } catch (e) { log('Audit journal copy failed:', e.message); }
  const l = fs.readdirSync(BACKUPS).filter(f => f.startsWith('questhr-') && f.endsWith(store.ext)).sort();
  // keep the newest copies; older backups move to an archive folder instead of being deleted
  if (l.length > CFG.keepBackups) { const arch = path.join(BACKUPS, 'archive'); fs.mkdirSync(arch, { recursive: true }); l.slice(0, l.length - CFG.keepBackups).forEach(f => fs.renameSync(path.join(BACKUPS, f), path.join(arch, f))); }
  return dest; }

/* ---------------- access rules (mirror the app) ---------------- */
const users = () => { const o = []; for (const [p, v] of D) if (p.startsWith('users/')) o.push(v); return o; };
const userById = id => D.get('users/' + id);
const org = () => D.get('org/main') || { configured: false };
const today = () => new Date().toISOString().slice(0, 10);
function subs(id, all, seen = new Set()) { const out = []; all.filter(u => u.reportsTo === id && !seen.has(u.id)).forEach(u => { seen.add(u.id); out.push(u.id, ...subs(u.id, all, seen)); }); return out; }
function scope(me) { const all = users(), u = userById(me); if (!u) return new Set(); if (u.admin) return new Set(all.map(x => x.id));
  const s = new Set([me, ...subs(me, all)]); if (org().peer === 'dept') all.filter(x => !x.admin && x.levelId === u.levelId && x.dept === u.dept).forEach(x => s.add(x.id)); return s; }
function canSeeTask(t, me, sc) { if (!t) return false; if (sc.has(t.assignee) || t.creator === me || t.takenOverFrom === me) return true; if ((t.interests || []).some(i => i.by === me)) return true;
  const a = userById(t.assignee), u = userById(me); const elig = !t.master && ['todo', 'doing'].includes(t.status) && (t.due < today() || t.openForHelp);
  return !!(elig && a && u && a.reportsTo && a.reportsTo === u.reportsTo && !u.admin); }
function chatVisible(c, me) { const u = userById(me); if (!u || !c) return false; if (c.type === 'lobby' || (c.members || []).includes(me) || (u.admin && c.type === 'esc')) return true;
  if (c.type === 'unit') return u.admin || u.dept === c.unit || subs(me, users()).some(id => (userById(id) || {}).dept === c.unit); return false; }
const chatOf = id => id === 'lobby' ? { type: 'lobby' } : id.startsWith('unit-') ? { type: 'unit', unit: id.slice(5) } : D.get('chats/' + id);
const PUBLIC_USER = ['id', 'name', 'username', 'levelId', 'dept', 'site', 'admin', 'active', 'attire', 'skin', 'hair', 'hairLong', 'beard', 'reportsTo', 'tz', 'xp', 'created'];
function clean(p, d, me) {
  const col = p.split('/')[0];
  if (col === 'users') { if (!me) return Object.fromEntries(PUBLIC_USER.filter(k => k in d).map(k => [k, d[k]])); const { pass, salt, ...r } = d; return r; }
  if (col === 'org') return { ...d, sites: (d.sites || []).map(({ salt, hash, ...s }) => s) };
  return d;
}
/* what a signed-in person may read; returns the (possibly filtered) document or null */
function view(me, p, d) {
  if (!d) return null; const col = p.split('/')[0], id = p.slice(col.length + 1);
  if (col === 'org' || col === 'users') return clean(p, d, me);
  if (!me || !userById(me)) return null;
  const u = userById(me), sc = scope(me);
  switch (col) {
    case 'tasks': return canSeeTask(d, me, sc) ? d : null;
    case 'logs': return sc.has(d.user) ? d : null;
    case 'req': return sc.has(d.by) || d.approver === me || d.decidedBy === me ? d : null;
    case 'act': { if (u.admin) return d; const items = (d.items || []).filter(a => sc.has(a.by)); return items.length ? { ...d, items } : null; }
    case 'rev': { const items = (d.items || []).filter(r => r.by === me || sc.has(r.of)); return items.length ? { ...d, items } : null; }
    case 'chats': return chatVisible(d, me) ? d : null;
    case 'msgs': return chatVisible(chatOf(d.chat), me) ? d : null;
    default: return d;   // ann, kudos, pts (public recognition), blob chunks
  }
}

/* ---------------- write rules ---------------- */
const ITEM_COLS = new Set(['logs', 'act', 'kudos', 'pts', 'rev', 'msgs']);
const PROTECT_SELF = ['admin', 'levelId', 'reportsTo', 'active', 'perm', 'username', 'dept', 'site', 'pass', 'salt', 'mustChange'];
function guard(me, p, data, boot) {
  const col = p.split('/')[0], prev = D.get(p), u = me ? userById(me) : null, admin = boot || (u && u.admin);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { err: 'Invalid document' };
  let next = data;
  if (!admin && prev && col !== 'users' && col !== 'org' && !view(me, p, prev)) return { keep: true };   // you can only change what you can see
  if (col === 'org') { if (!admin) return { keep: true }; next = { ...data, sites: (data.sites || []).map(s => { const o = (prev && prev.sites || []).find(x => x.id === s.id) || {}; return { ...s, salt: s.salt || o.salt, hash: s.hash || o.hash }; }) }; }
  else if (col === 'users') {
    if (!admin) {
      if (!prev) return { keep: true };
      if (data.id !== me) { next = { ...prev }; ['xp', 'docs'].forEach(k => { if (k in data) next[k] = data[k]; }); }
      else { next = { ...data }; PROTECT_SELF.forEach(k => { if (k in prev) next[k] = prev[k]; else delete next[k]; }); }
    } else if (prev) { next = { ...data }; if (!data.pass) { next.pass = prev.pass; next.salt = prev.salt; } }
  }
  else if (ITEM_COLS.has(col)) {
    const old = (prev && prev.items) || [], ids = new Set((data.items || []).map(i => i && i.id));
    let items = (data.items || []).filter(Boolean);
    if (!admin && (col === 'pts' || col === 'msgs')) { const was = new Map(old.map(i => [i.id, i])); items = items.map(i => was.get(i.id) || i); }   // ledger entries and messages are immutable
    if (!admin) { const before = new Set(old.map(i => i.id));
      items = items.filter(i => before.has(i.id) || ((col !== 'pts' && col !== 'msgs' && col !== 'kudos') || (col === 'kudos' ? i.from === me : i.by === me)) && !(col === 'pts' && i.pts > 0 && i.user === me)); }
    old.forEach(i => { if (!ids.has(i.id)) items.push(i); });          // never erase
    next = { ...data, items };
    ['att', 'mood'].forEach(k => { if (prev && prev[k]) next[k] = { ...prev[k], ...(data[k] || {}) }; });
  }
  else if (col === 'tasks' && prev) { // a task is never deleted; its versions and comments are appended only
    ['versions', 'comments'].forEach(k => { if (Array.isArray(prev[k])) { const have = new Set((next[k] || []).map(x => JSON.stringify(x))); const kept = prev[k].filter(x => !have.has(JSON.stringify(x)) && !(next[k] || []).some(y => y && x && y.id && y.id === x.id)); if (kept.length) next = { ...next, [k]: [...kept, ...(next[k] || [])] }; } });
  }
  return { next };
}

/* ---------------- sessions, login ---------------- */
const SESS = new Map(), BOOT = new Map(), FAILS = new Map();
const sha = (pw, salt) => crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
function session(req) { const t = cookies(req).qh_sid; if (!t) return null; let s = SESS.get(t); if (!s) { s = store.sess_get(t); if (s) SESS.set(t, s); }
  if (!s || s.exp < Date.now()) return null; const u = userById(s.user); if (!u || u.active === false) return null; return s; }
let BOOT_IP = null;   // the computer that set the organisation up may finish writing it for 3 minutes
function bootOK(req) { const t = cookies(req).qh_boot; const b = t && BOOT.get(t); if (b && b > Date.now()) return true; return !!(BOOT_IP && BOOT_IP.ip === ip(req) && BOOT_IP.until > Date.now()); }
const secure = req => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
function setCookie(res, req, name, val, maxAge) { const c = `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`; const h = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', h ? [].concat(h, c) : c); }

/* ---------------- live stream + presence ---------------- */
const CLIENTS = new Set();
function presence() { const on = [...new Set([...CLIENTS].map(c => c.user).filter(Boolean))]; for (const c of CLIENTS) if (c.user) sse(c, 'presence', on); }
function sse(c, ev, data) { try { c.res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} }
function broadcast(p, data) { for (const c of CLIENTS) { if (c.user && !userById(c.user)) continue; const v = view(c.user, p, data); if (v) sse(c, 'doc', { path: p, data: v }); } }
setInterval(() => { for (const c of CLIENTS) try { c.res.write(': keep-alive\n\n'); } catch (e) {} }, 25000).unref();

/* ---------------- helpers ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.icns': 'application/octet-stream', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.bat': 'application/octet-stream', '.command': 'application/octet-stream', '.sh': 'application/octet-stream', '.desktop': 'application/octet-stream' };
function send(res, code, body, type) { if (res.headersSent) return; const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type || (typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain; charset=utf-8'), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' }); res.end(b); }
const J = (res, code, o) => send(res, code, o, 'application/json');
function body(req, limit) { return new Promise((ok, no) => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n > limit) { no({ status: 413 }); req.destroy(); } else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no); }); }
async function jbody(req) { const b = await body(req, 8 * 1024 * 1024); try { return b.length ? JSON.parse(b) : {}; } catch (e) { throw { status: 400 }; } }
const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const pwOK = p => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

/* ---------------- app page ---------------- */
const APP_FILE = [path.join(PKG, 'app', 'index.html'), path.join(ROOT, 'index.html')].find(f => fs.existsSync(f));
const VENDOR = path.join(PKG, 'app', 'vendor'), ICONS = path.join(PKG, 'icons');
let APP_HTML = null;
function appHTML() { if (APP_HTML) return APP_HTML; let h = fs.readFileSync(APP_FILE, 'utf8');
  // serve the PDF/Excel/Word libraries locally so the app also works without internet
  const map = { 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js': 'jspdf.umd.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js': 'xlsx.full.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js': 'pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js': 'pdf.worker.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js': 'mammoth.browser.min.js' };
  for (const [u, f] of Object.entries(map)) if (fs.existsSync(path.join(VENDOR, f))) h = h.split(u).join('/vendor/' + f);
  h = h.replace('</head>', `<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/questhr-192.png"><link rel="apple-touch-icon" href="/icons/questhr-180.png"><meta name="theme-color" content="#0f1a33">\n</head>`)
       .replace('</body>', `<script>if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}))</script>\n</body>`);
  return (APP_HTML = h); }
const MANIFEST = { name: 'QuestHR · Chandramari Group', short_name: 'QuestHR', start_url: '/', scope: '/', display: 'standalone', background_color: '#0f1a33', theme_color: '#0f1a33', description: 'Gamified HR task platform',
  icons: [192, 512].map(s => ({ src: `/icons/questhr-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })) };
const SW = `const C='questhr-shell-${VERSION}';self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.webmanifest','/icons/questhr-192.png'])).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/')||u.pathname.startsWith('/_blob/'))return;
 e.respondWith(fetch(e.request).then(r=>{if(r.ok&&(u.pathname==='/'||u.pathname.startsWith('/vendor/')||u.pathname.startsWith('/icons/'))){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request)))});`;

/* ---------------- "add to desktop" installers for members (generated with this server's address) ---------------- */
function baseUrl(req) { return CFG.publicUrl || `${secure(req) ? 'https' : 'http'}://${req.headers.host}`; }
function desktopFile(kind, url) {
  if (kind === 'windows') return ['Add-QuestHR-to-Desktop.bat', `@echo off\r\ntitle QuestHR desktop icon\r\nset "URL=${url}"\r\nset "DIR=%LOCALAPPDATA%\\QuestHR"\r\nif not exist "%DIR%" mkdir "%DIR%"\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -UseBasicParsing '%URL%/icons/questhr.ico' -OutFile '%DIR%\\questhr.ico'}catch{}; $d=[Environment]::GetFolderPath('Desktop'); Set-Content -Path (Join-Path $d 'QuestHR.url') -Value ('[InternetShortcut]','URL=%URL%/','IconIndex=0','IconFile=%DIR%\\questhr.ico') -Encoding ASCII"\r\necho.\r\necho QuestHR icon added to your Desktop. Double-click it to open QuestHR.\r\npause\r\n`];
  if (kind === 'mac') return ['Add-QuestHR-to-Desktop.command', `#!/bin/bash\nURL="${url}"\nAPP="$HOME/Desktop/QuestHR.app"\nmkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"\ncurl -fsSL "$URL/icons/questhr.icns" -o "$APP/Contents/Resources/questhr.icns" || true\ncat > "$APP/Contents/MacOS/QuestHR" <<EOF\n#!/bin/bash\nopen "$URL/"\nEOF\nchmod +x "$APP/Contents/MacOS/QuestHR"\ncat > "$APP/Contents/Info.plist" <<'EOF'\n<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>QuestHR</string><key>CFBundleExecutable</key><string>QuestHR</string><key>CFBundleIconFile</key><string>questhr</string><key>CFBundleIdentifier</key><string>com.chandramari.questhr.link</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\nEOF\ntouch "$APP"\necho "QuestHR icon added to your Desktop."\n`];
  return ['add-questhr-to-desktop.sh', `#!/bin/sh\nURL="${url}"\nmkdir -p "$HOME/.local/share/icons" "$HOME/.local/share/applications"\ncurl -fsSL "$URL/icons/questhr-256.png" -o "$HOME/.local/share/icons/questhr.png" || wget -qO "$HOME/.local/share/icons/questhr.png" "$URL/icons/questhr-256.png"\nF="$HOME/.local/share/applications/questhr.desktop"\nprintf '[Desktop Entry]\\nType=Application\\nName=QuestHR\\nComment=Chandramari Group HR tasks\\nExec=xdg-open %s/\\nIcon=%s/.local/share/icons/questhr.png\\nTerminal=false\\nCategories=Office;\\n' "$URL" "$HOME" > "$F"\nchmod +x "$F"\nD=$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop"); [ -d "$D" ] && cp "$F" "$D/" && chmod +x "$D/questhr.desktop" && (gio set "$D/questhr.desktop" metadata::trusted true 2>/dev/null || true)\necho "QuestHR added to your applications menu and Desktop."\n`];
}

/* ---------------- diagnostics (with online checks) ---------------- */
async function getJSON(url, ms = 6000) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'QuestHR-diagnostics' } }); const date = r.headers.get('date'); return { ok: r.ok, json: r.ok ? await r.json() : null, date }; } finally { clearTimeout(t); } }
async function diagnostics(online, me) {
  const C = [], add = (status, title, detail, fix, links) => C.push({ status, title, detail, fix: fix || null, links: links || null });
  const major = +process.versions.node.split('.')[0];
  add(major >= 22 ? 'ok' : 'warn', 'Server Node.js', `Node.js ${process.versions.node} on ${os.type()} ${os.release()}`, major >= 22 ? null : 'Install Node.js 22 LTS or newer from nodejs.org, then restart QuestHR.', major >= 22 ? null : ['node']);
  add(store.integrity() ? 'ok' : 'bad', 'Server database', `${store.kind} · ${D.size} records · ${store.auditCount() ?? 'journal'} audit entries`, store.integrity() ? null : 'Restart the server. It keeps the damaged copy and restores automatically from the latest backup and the audit journal.');
  let free = null; try { const s = fs.statfsSync(DATA); free = s.bavail * s.bsize; } catch (e) {}
  if (free != null) add(free > 2e9 ? 'ok' : free > 5e8 ? 'warn' : 'bad', 'Server disk space', `${(free / 1e9).toFixed(1)} GB free in the data folder`, free > 2e9 ? null : 'Free up disk space or move the data folder to a larger drive (copy it, then change dataDir in config.json).');
  const ageH = lastBackup && lastBackup.at ? (Date.now() - Date.parse(lastBackup.at + 'Z')) / 36e5 : null;
  add(ageH != null && ageH < CFG.backupEveryHours * 2 + 1 ? 'ok' : 'warn', 'Backups', lastBackup ? `Last backup ${lastBackup.at.replace('T', ' ')} UTC in ${BACKUPS}` : 'No backup yet', ageH != null && ageH < CFG.backupEveryHours * 2 + 1 ? null : 'The server backs up every ' + CFG.backupEveryHours + ' hours. Check that the backup folder is writable.');
  const gd = /google ?drive|my drive|googledrive|cloudstorage\/google/i.test(DATA + BACKUPS);
  add(gd ? 'ok' : 'warn', 'Google Drive copy', gd ? 'The data or backup folder is inside Google Drive for desktop' : 'Data is not in a Google Drive folder', gd ? null : 'For the pilot, set backupDir in config.json to a folder inside Google Drive for desktop.', gd ? null : ['drive']);
  add(CFG.anthropicApiKey ? 'ok' : 'warn', 'AI on the server', CFG.anthropicApiKey ? `Model ${CFG.aiModel}` : 'No AI key configured', CFG.anthropicApiKey ? null : 'Add anthropicApiKey to config.json and restart the server.', CFG.anthropicApiKey ? null : ['anth']);
  add('ok', 'People online', `${new Set([...CLIENTS].map(c => c.user).filter(Boolean)).size} signed in now · uptime ${Math.round(process.uptime() / 60)} min`);
  if (online) {
    const [nodeR, anthR] = await Promise.allSettled([getJSON('https://nodejs.org/dist/index.json'), getJSON('https://status.anthropic.com/api/v2/status.json')]);
    if (nodeR.status === 'fulfilled' && nodeR.value.ok) { const lts = nodeR.value.json.find(v => v.lts && +v.version.slice(1).split('.')[0] === major) || nodeR.value.json.find(v => v.lts);
      const cur = 'v' + process.versions.node, behind = lts && lts.version !== cur && +lts.version.slice(1).split('.')[0] === major;
      add(behind ? 'warn' : 'ok', 'Node.js updates (nodejs.org)', behind ? `${lts.version} is available for your release line (you have ${cur})` : `Up to date for this release line (${cur})`, behind ? 'Install the update from nodejs.org during a quiet hour; your data is not affected.' : null, behind ? ['node'] : null);
      const skew = nodeR.value.date ? Math.abs(Date.now() - Date.parse(nodeR.value.date)) / 1000 : 0;
      add(skew < 120 ? 'ok' : 'warn', 'Server clock', skew < 120 ? 'Matches internet time' : `About ${Math.round(skew / 60)} minutes off internet time`, skew < 120 ? null : 'Turn on automatic date and time on the server; task times depend on it.');
      add('ok', 'Internet from the server', 'Reachable');
    } else add('warn', 'Internet from the server', 'nodejs.org could not be reached', 'The server works on the local network without internet. Internet is only needed for AI and update checks.');
    if (anthR.status === 'fulfilled' && anthR.value.ok) { const st = anthR.value.json.status || {}; add(st.indicator === 'none' ? 'ok' : 'warn', 'AI service status (status.anthropic.com)', st.description || 'Unknown', st.indicator === 'none' ? null : 'AI answers may be slow or unavailable until the service recovers. Everything else keeps working.', st.indicator === 'none' ? null : ['status']); }
  }
  return C;
}

/* ---------------- AI proxy ---------------- */
const AIRATE = new Map();
async function ai(req, res, s) {
  if (!CFG.anthropicApiKey) return J(res, 503, { code: 'unavailable', error: 'AI is switched off on this server.' });
  const k = s.user, w = (AIRATE.get(k) || []).filter(t => t > Date.now() - 60000); if (w.length >= 30) return J(res, 429, { code: 'rate_limited', error: 'Too many AI requests. Wait a minute.' }); w.push(Date.now()); AIRATE.set(k, w);
  const b = await jbody(req); let msgs = typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : Array.isArray(b.input) ? b.input.filter(m => m && m.content).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })) : null;
  if (!msgs || !msgs.length) return J(res, 400, { error: 'Nothing to ask' });
  if (b.json) msgs[msgs.length - 1].content += '\n\nReply with valid JSON only, no other text.';
  try { const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': CFG.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: b.tier === 'quick' ? CFG.aiModelQuick : CFG.aiModel, max_tokens: 2500, messages: msgs }) });
    const j = await r.json(); if (!r.ok) return J(res, r.status === 429 ? 429 : 502, { code: r.status === 429 ? 'rate_limited' : 'unavailable', error: (j.error && j.error.message) || 'AI error' });
    J(res, 200, { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('') });
  } catch (e) { J(res, 502, { code: 'unavailable', error: 'The AI service could not be reached from the server.' }); }
}

/* ---------------- request router ---------------- */
async function handle(req, res) {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname), m = req.method;
  const s = session(req), me = s ? s.user : null;
  if (m === 'DELETE') { if (!p.startsWith('/api/doc/users/')) return J(res, 405, { error: 'Nothing can be deleted in QuestHR.' }); return deleteUser(req, res, me, p.slice(9)); }
  if (p === '/api/health') return J(res, 200, { questhr: true, version: VERSION, ai: !!CFG.anthropicApiKey, user: me, configured: !!org().configured, db: store.kind });
  if (p === '/api/login' && m === 'POST') {
    const b = await jbody(req), key = ip(req) + '|' + String(b.username || '').toLowerCase(), f = FAILS.get(key) || { n: 0, until: 0 };
    if (f.until > Date.now()) return J(res, 429, { error: `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} seconds.` });
    const fail = msg => { f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } FAILS.set(key, f); return J(res, 403, { error: msg }); };
    const usr = users().find(x => x.username === String(b.username || '').trim().toLowerCase());
    if (!usr || !usr.salt || usr.pass !== sha(String(b.password || ''), usr.salt)) return fail('Username or password is incorrect.');
    if (usr.active === false) return fail('This account is suspended. Contact your admin.');
    const site = (org().sites || []).find(x => x.id === usr.site);
    if (!site) return fail('Your admin has not assigned you a locality yet.');
    if (site.hash !== sha(String(b.wifi || ''), site.salt)) return fail(`That is not the Wi-Fi password for ${site.name}.`);
    FAILS.delete(key); const t = crypto.randomBytes(32).toString('hex'), exp = Date.now() + CFG.sessionHours * 36e5; SESS.set(t, { token: t, user: usr.id, exp }); store.sess_put(t, usr.id, exp);
    setCookie(res, req, 'qh_sid', t, CFG.sessionHours * 3600); log(`sign-in ${usr.username} from ${ip(req)}`); return J(res, 200, { id: usr.id, mustChange: !!usr.mustChange });
  }
  if (p === '/api/logout' && m === 'POST') { const t = cookies(req).qh_sid; if (t) { SESS.delete(t); store.sess_end(t); } setCookie(res, req, 'qh_sid', '', 0); return J(res, 200, { ok: true }); }
  if (p === '/api/password' && m === 'POST') { if (!s) return J(res, 401, { error: 'Sign in first.' }); const b = await jbody(req), usr = { ...userById(me) };
    if (!usr.mustChange && usr.pass !== sha(String(b.old || ''), usr.salt)) return J(res, 403, { error: 'Current password is incorrect.' });
    if (!pwOK(b.new)) return J(res, 400, { error: 'Use at least 8 characters with a letter and a number.' });
    usr.salt = crypto.randomBytes(8).toString('hex'); usr.pass = sha(b.new, usr.salt); usr.mustChange = false; commit('users/' + me, usr, me, req); return J(res, 200, { ok: true }); }
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }); res.write('retry: 3000\n\n');
    const c = { res, user: me }; CLIENTS.add(c); presence(); req.on('close', () => { CLIENTS.delete(c); presence(); }); return; }
  if (p.startsWith('/api/doc/')) {
    const dp = p.slice(9); if (!/^[a-z]+\/[\w.\-]+$/i.test(dp)) return J(res, 400, { error: 'Bad path' });
    if (m === 'GET') return J(res, 200, { data: view(me, dp, D.get(dp)) || null });
    if (m === 'PUT') {
      const boot = !me && (!org().configured || bootOK(req));
      if (!me && !boot) return J(res, 401, { code: 'unauthenticated', error: 'Sign in first.' });
      if (boot && !org().configured) { BOOT_IP = { ip: ip(req), until: Date.now() + 180000 }; const t = crypto.randomBytes(24).toString('hex'); BOOT.set(t, Date.now() + 30 * 60000); setCookie(res, req, 'qh_boot', t, 1800); }
      const data = await jbody(req), g = guard(me, dp, data, boot);
      if (g.err) return J(res, 400, { error: g.err });
      if (g.keep) { const cur = D.get(dp); if (cur) broadcast(dp, cur); return J(res, 200, { ok: true, ignored: true }); }
      commit(dp, g.next, me || 'setup', req); return J(res, 200, { ok: true });
    }
    return J(res, 405, { error: 'Not allowed' });
  }
  if (p.startsWith('/api/col/') && m === 'GET') {
    const col = p.slice(9); let f = []; try { f = JSON.parse(u.searchParams.get('f') || '[]'); } catch (e) {}
    const docs = []; for (const [k, v] of D) { if (!k.startsWith(col + '/')) continue;
      if (!f.every(([a, op, val]) => op === '>=' ? String(v[a] ?? '') >= val : op === '<' ? String(v[a] ?? '') < val : op === '==' ? v[a] === val : true)) continue;
      const vv = view(me, k, v); if (vv) docs.push({ id: k.slice(col.length + 1), data: vv }); }
    return J(res, 200, { docs });
  }
  if (p === '/api/files' && m === 'POST') {
    if (!s && !bootOK(req)) return J(res, 401, { error: 'Sign in first.' });
    const buf = await body(req, 60 * 1024 * 1024).catch(e => null); if (!buf) return J(res, 413, { error: 'Files up to 60 MB.' });
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32); const f = path.join(FILES, id.slice(0, 2), id);
    fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
    store.file_put({ id, name: decodeURIComponent(req.headers['x-name'] || 'file').slice(0, 200), type: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 120), size: buf.length, at: new Date().toISOString(), by: me || 'setup' });
    return J(res, 200, { id });
  }
  if (p.startsWith('/_blob/') && m === 'GET') { if (!s) return J(res, 401, { error: 'Sign in first.' }); const id = p.slice(7); if (!/^[0-9a-f]{32}$/.test(id)) return J(res, 404, { error: 'Not found' });
    const f = path.join(FILES, id.slice(0, 2), id), mt = store.file_get(id); if (!fs.existsSync(f)) return J(res, 404, { error: 'Not found' });
    const safeType = mt && /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|application\/vnd|application\/msword|text\/csv)/.test(mt.type) ? mt.type : 'application/octet-stream';
    res.writeHead(200, { 'content-type': safeType, 'content-disposition': `inline; filename="${encodeURIComponent(mt ? mt.name : id)}"`, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    return fs.createReadStream(f).pipe(res); }
  if (p === '/api/ai' && m === 'POST') { if (!s) return J(res, 401, { error: 'Sign in first.' }); return ai(req, res, s); }
  if (p === '/api/diagnostics') { if (!s) return J(res, 401, { error: 'Sign in first.' }); return J(res, 200, { checks: await diagnostics(u.searchParams.get('online') === '1', me) }); }
  if (p === '/api/repair' && m === 'POST') { if (!s || !(userById(me) || {}).admin) return J(res, 403, { error: 'Admins only.' }); store.checkpoint(); const b = backupNow(); return J(res, 200, { ok: true, backup: path.basename(b) }); }
  if (p.startsWith('/api/')) return J(res, 404, { error: 'Unknown endpoint' });
  if (m !== 'GET' && m !== 'HEAD') return J(res, 405, { error: 'Not allowed' });
  // static
  if (p === '/' || p === '/index.html') { if (!APP_FILE) return send(res, 500, 'The app file is missing: put index.html in the app folder.'); return send(res, 200, appHTML(), MIME['.html']); }
  if (p === '/manifest.webmanifest') return send(res, 200, JSON.stringify(MANIFEST), MIME['.webmanifest']);
  if (p === '/sw.js') return send(res, 200, SW, MIME['.js']);
  if (p.startsWith('/desktop/')) { const [name, content] = desktopFile(p.slice(9), baseUrl(req)); res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` }); return res.end(content); }
  const map = [['/icons/', ICONS], ['/vendor/', VENDOR], ['/docs/', path.join(PKG, 'docs')]];
  for (const [pre, dir] of map) if (p.startsWith(pre)) { const f = path.join(dir, path.basename(p)); if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=86400' }); return fs.createReadStream(f).pipe(res); } }
  return send(res, 404, 'Not found');
}
/* an admin may delete an account that has no work on record (e.g. created by mistake); anyone with history is suspended instead */
function deleteUser(req, res, me, dp) {
  const id = dp.slice(6), u = userById(id);
  if (!me || !(userById(me) || {}).admin) return J(res, 403, { error: 'Only an admin can delete accounts.' });
  if (!/^[\w.\-]+$/.test(id) || !u) return J(res, 404, { error: 'No such account.' });
  if (id === me) return J(res, 409, { error: 'You cannot delete your own account.' });
  if (users().some(x => x.reportsTo === id)) return J(res, 409, { error: `${u.name} has people reporting to them. Change their manager first.` });
  const used = [...D].some(([k, v]) => !k.startsWith('users/') && !k.startsWith('act/') && !k.startsWith('org/') && JSON.stringify(v).includes(`"${id}"`));
  if (used) return J(res, 409, { error: `${u.name} already has work on record (tasks, logs, requests or messages). Suspend the account instead so that history stays intact.` });
  D.delete(dp); store.remove(dp, me, u, ip(req)); journal(dp, null, me, ip(req));
  for (const [t, x] of SESS) if (x.user === id) SESS.delete(t);
  for (const c of CLIENTS) sse(c, 'doc', { path: dp, data: null });
  log(`account ${u.username} deleted by ${(userById(me) || {}).username}`);
  return J(res, 200, { ok: true });
}
function commit(p, next, by, req) { const prev = D.get(p); if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) return; D.set(p, next); const who = by || '', from = req ? ip(req) : '';
  store.write(p, next, who, prev, from); journal(p, next, who, from); broadcast(p, next); }

/* ---------------- start ---------------- */
function doctor() { (async () => { console.log(`QuestHR ${VERSION} doctor\n`); const c = await diagnostics(true); c.forEach(x => console.log(`${x.status === 'ok' ? ' OK ' : x.status === 'warn' ? 'WARN' : 'FAIL'}  ${x.title}: ${x.detail}${x.fix ? '\n      → ' + x.fix : ''}`));
  store.checkpoint(); console.log('\nSafe repairs: database checkpoint done. Backup written to', backupNow()); process.exit(0); })(); }
if (argv.includes('--doctor')) doctor();
else if (argv.includes('--backup-now')) { console.log('Backup written to', backupNow()); process.exit(0); }
else {
  const srv = http.createServer((req, res) => { handle(req, res).catch(e => { if (e && e.status) return J(res, e.status, { error: e.status === 413 ? 'Too large' : 'Bad request' }); console.error(e); J(res, 500, { error: 'Server error. Run Help > Run checks.' }); }); });
  srv.on('error', e => { if (e.code === 'EADDRINUSE') { console.error(`\nPort ${CFG.port} is already in use. QuestHR may already be running: open http://localhost:${CFG.port}\nTo use another port, change "port" in config.json.`); process.exit(3); } throw e; });
  srv.listen(CFG.port, CFG.host, () => {
    const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => `http://${n.address}:${CFG.port}`);
    console.log(`\n  QuestHR ${VERSION} is running\n  On this computer:  http://localhost:${CFG.port}\n${nets.map(n => '  On the network:    ' + n).join('\n')}\n  Data folder:       ${DATA}\n  Backups:           ${BACKUPS}\n  Database:          ${store.kind}\n  AI:                ${CFG.anthropicApiKey ? CFG.aiModel : 'off (add anthropicApiKey to config.json)'}\n`);
    if (argv.includes('--open')) { const url = `http://localhost:${CFG.port}`; const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`; require('child_process').exec(cmd); }
  });
  if (CFG.backupEveryHours > 0) { setTimeout(() => { try { backupNow(); } catch (e) { log('Backup failed:', e.message); } }, 60000).unref(); setInterval(() => { try { backupNow(); } catch (e) { log('Backup failed:', e.message); } }, CFG.backupEveryHours * 36e5).unref(); }
  const stop = () => { try { store.checkpoint(); store.flush && store.flush(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { VERSION };
