const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'chordcapo.db'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'chordcapo.db');
const db = new Database(DB_PATH);

// Enable WAL for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS songs (
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    artist TEXT,
    is_hebrew INTEGER DEFAULT 0,
    saved_at TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, url),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

// Insert default settings rows if missing
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')`);
insertSetting.run('tab4u_cookies');
insertSetting.run('ug_cookies');

// ─── Users ────────────────────────────────────────────────────────────────
function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getAllUsers() {
  return db.prepare('SELECT id, username, is_admin, created_at FROM users').all();
}

function createUser(id, username, passwordHash, isAdmin) {
  db.prepare('INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, passwordHash, isAdmin ? 1 : 0, new Date().toISOString());
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function updatePassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

function countAdmins() {
  return db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1').get().cnt;
}

// ─── Songs ────────────────────────────────────────────────────────────────
function getUserSongs(userId) {
  return db.prepare(
    'SELECT url, title, artist, is_hebrew, saved_at FROM songs WHERE user_id = ? ORDER BY saved_at DESC'
  ).all(userId).map(r => ({
    url: r.url,
    title: r.title,
    artist: r.artist,
    isHebrew: !!r.is_hebrew,
    savedAt: r.saved_at,
  }));
}

function getSong(userId, url) {
  const row = db.prepare('SELECT data FROM songs WHERE user_id = ? AND url = ?').get(userId, url);
  if (!row) return undefined;
  try { return JSON.parse(row.data); } catch { return undefined; }
}

function saveSong(userId, url, songObj) {
  db.prepare(`
    INSERT INTO songs (user_id, url, title, artist, is_hebrew, saved_at, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, url) DO UPDATE SET
      title    = excluded.title,
      artist   = excluded.artist,
      is_hebrew = excluded.is_hebrew,
      saved_at = excluded.saved_at,
      data     = excluded.data
  `).run(
    userId,
    url,
    songObj.title || null,
    songObj.artist || null,
    songObj.isHebrew ? 1 : 0,
    songObj.savedAt || new Date().toISOString(),
    JSON.stringify(songObj)
  );
}

function deleteSong(userId, url) {
  db.prepare('DELETE FROM songs WHERE user_id = ? AND url = ?').run(userId, url);
}

// ─── Settings ─────────────────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = {
  DB_PATH,
  getUser,
  getUserById,
  getAllUsers,
  createUser,
  deleteUser,
  updatePassword,
  countAdmins,
  getUserSongs,
  getSong,
  saveSong,
  deleteSong,
  getSetting,
  setSetting,
};
