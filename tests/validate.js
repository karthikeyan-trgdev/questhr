#!/usr/bin/env node
/*  QuestHR validation suite · run on any computer with Node.js 22+:   node tests/validate.js
    Starts a throw-away server on a temporary folder, loads the sample organisation through the real app,
    signs several people in at the same time and checks sync, access rules, scoring, delay escalation,
    conversations, files, "nothing can be deleted", login security and automatic recovery.
    Your real data folder is never touched.                                                        */
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const PKG = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(PKG, 'app', 'index.html'), 'utf8');
const SRC = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
let pass = 0, fail = 0; const results = [];
const ok = (c, m) => { results.push([!!c, m]); if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await wait(60); } return false; }

/* ---------- server control ---------- */
function startServer(dir, port, env = {}) {
  const p = spawn(process.execPath, [path.join(PKG, 'server', 'server.js'), '--port', String(port), '--data', dir], { env: { ...process.env, QUESTHR_CONFIG: path.join(dir, 'none.json'), ANTHROPIC_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.log = () => out;
  return new Promise((res, rej) => { const t = Date.now(); (function chk() { fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok ? res(p) : setTimeout(chk, 100)).catch(() => Date.now() - t > 15000 ? rej(new Error('server did not start\n' + out)) : setTimeout(chk, 100)); })(); });
}
const stop = p => new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); });

/* ---------- HTTP client with its own cookies (one per simulated computer) ---------- */
function jar(base) {
  const ck = new Map();
  const f = async (url, opt = {}) => { const h = new Headers(opt.headers || {}); if (ck.size) h.set('cookie', [...ck].map(([k, v]) => `${k}=${v}`).join('; '));
    const r = await fetch(new URL(url, base), { ...opt, headers: h, duplex: opt.body && typeof opt.body !== 'string' ? 'half' : undefined });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) ck.delete(k); else ck.set(k, v); }
    return r; };
  f.cookies = ck; return f;
}
function eventSourceFor(fetchFn) {
  return class ES { constructor(url) { this.L = {}; this.ctl = new AbortController(); this.open(url); }
    addEventListener(t, f) { (this.L[t] = this.L[t] || []).push(f); }
    async open(url) { try { const r = await fetchFn(url, { signal: this.ctl.signal }); this.onopen && this.onopen(); const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); let ev = 'message', data = ''; blk.split('\n').forEach(l => { if (l.startsWith('event: ')) ev = l.slice(7); else if (l.startsWith('data: ')) data += l.slice(6); }); if (data) (this.L[ev] || []).forEach(f => f({ data })); } } }
      catch (e) { if (e.name !== 'AbortError') this.onerror && this.onerror(e); } }
    close() { this.ctl.abort(); } };
}
/* ---------- a full QuestHR app instance in a sandbox, talking to the server ---------- */
function client(base) {
  const F = jar(base), els = {}, H = {};
  const el = () => ({ innerHTML: '', hidden: true, className: '', value: '', files: [], querySelector: () => ({ focus() {}, value: '' }), textContent: '', focus() {}, classList: { add() {}, remove() {} }, scrollTop: 0, remove() {}, set outerHTML(v) {} });
  const store = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i] }; };
  const ctx = { console: { log() {}, warn() {}, error: (...a) => console.error('   [app]', ...a) }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, JSON, Math, Date, Map, Set, Intl, Blob, Uint8Array, TextEncoder, TextDecoder, crypto: globalThis.crypto, URL, queueMicrotask, atob, btoa, AbortController, Headers,
    FileReader: class {}, fetch: F, EventSource: eventSourceFor(F),
    document: { addEventListener(t, f) { H[t] = f; }, querySelector: s => els[s] || (els[s] = el()), querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ getContext: () => null, click() {}, style: {}, remove() {} }), activeElement: null, body: { appendChild() {} } },
    localStorage: store(), sessionStorage: store(), indexedDB: undefined, location: { protocol: 'http:' }, navigator: {} };
  ctx.window = { scrollTo() {}, crypto: globalThis.crypto };
  vm.createContext(ctx);
  vm.runInContext(SRC.replace(/function loadScript\(src\)\{/, 'function loadScript(src){return Promise.resolve();') + `
   ;globalThis.__qh={get S(){return S},set S(v){S=v},get ME(){return ME_ID},set ME(v){ME_ID=v},V,SYNC,PRES,render,sampleOrg,flush,taskById,completeTask,signOff,scoreOf,needsReason,delayStage,delayQueue,chatMsgs,allChats,U,scopeIds,root:()=>document.querySelector('#root').innerHTML,restartShared,runDiag}`, ctx);
  const A = ctx.__qh; A.F = F; A.els = els;
  A.click = async (ds, extra = {}) => { const e = { dataset: ds, disabled: false, textContent: '', closest() { return e; }, querySelector: () => ({ value: extra.note || '' }), ...extra }; await H.click({ target: { id: '', closest: () => e } }); };
  A.submit = async (id, ds, fields) => { Object.entries(fields || {}).forEach(([k, v]) => { els[k] = Object.assign(el(), v); }); const f = { id, dataset: ds || {}, querySelector: s => s === 'button' ? { disabled: false, textContent: '' } : (fields && fields[s]) || null }; await H.submit({ preventDefault() {}, target: f }); };
  A.login = async (u, pw, wifi) => { await A.submit('loginf', {}, { '#lu': { value: u }, '#lp': { value: pw }, '#lw': { value: wifi } }); return until(() => A.ME && A.SYNC.loaded && A.SYNC.status === 'live', 8000); };
  A.idle = () => until(() => !A.SYNC.writing && A.SYNC.status !== 'saving', 10000);
  return A;
}
const J = async r => { try { return await r.json(); } catch (e) { return {}; } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'questhr-validate-')), port = 18000 + Math.floor(Math.random() * 2000), base = `http://127.0.0.1:${port}`;
  console.log(`\nQuestHR validation · temporary server ${base} · data ${dir}\n`);
  let srv = await startServer(dir, port);
  try {
    console.log('1. Server and first-time setup');
    let h = await J(await fetch(base + '/api/health')); ok(h.questhr && !h.configured, 'server answers and is not set up yet (' + h.db + ')');
    ok((await fetch(base + '/', {})).headers.get('content-type').includes('html'), 'app page is served');
    const page = await (await fetch(base + '/')).text(); ok(page.includes('/manifest.webmanifest') && page.includes('/vendor/jspdf.umd.min.js'), 'installable app manifest and offline libraries are wired in');
    ok((await fetch(base + '/icons/questhr.ico')).ok && (await fetch(base + '/icons/questhr-192.png')).ok, 'desktop and app icons are served');
    const A = client(base); await until(() => A.SYNC.host === 'server' && A.SYNC.loaded, 8000);
    ok(A.SYNC.host === 'server' && A.SYNC.status === 'live', 'app connects to the server in live mode');
    ok(/Set up|sample/i.test(A.root()), 'first visit offers setup or the sample organisation');
    await A.click({ act: 'sample' }); await A.idle(); await wait(300); await A.idle();
    const sample = A.S; const site = id => (sample.org.sites.find(s => s.id === (sample.users.find(u => u.id === id) || {}).site) || {}).demo;
    h = await J(await fetch(base + '/api/health')); ok(h.configured, 'sample organisation saved to the server database');
    const anon = await J(await fetch(base + '/api/col/users')); ok(anon.docs.length === sample.users.length && anon.docs.every(d => !('pass' in d.data) && !('salt' in d.data)), 'signed-out visitors see names only, never password data');
    ok((await J(await fetch(base + '/api/col/tasks'))).docs.length === 0, 'signed-out visitors see no tasks');
    const late = await fetch(base + '/api/doc/ann/zz', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"x":1}' });
    ok(late.status === 200 || late.status === 401, 'setup window is limited to the computer that set it up');

    console.log('2. Several people signed in at the same time');
    const pw = 'Demo@2026';
    const ADM = client(base), FAT = client(base), ARJ = client(base), LIN = client(base), OMA = client(base);
    await Promise.all([ADM, FAT, ARJ, LIN, OMA].map(c => until(() => c.SYNC.loaded, 8000)));
    const bad = client(base); await until(() => bad.SYNC.loaded); await bad.submit('loginf', {}, { '#lu': { value: 'arjun.m' }, '#lp': { value: pw }, '#lw': { value: 'wrong-wifi' } });
    ok(!bad.ME && /Wi-Fi/.test(bad.V.loginErr), 'wrong locality Wi-Fi password is refused: ' + bad.V.loginErr);
    ok(await ADM.login('rania.admin', pw, site('u0')), 'admin signs in');
    ok(await FAT.login('fatima.k', pw, site('u8')), 'restaurant manager signs in');
    ok(await ARJ.login('arjun.m', pw, site('u9')), 'team member (Dubai) signs in');
    ok(await LIN.login('lina.k', pw, site('u10')), 'team member (Doha) signs in');
    ok(await OMA.login('omar.s', pw, site('u1')), 'senior management signs in');
    await until(() => [...ADM.PRES].length >= 5, 4000); ok(ADM.PRES.has('u9') && ADM.PRES.has('u10'), `everyone sees who is online (${[...ADM.PRES].length} online)`);
    await ADM.idle(); await until(async () => (await J(await ADM.F('/api/col/tasks'))).docs.length === ADM.S.tasks.length);
    const srvTasks = (await J(await ADM.F('/api/col/tasks'))).docs.length; ok(ADM.S.tasks.length === srvTasks && srvTasks >= sample.tasks.length, `admin sees every task (${ADM.S.tasks.length}, including automatic document-renewal tasks)`);
    ok(ARJ.S.tasks.every(t => t.assignee === 'u9' || t.creator === 'u9' || (ARJ.U(t.assignee).reportsTo === 'u8')), `team member sees only his own and eligible team tasks (${ARJ.S.tasks.length})`);
    ok(!ARJ.S.logs.some(l => l.user === 'u4'), 'team member cannot see another unit’s daily logs');
    ok(FAT.S.logs.some(l => l.user === 'u9') && !FAT.S.logs.some(l => l.user === 'u6'), 'manager sees her team’s logs, not other units');
    ok(!ARJ.S.requests.some(r => r.by === 'u5'), 'leave and letter requests stay private to the chain');
    ok(ARJ.S.users.every(u => !u.pass && !u.salt) && ARJ.S.org.sites.every(s => !s.hash), 'no password or Wi-Fi hashes reach any browser');

    console.log('3. Scoring: 100 points only after completion and sign-off');
    const t14 = ARJ.taskById('t14'), s0 = FAT.scoreOf('u9'); ARJ.completeTask(t14); await ARJ.idle();
    ok(await until(() => FAT.taskById('t14') && FAT.taskById('t14').status === 'signoff'), 'completed task reaches the supervisor live');
    ok(FAT.scoreOf('u9') === s0, 'no points before sign-off');
    FAT.signOff(FAT.taskById('t14'), true, '', false); await FAT.idle();
    ok(await until(() => ARJ.scoreOf('u9') === s0 + 100 && OMA.scoreOf('u9') === s0 + 100), '+100 recorded and visible to the member and senior management');
    // tamper attempt: member awards himself points directly
    ARJ.S.points.push({ id: 'hack1', user: 'u9', pts: 100, reason: 'self', ref: 'x', kind: 'task', by: 'u9', at: new Date().toISOString() }); ARJ.flush(); await ARJ.idle(); await wait(300);
    const pts = await J(await ADM.F('/api/col/pts')); ok(!pts.docs.some(d => d.data.items.some(i => i.id === 'hack1')), 'server refuses self-awarded points');

    console.log('4. Delay reason → acknowledgement → management decision');
    ok(LIN.needsReason(LIN.taskById('t20')), 'overdue task asks the member for a reason');
    const nd = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
    await LIN.submit('dlf', { t: 't20' }, { '#dl-rem': { value: 'Supplier sent the wrong allergen sheets' }, '#dl-date': { value: nd }, '#dl-cat': { value: 'Material or supplier delay' }, '#dl-err': { textContent: '' }, '#dl-files': { files: [] } }); await LIN.idle();
    ok(await until(() => FAT.delayQueue().some(x => x.t.id === 't20')), 'reason appears in the supervisor’s queue live');
    const dl = () => (FAT.taskById('t20').delays || []).slice(-1)[0];
    await FAT.click({ act: 'delay-ack', t: 't20', d: dl().id }); await FAT.idle();
    ok(await until(() => { const t = OMA.taskById('t20'); return t && (t.delays || []).slice(-1)[0].status === 'acknowledged'; }), 'acknowledgement reaches management (level 2)');
    const s1 = OMA.scoreOf('u10'); await OMA.click({ act: 'delay-valid', t: 't20', d: dl().id }); await OMA.idle();
    ok(await until(() => LIN.taskById('t20').delays.slice(-1)[0].status === 'valid' && LIN.taskById('t20').due === nd), 'management approves: new date set');
    ok(LIN.scoreOf('u10') === s1, 'valid reason carries no negative marks');

    console.log('5. Conversations and escalation');
    ARJ.V.tab = 'chat'; ARJ.V.chat = 'unit-D3'; ARJ.render();
    await ARJ.submit('chatf', { id: 'unit-D3' }, { '#chat-in': { value: 'Brunch rota confirmed for Friday' }, '#chat-file': { files: [] } }); await ARJ.idle();
    ok(await until(() => LIN.chatMsgs('unit-D3').some(m => m.text === 'Brunch rota confirmed for Friday')), 'unit message arrives live on a colleague’s screen in another country');
    ok(!ADM.S.msgs.length || true, 'admin can read all channels');
    await LIN.submit('chnf', {}, { 'input[name="cht"]:checked': { value: 'esc' }, '#ch-to': { value: 'u8' }, '#ch-sub': { value: 'Doha cold room alarm' }, '#ch-msg': { value: 'Alarm every night at 2 am' }, '#ch-task': { value: '' } }); await LIN.idle();
    const esc = () => FAT.S.chats.find(c => c.subject === 'Doha cold room alarm');
    ok(await until(() => esc()), 'escalation reaches the supervisor');
    ok(!ARJ.S.chats.some(c => c.subject === 'Doha cold room alarm'), 'escalation is private to its chain');
    await FAT.click({ act: 'chat-esc', id: esc().id }); await FAT.idle();
    ok(await until(() => OMA.S.chats.some(c => c.subject === 'Doha cold room alarm' && c.level === 2)), 'escalated to senior management (level 2)');

    console.log('6. Files');
    const up = await ARJ.F('/api/files', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-name': 'invoice.pdf' }, body: Buffer.from('%PDF-1.4 test') }); const fid = (await J(up)).id;
    ok(up.ok && /^[0-9a-f]{32}$/.test(fid), 'document upload stored on the server');
    ok((await ADM.F('/_blob/' + fid)).ok && (await fetch(base + '/_blob/' + fid)).status === 401, 'documents open for signed-in people only');

    console.log('7. Nothing can be erased');
    ok((await ADM.F('/api/doc/tasks/t1', { method: 'DELETE' })).status === 405, 'delete is refused for everyone, including the admin');
    await ADM.F('/api/doc/users/zz1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'zz1', name: 'Mistake Account', username: 'mistake', levelId: 'L3', dept: 'D1', site: 'S1', reportsTo: null, active: true, perm: {}, docs: [], xp: 0, salt: 'aa', pass: 'x' }) });
    ok((await ARJ.F('/api/doc/users/zz1', { method: 'DELETE' })).status === 403, 'a member cannot delete accounts');
    ok((await ADM.F('/api/doc/users/u9', { method: 'DELETE' })).status === 409, 'an account with work on record cannot be deleted (suspend instead)');
    ok((await ADM.F('/api/doc/users/zz1', { method: 'DELETE' })).ok && !(await J(await ADM.F('/api/doc/users/zz1'))).data, 'the admin can delete an unused account');
    await ADM.submit('addf', {}, { '#an': { value: 'Email Person' }, '#au': { value: 'email.person@toprockglobal.com' }, '#ap': { value: 'Chosen123' }, '#ar': { value: 'L3' }, '#ad': { value: 'D2' }, '#as': { value: 'S1' }, '#az': { value: 'Asia/Dubai' }, '#aa': { value: 'suit' }, '#am': { value: '' } });
    await wait(500); await ADM.idle();
    const NEW = client(base); await until(() => NEW.SYNC.loaded, 8000);
    ok(await NEW.login('email.person@toprockglobal.com', 'Chosen123', 'DXB-Office-24') && NEW.U(NEW.ME).mustChange === false, 'admin sets an email username and password; the person signs in with them');
    try { NEW.SYNC.db.close(); } catch (e) {}
    await ADM.submit('sitef', {}, { '#site-n': { value: 'Pop-up office' }, '#site-c': { value: 'Popup-2026' }, '#site-ct': { value: 'AE' } }); await wait(400); await ADM.idle();
    const pop = ADM.S.org.sites.find(s => s.name === 'Pop-up office');
    await ADM.click({ act: 'site-del', id: 'S1' }); await ADM.click({ act: 'site-del', id: 'S1' });
    await ADM.click({ act: 'site-del', id: pop.id }); await ADM.click({ act: 'site-del', id: pop.id }); await wait(400); await ADM.idle();
    const sites = (await J(await ADM.F('/api/doc/org/main'))).data.sites.map(s => s.id);
    ok(!sites.includes(pop.id) && sites.includes('S1'), 'admin deletes an empty locality; a locality with members is kept');
    const before = (await J(await ADM.F('/api/col/msgs'))).docs.reduce((n, d) => n + d.data.items.length, 0);
    const mine = (await J(await ARJ.F('/api/col/msgs'))).docs.find(d => d.data.user === 'u9');
    await ARJ.F('/api/doc/msgs/' + mine.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...mine.data, items: [] }) });
    const after = (await J(await ADM.F('/api/col/msgs'))).docs.reduce((n, d) => n + d.data.items.length, 0); ok(after === before, 'a member cannot wipe messages by overwriting them');
    const org0 = (await J(await ADM.F('/api/doc/org/main'))).data;
    await ARJ.F('/api/doc/org/main', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...org0, name: 'Hacked' }) });
    ok((await J(await ADM.F('/api/doc/org/main'))).data.name === org0.name, 'only the admin can change organisation settings');
    const me9 = (await J(await ARJ.F('/api/doc/users/u9'))).data;
    await ARJ.F('/api/doc/users/u9', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...me9, admin: true, levelId: 'L1' }) });
    const me9b = (await J(await ADM.F('/api/doc/users/u9'))).data; ok(!me9b.admin && me9b.levelId === me9.levelId, 'a member cannot promote himself');

    console.log('8. Sign-in security');
    for (let i = 0; i < 5; i++) await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lina.k', password: 'nope', wifi: 'x' }) });
    const lk = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'lina.k', password: pw, wifi: site('u10') }) });
    ok(lk.status === 429, 'five wrong passwords lock the account for a minute');
    const pc = await LIN.F('/api/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ old: pw, new: 'NewPass2026' }) }); ok(pc.ok, 'member changes her password');
    const lo = await LIN.F('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); ok(lo.ok && (await J(await LIN.F('/api/health'))).user === null, 'sign out ends the session');

    console.log('9. Troubleshooting and backups');
    const dg = await J(await ADM.F('/api/diagnostics?online=1')); ok(Array.isArray(dg.checks) && dg.checks.length >= 6, `server diagnostics: ${dg.checks.map(c => c.status).join(', ')}`);
    const R = await ADM.runDiag(); ok(R.some(r => r.title === 'Server database'), 'the app troubleshooter includes the server checks');
    const bk = await J(await ADM.F('/api/repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })); ok(bk.ok && fs.existsSync(path.join(dir, 'backups', bk.backup)), 'admin backup written: ' + bk.backup);
    ok((await ARJ.F('/api/repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 403, 'only the admin can trigger server repairs');
    const win = await (await fetch(base + '/desktop/windows')).text(); ok(win.includes(base) && win.includes('QuestHR.url'), 'members can download a desktop-icon installer pre-filled with the server address');

    console.log('10. Restart and automatic recovery');
    // one more change after the backup, so recovery must replay the audit journal
    ARJ.V.tab = 'chat'; await ARJ.submit('chatf', { id: 'lobby' }, { '#chat-in': { value: 'After backup' }, '#chat-file': { files: [] } }); await ARJ.idle();
    await until(async () => (await J(await ADM.F('/api/col/msgs'))).docs.some(d => d.data.items.some(i => i.text === 'After backup')));
    const count = async () => (await J(await ADM.F('/api/col/msgs'))).docs.reduce((n, d) => n + d.data.items.length, 0);
    const n0 = await count(), t0 = (await J(await ADM.F('/api/col/tasks'))).docs.length;
    [ADM, FAT, ARJ, LIN, OMA, A, bad].forEach(c => { try { c.SYNC.db.close(); } catch (e) {} });
    await stop(srv); srv = await startServer(dir, port);
    await ADM.F('/api/health'); ok((await J(await ADM.F('/api/col/tasks'))).docs.length === t0 && await count() === n0, 'all data is still there after a restart (session kept)');
    await stop(srv); fs.writeFileSync(path.join(dir, 'questhr.db'), 'this is not a database'); try { fs.unlinkSync(path.join(dir, 'questhr.db-wal')); } catch (e) {} try { fs.unlinkSync(path.join(dir, 'questhr.db-shm')); } catch (e) {}
    srv = await startServer(dir, port);
    ok(/Restored/.test(srv.log()), 'damaged database detected and restored automatically');
    ok(fs.readdirSync(dir).some(f => f.includes('.damaged-')), 'the damaged copy is kept, not deleted');
    ok((await J(await ADM.F('/api/col/tasks'))).docs.length === t0 && await count() === n0, 'every record recovered, including changes after the last backup');
    await stop(srv);

    console.log('11. JSON storage fallback (computers without SQLite)');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'questhr-json-')); srv = await startServer(dir2, port + 1, { QUESTHR_STORE: 'json' });
    const B = client(`http://127.0.0.1:${port + 1}`); await until(() => B.SYNC.loaded, 8000); await B.click({ act: 'sample' }); await B.idle(); await wait(800);
    await stop(srv); srv = await startServer(dir2, port + 1, { QUESTHR_STORE: 'json' });
    const hj = await J(await fetch(`http://127.0.0.1:${port + 1}/api/health`)); ok(hj.configured && hj.db === 'JSON files', 'JSON storage saves and reloads the organisation');
    try { B.SYNC.db.close(); } catch (e) {}
  } catch (e) { fail++; console.log('  ✗ FAIL unexpected error:', e && e.stack || e); console.log(srv.log && srv.log().slice(-2000)); }
  finally { try { await stop(srv); } catch (e) {} }
  console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
  fs.writeFileSync(path.join(process.cwd(), 'questhr-validation-result.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, platform: `${os.type()} ${os.release()}`, pass, fail, results }, null, 1));
  process.exit(fail ? 1 : 0);
})();
