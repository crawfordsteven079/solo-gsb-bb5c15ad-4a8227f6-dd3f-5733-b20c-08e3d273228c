'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let db;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function getDb() {
  return db;
}

function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, process.env.DB_FILE || 'hearing.db');
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY,
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('recordist','reviewer','participant')),
    password_hash TEXT NOT NULL,
    salt         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    current_version_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    version_no  INTEGER NOT NULL,
    base_version_id INTEGER REFERENCES versions(id),
    content     TEXT NOT NULL,                  -- JSON: [{seg_no, text}]
    note        TEXT NOT NULL DEFAULT '',
    published_by INTEGER REFERENCES users(id),
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    proposal_seq INTEGER NOT NULL DEFAULT 0,    -- 发布时已存在的最大提案 id（决议水位）
    UNIQUE(document_id, version_no)
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id           INTEGER PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES documents(id),
    base_version_id INTEGER NOT NULL REFERENCES versions(id),
    seg_no       TEXT NOT NULL,
    start        INTEGER NOT NULL,              -- Unicode 码点偏移
    end          INTEGER NOT NULL,              -- 不含
    old_text     TEXT NOT NULL,                 -- 提交时服务端校验的原文片段
    new_text     TEXT NOT NULL,
    basis        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','adopted','rejected','conflicted','merged')),
    conflict_reason TEXT NOT NULL DEFAULT '',
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by   INTEGER REFERENCES users(id),
    decided_at   TEXT,
    merged_into_version_id INTEGER REFERENCES versions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_prop_doc ON proposals(document_id);
  CREATE INDEX IF NOT EXISTS idx_prop_base ON proposals(base_version_id, status);

  CREATE TABLE IF NOT EXISTS objections (
    id           INTEGER PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES documents(id),
    seg_no       TEXT NOT NULL,
    quote        TEXT NOT NULL,                 -- 被引原文
    comment      TEXT NOT NULL,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS objection_anchors (
    id           INTEGER PRIMARY KEY,
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    version_id   INTEGER NOT NULL REFERENCES versions(id),
    seg_no       TEXT NOT NULL,
    start        INTEGER,                       -- 有效时的码点偏移；broken 时为 NULL
    end          INTEGER,
    quote        TEXT NOT NULL,                 -- 该版本中的原文快照
    state        TEXT NOT NULL CHECK (state IN ('anchored','broken','reanchored')),
    note         TEXT NOT NULL DEFAULT '',
    UNIQUE(objection_id, version_id)
  );
  CREATE INDEX IF NOT EXISTS idx_anchors_version ON objection_anchors(version_id);
  `);

  seedUsers();
  return db;
}

function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const defaults = [
    { username: 'recordist', role: 'recordist', display: '记录员' },
    { username: 'reviewer', role: 'reviewer', display: '复核员' },
    { username: 'participant', role: 'participant', display: '参与者' },
  ];
  const ins = db.prepare(
    'INSERT INTO users (username, display_name, role, password_hash, salt) VALUES (?,?,?,?,?)'
  );
  const envPasswords = {
    recordist: process.env.PASSWORD_RECORDIST,
    reviewer: process.env.PASSWORD_REVIEWER,
    participant: process.env.PASSWORD_PARTICIPANT,
  };
  for (const u of defaults) {
    const password = envPasswords[u.username] || u.username; // 默认口令与用户名相同
    const salt = crypto.randomBytes(16).toString('hex');
    ins.run(u.username, u.display, u.role, hashPassword(password, salt), salt);
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000)
    .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, expires);
  return token;
}

function getUserByToken(token) {
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
  return row || null;
}

function getUserByCredentials(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  const hash = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.password_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return user;
}

module.exports = { initDb, getDb, createSession, getUserByToken, getUserByCredentials };
