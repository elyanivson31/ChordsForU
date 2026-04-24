const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const puppeteer = require('puppeteer');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  return undefined; // fall back to puppeteer's bundled Chromium
}

const app = express();
const PORT = process.env.PORT || 3334;
const SONGS_FILE = path.join(__dirname, 'songs.json');

app.use(express.static(path.join(__dirname, 'public')));

// ─── Song store (in-memory + persisted to songs.json) ─────────────────────
let songStore = {};

function loadStore() {
  try {
    if (fs.existsSync(SONGS_FILE))
      songStore = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
  } catch { songStore = {}; }
}

function saveStore() {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songStore, null, 2), 'utf8');
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('ton'); // strip Tab4U transposition param
    return u.toString();
  } catch { return rawUrl; }
}

function isUGUrl(url) {
  return /ultimate-guitar\.com/i.test(url);
}

loadStore();

// ─── Routes ───────────────────────────────────────────────────────────────

// List all saved songs (metadata only, no sections)
app.get('/api/songs', (_req, res) => {
  const list = Object.values(songStore).map(({ url, title, artist, isHebrew, savedAt }) =>
    ({ url, title, artist, isHebrew, savedAt })
  );
  list.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  res.json(list);
});

// Fetch (or return cached) song + save it
app.get('/api/song', (req, res) => {
  const rawUrl  = req.query.url;
  const cookies = req.query.cookies || '';
  if (!rawUrl) return res.status(400).json({ error: 'URL parameter is required' });

  const key = normalizeUrl(rawUrl);

  // Serve from cache if available
  if (songStore[key]) return res.json(songStore[key]);

  const fetcher = isUGUrl(rawUrl)
    ? fetchUGWithPuppeteer(rawUrl, cookies)
    : fetchUrl(rawUrl, cookies);

  fetcher
    .then(result => {
      const song = isUGUrl(rawUrl) ? parseUGData(result.data) : parseSong(result);
      songStore[key] = { ...song, url: key, savedAt: new Date().toISOString() };
      saveStore();
      res.json(songStore[key]);
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

// Debug: inspect raw HTML for a URL
app.get('/api/debug', (req, res) => {
  const rawUrl  = req.query.url;
  const cookies = req.query.cookies || '';
  if (!rawUrl) return res.status(400).json({ error: 'url required' });
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

// Delete a saved song
app.delete('/api/songs', (req, res) => {
  const key = normalizeUrl(req.query.url);
  delete songStore[key];
  saveStore();
  res.json({ ok: true });
});

// ─── Puppeteer fetch (for Cloudflare-protected sites) ─────────────────
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

    // Extract song data directly from the runtime JS state
    const data = await page.evaluate(() => {
      // Try window.UGAPP store
      if (window.UGAPP && window.UGAPP.store) return window.UGAPP.store;
      // Try common SSR data patterns
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
const HEBREW_RE = /[\u0590-\u05FF]/;

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
    throw new Error('Song content not found — your session may have expired. Open Tab4U in Chrome, copy the Cookie header (F12 → Network → any request) and paste it in the "Browser Cookies" field.');
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
      // On mixed tab+chord pages, orphan lyric rows come from the tab section — skip them.
      // On pure chord pages, treat them as section labels (e.g. "Verse", "Chorus").
      if (!hasTabs) sections.push({ type: 'label', text: text.trim() });
      i++;
    }
  }

  return { title, artist, isHebrew, sections };
}

// ─── Capo detection ───────────────────────────────────────────────────
const ROMAN_MAP = { I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12 };
function parseCapoFromText(text) {
  const m = text.match(/\bcapo\s*([IVXLC]+|\d+)/i);
  if (!m) return 0;
  const raw = m[1].toUpperCase();
  return ROMAN_MAP[raw] ?? (parseInt(raw) || 0);
}

// ─── Ultimate Guitar parser ───────────────────────────────────────────
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

  // Detect guitar tablature lines (e|---1--- style) vs chord/lyric lines
  const isTabLine = (l) => /^\s*[eEbBgGdDaA]\|/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Strip inline [tab]/[/tab] markers from the line
    const stripped = line.replace(/\[tab\]/gi, '').replace(/\[\/tab\]/gi, '');
    const strippedTrimmed = stripped.trim();

    // Skip lines that are now empty or pure guitar tab notation
    if (!strippedTrimmed || isTabLine(strippedTrimmed)) { i++; continue; }

    // Section label: [Verse 1], [Chorus], [Bridge] etc. — no [ch] inside
    if (strippedTrimmed.startsWith('[') && !strippedTrimmed.includes('[ch]')) {
      const label = strippedTrimmed.replace(/^\[/, '').replace(/\].*$/, '').trim();
      if (label) sections.push({ type: 'label', text: label });
      i++; continue;
    }

    // Chord line
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
  console.log(`\n  🎸 ChordCapo → http://localhost:${PORT}\n`);
  console.log(`  Songs stored: ${Object.keys(songStore).length}\n`);
});
