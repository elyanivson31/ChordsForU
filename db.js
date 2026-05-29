const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
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
  await pool.query(`INSERT INTO settings (key, value) VALUES ('tab4u_cookies', '') ON CONFLICT (key) DO NOTHING`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('ug_cookies', '') ON CONFLICT (key) DO NOTHING`);
}

// ─── Users ────────────────────────────────────────────────────────────────
async function getUser(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getAllUsers() {
  const { rows } = await pool.query('SELECT id, username, is_admin, created_at FROM users');
  return rows;
}

async function createUser(id, username, passwordHash, isAdmin) {
  await pool.query(
    'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, username, passwordHash, isAdmin ? 1 : 0, new Date().toISOString()]
  );
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

async function updatePassword(id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}

async function countAdmins() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM users WHERE is_admin = 1');
  return parseInt(rows[0].cnt, 10);
}

// ─── Songs ────────────────────────────────────────────────────────────────
async function getUserSongs(userId) {
  const { rows } = await pool.query(
    'SELECT url, title, artist, is_hebrew, saved_at FROM songs WHERE user_id = $1 ORDER BY saved_at DESC',
    [userId]
  );
  return rows.map(r => ({
    url: r.url,
    title: r.title,
    artist: r.artist,
    isHebrew: !!r.is_hebrew,
    savedAt: r.saved_at,
  }));
}

async function getSong(userId, url) {
  const { rows } = await pool.query('SELECT data FROM songs WHERE user_id = $1 AND url = $2', [userId, url]);
  if (!rows[0]) return null;
  try { return JSON.parse(rows[0].data); } catch { return null; }
}

async function saveSong(userId, url, songObj) {
  await pool.query(`
    INSERT INTO songs (user_id, url, title, artist, is_hebrew, saved_at, data)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, url) DO UPDATE SET
      title     = EXCLUDED.title,
      artist    = EXCLUDED.artist,
      is_hebrew = EXCLUDED.is_hebrew,
      saved_at  = EXCLUDED.saved_at,
      data      = EXCLUDED.data
  `, [
    userId,
    url,
    songObj.title || null,
    songObj.artist || null,
    songObj.isHebrew ? 1 : 0,
    songObj.savedAt || new Date().toISOString(),
    JSON.stringify(songObj),
  ]);
}

async function deleteSong(userId, url) {
  await pool.query('DELETE FROM songs WHERE user_id = $1 AND url = $2', [userId, url]);
}

// ─── Settings ─────────────────────────────────────────────────────────────
async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : '';
}

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

module.exports = {
  initDb,
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
