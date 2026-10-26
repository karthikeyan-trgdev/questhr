#!/usr/bin/env node
// Used by the installers: updates config.json without touching any data.
// node server/configure.js [--data <folder>] [--backup <folder>] [--port <n>] [--detect-drive]
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const PKG = path.resolve(__dirname, '..'), FILE = path.join(PKG, 'config.json');
const a = process.argv.slice(2), get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
function googleDrive() {
  const h = os.homedir(), c = [];
  if (process.platform === 'win32') { for (const L of 'GHIJKLMNOPQRSTUVWXYZ') c.push(`${L}:\\My Drive`); c.push(path.join(h, 'Google Drive', 'My Drive'), path.join(h, 'My Drive'), path.join(h, 'Google Drive')); }
  else if (process.platform === 'darwin') { try { fs.readdirSync(path.join(h, 'Library', 'CloudStorage')).filter(d => d.startsWith('GoogleDrive')).forEach(d => c.push(path.join(h, 'Library', 'CloudStorage', d, 'My Drive'))); } catch (e) {} c.push(path.join(h, 'Google Drive', 'My Drive'), path.join(h, 'Google Drive')); }
  else c.push(path.join(h, 'GoogleDrive'), path.join(h, 'google-drive'), path.join(h, 'Google Drive'));
  return c.find(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }) || null;
}
if (a.includes('--detect-drive')) { const g = googleDrive(); console.log(g || ''); process.exit(0); }
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
if (get('--data')) cfg.dataDir = get('--data');
if (get('--backup')) cfg.backupDir = get('--backup');
if (get('--port')) cfg.port = +get('--port');
fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
console.log('config.json updated:', JSON.stringify({ port: cfg.port, dataDir: cfg.dataDir, backupDir: cfg.backupDir }));
