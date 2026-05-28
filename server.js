const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const puppeteer = require('puppeteer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  return undefined;
}

const app = express();
const PORT = process.env.PORT || 3334;
const DATA_DIR = path.join(__dirname, 'data');

// ─── Data directory setup ────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ─── Users ───────────────────────────────────────────────────────────────
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function initDefaultAdmin() {
  let users = loadUsers();
  if (users.length > 0) return;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 10; i++) password += chars[Math.floor(Math.random() * chars.length)];
  const passwordHash = bcrypt.hashSync(password, 10);
  const admin = { id: uuidv4(), username: 'admin', passwordHash, isAdmin: true, createdAt: new Date().toISOString() };
  users = [admin];
  saveUsers(users);
  console.log('\n  ┌─────────────────────────────────────────┐');
  console.log('  │   DEFAULT ADMIN CREDENTIALS             │');
  console.log('  │   Username: admin                       │');
  console.log(`  │   Password: ${password}          │`);
  console.log('  └─────────────────────────────────────────┘\n');
}

initDefaultAdmin();

// ─── Settings ────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  return { tab4uCookies: '', ugCookies: '' };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

if (!fs.existsSync(SETTINGS_FILE)) saveSettings({ tab4uCookies: '', ugCookies: '' });

// ─── Per-user song store ──────────────────────────────────────────────────
function songsFile(userId) {
  return path.join(DATA_DIR, `songs_${userId}.json`);
}

function loadUserSongs(userId) {
  try {
    const f = songsFile(userId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return {};
}

function saveUserSongs(userId, store) {
  fs.writeFileSync(songsFile(userId), JSON.stringify(store, null, 2), 'utf8');
}

// ─── Middleware ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'chordcapo-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin required' });
  next();
}

// ─── Auth routes ──────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid username or password' });
  req.session.userId  = user.id;
  req.session.isAdmin = user.isAdmin;
  res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin });
});

// ─── Song routes ──────────────────────────────────────────────────────────
app.get('/api/songs', requireAuth, (req, res) => {
  const store = loadUserSongs(req.session.userId);
  const list = Object.values(store).map(({ url, title, artist, isHebrew, savedAt }) =>
    ({ url, title, artist, isHebrew, savedAt })
  );
  list.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  res.json(list);
});

app.get('/api/song', requireAuth, (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'URL parameter is required' });

  const key = normalizeUrl(rawUrl);
  const store = loadUserSongs(req.session.userId);

  if (store[key]) return res.json(store[key]);

  const settings = loadSettings();
  const cookies = isUGUrl(rawUrl) ? (settings.ugCookies || '') : (settings.tab4uCookies || '');

  const fetcher = isUGUrl(rawUrl)
    ? fetchUGWithPuppeteer(rawUrl, cookies)
    : fetchUrl(rawUrl, cookies);

  fetcher
    .then(result => {
      const song = isUGUrl(rawUrl) ? parseUGData(result.data) : parseSong(result);
      store[key] = { ...song, url: key, savedAt: new Date().toISOString() };
      saveUserSongs(req.session.userId, store);
      res.json(store[key]);
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

app.delete('/api/songs', requireAuth, (req, res) => {
  const key = normalizeUrl(req.query.url);
  const store = loadUserSongs(req.session.userId);
  delete store[key];
  saveUserSongs(req.session.userId, store);
  res.json({ ok: true });
});

// ─── Debug route ──────────────────────────────────────────────────────────
app.get('/api/debug', requireAuth, (req, res) => {
  const rawUrl  = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'url required' });
  const settings = loadSettings();
  const cookies = isUGUrl(rawUrl) ? (settings.ugCookies || '') : (settings.tab4uCookies || '');
  const fetcher = isUGUrl(rawUrl) ? fetchUGWithPuppeteer(rawUrl, cookies) : fetchUrl(rawUrl, cookies);
  fetcher
    .then(result => {
      if (isUGUrl(rawUrl)) {
        const d = result.data;
        return res.json({
          gotData: !!d,
          topLevelKeys: d ? Object.keys(d) : null,
          pageKeys: d?.page ? Object.keys(d.page) : null,
          pageDataKeys: d?.page?.data ? Object.keys(d.page.data) : null,
          tabViewKeys: d?.page?.data?.tab_view ? Object.keys(d.page.data.tab_view) : null,
          contentSnippet: d?.page?.data?.tab_view?.wiki_tab?.content?.substring(0, 400) || null,
          tabInfo: d?.page?.data?.tab ? { title: d.page.data.tab.song_name, artist: d.page.data.tab.artist_name } : null,
        });
      }
      const html = result;
      res.json({ length: html.length, preview: html.substring(0, 400) });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

// ─── Admin routes ─────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = loadUsers().map(({ id, username, isAdmin, createdAt }) => ({ id, username, isAdmin, createdAt }));
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const users = loadUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already exists' });
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = { id: uuidv4(), username, passwordHash, isAdmin: !!isAdmin, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  res.json({ id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  let users = loadUsers();
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.isAdmin) {
    const adminCount = users.filter(u => u.isAdmin).length;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the only admin' });
  }
  users = users.filter(u => u.id !== id);
  saveUsers(users);
  const sf = songsFile(id);
  if (fs.existsSync(sf)) fs.unlinkSync(sf);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/password', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = bcrypt.hashSync(password, 10);
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(loadSettings());
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = loadSettings();
  const { tab4uCookies, ugCookies } = req.body || {};
  if (tab4uCookies !== undefined) settings.tab4uCookies = tab4uCookies;
  if (ugCookies !== undefined) settings.ugCookies = ugCookies;
  saveSettings(settings);
  res.json(settings);
});

// ─── Utility ──────────────────────────────────────────────────────────────
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('ton');
    return u.toString();
  } catch { return rawUrl; }
}

function isUGUrl(url) {
  return /ultimate-guitar\.com/i.test(url);
}

// ─── Puppeteer fetch ──────────────────────────────────────────────────────
async function fetchUGWithPuppeteer(targetUrl, cookies = '') {
  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');

    if (cookies) {
      const hostname = new URL(targetUrl).hostname;
      const parsed = cookies.split(';').map(c => {
        const [name, ...rest] = c.trim().split('=');
        return { name: name.trim(), value: rest.join('=').trim(), domain: hostname };
      }).filter(c => c.name);
      await page.setCookie(...parsed);
    }

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const data = await page.evaluate(() => {
      if (window.UGAPP && window.UGAPP.store) return window.UGAPP.store;
      const el = document.querySelector('.js-store[data-content]');
      if (el) return JSON.parse(el.dataset.content);
      return null;
    });

    return { type: 'ug-data', data };
  } finally {
    await browser.close();
  }
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────
function fetchUrl(targetUrl, cookies = '', redirected = false) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return reject(new Error('Invalid URL')); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,he;q=0.8',
      'cache-control': 'no-cache',
    };
    if (cookies) headers['cookie'] = cookies;

    const options = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers };

    lib.get(options, (resp) => {
      if ((resp.statusCode === 301 || resp.statusCode === 302) && resp.headers.location && !redirected)
        return fetchUrl(resp.headers.location, cookies, true).then(resolve).catch(reject);
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// ─── Parsing ──────────────────────────────────────────────────────────────
const HEBREW_RE = /[֐-׿]/;

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractRowText(rowHtml) {
  return rowHtml
    .replace(/&nbsp;/g, '\x00')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)))
    .replace(/&amp;/g, '&')
    .replace(/[^\S\x00\n]+/g, ' ')
    .replace(/\n/g, '')
    .replace(/\x00/g, ' ')
    .trimEnd();
}

function parseSong(html) {
  const startIdx = html.indexOf('id="songContentTPL"');
  if (startIdx === -1) {
    if (!html.includes('tab4u') && !html.includes('Tab4U'))
      throw new Error('Not a Tab4U page — check the URL.');
    throw new Error('Song content not found — your session may have expired. Open Tab4U in Chrome, copy the Cookie header (F12 → Network → any request) and paste it in the Admin settings.');
  }

  let raw = html.substring(startIdx, startIdx + 80000);
  const endIdx = raw.indexOf('id="ratingWrap"');
  if (endIdx > 0) raw = raw.substring(0, endIdx);

  let title = '', artist = '';
  const pt = html.match(/<title>([^<]+)<\/title>/i);
  if (pt) {
    const clean = decodeEntities(pt[1].replace(/\s*\|.*$/, '').trim());
    const byHebrew = clean.match(/אקורדים לשיר\s+(.+?)\s+של\s+(.+)$/);
    const byDash   = clean.match(/אקורדים לשיר\s+(.+?)\s+-\s+(.+)$/);
    if (byHebrew)    { title = byHebrew[1].trim(); artist = byHebrew[2].trim(); }
    else if (byDash) { title = byDash[1].trim();   artist = byDash[2].trim(); }
    else               title = clean.replace(/^אקורדים לשיר\s+/, '').trim();
  }

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(raw)) !== null) {
    const rowHtml = m[1];
    const isChord = /class=['"]chords['"]/.test(rowHtml);
    const isSong  = /class=['"]song['"]/.test(rowHtml);
    if (!isChord && !isSong) continue;
    const text = extractRowText(rowHtml);
    if (!text.trim()) continue;
    rows.push({ type: isChord ? 'chord' : 'text', text });
  }

  const hasTabs = /class=['"]tabs['"]/.test(raw);
  const hasChords = rows.some(r => r.type === 'chord');
  if (!hasChords)
    throw new Error(hasTabs
      ? 'This page contains guitar tablature, not chord charts. Find the chord version of this song on Tab4U.'
      : 'No chord rows found — this song may require a premium account.');

  const isHebrew = HEBREW_RE.test(rows.map(r => r.text).join(' '));

  const sections = [];
  let i = 0;
  while (i < rows.length) {
    const { type, text } = rows[i];
    if (type === 'chord') {
      const next = rows[i + 1];
      const hasLyric = next && next.type === 'text';
      sections.push({ type: 'line', chord: text, lyric: hasLyric ? next.text.trim() : '' });
      i += hasLyric ? 2 : 1;
    } else {
      if (!hasTabs) sections.push({ type: 'label', text: text.trim() });
      i++;
    }
  }

  return { title, artist, isHebrew, sections };
}

// ─── Capo detection ───────────────────────────────────────────────────────
const ROMAN_MAP = { I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12 };
function parseCapoFromText(text) {
  const m = text.match(/\bcapo\s*([IVXLC]+|\d+)/i);
  if (!m) return 0;
  const raw = m[1].toUpperCase();
  return ROMAN_MAP[raw] ?? (parseInt(raw) || 0);
}

// ─── Ultimate Guitar parser ───────────────────────────────────────────────
function parseUGData(store) {
  if (!store) throw new Error('No data returned from Ultimate Guitar page. Try again or check the URL.');

  const pageData = store?.page?.data;
  if (!pageData) throw new Error('Unexpected Ultimate Guitar page structure.');

  const content = pageData.tab_view?.wiki_tab?.content;
  if (!content) throw new Error('No chord content found — make sure you are on a Chords page (not a Tab page).');

  const tabInfo = pageData.tab || {};
  const title  = tabInfo.song_name  || '';
  const artist = tabInfo.artist_name || '';

  const lines = content.split(/\r?\n/);
  const sections = [];
  let i = 0;

  const isTabLine = (l) => /^\s*[eEbBgGdDaA]\|/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/\[tab\]/gi, '').replace(/\[\/tab\]/gi, '');
    const strippedTrimmed = stripped.trim();

    if (!strippedTrimmed || isTabLine(strippedTrimmed)) { i++; continue; }

    if (strippedTrimmed.startsWith('[') && !strippedTrimmed.includes('[ch]')) {
      const label = strippedTrimmed.replace(/^\[/, '').replace(/\].*$/, '').trim();
      if (label) sections.push({ type: 'label', text: label });
      i++; continue;
    }

    if (stripped.includes('[ch]')) {
      const chord = stripped.replace(/\[ch\]/g, '').replace(/\[\/ch\]/g, '').trimEnd();
      const next = lines[i + 1];
      const hasLyric = next !== undefined
        && !next.includes('[ch]')
        && !next.trim().startsWith('[')
        && !isTabLine(next);
      sections.push({ type: 'line', chord, lyric: hasLyric ? next.trim() : '' });
      i += hasLyric ? 2 : 1;
      continue;
    }

    i++;
  }

  if (sections.length === 0)
    throw new Error('No chords found — make sure you are on a Chords page (not a Tab page) on Ultimate Guitar.');

  const isHebrew = HEBREW_RE.test([title, artist, ...sections.map(s => s.lyric || s.text || '')].join(' '));
  const originalCapo = parseCapoFromText(content);
  return { title, artist, isHebrew, sections, originalCapo };
}

app.listen(PORT, () => {
  console.log(`\n  ChordCapo -> http://localhost:${PORT}\n`);
});
