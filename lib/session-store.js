'use strict';
/**
 * 以 SQLite 持久化的 express-session store。
 * 取代預設 MemoryStore：重啟服務不會讓所有人被登出，也不會有記憶體只增不減的問題。
 * 資料存於 sessions/sessions.sqlite（目錄權限 700），與業務資料庫分開，不會被當成「資料庫」列出或備份。
 */
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3');

class SqliteSessionStore extends session.Store {
  constructor({ dir, ttlMs = 24 * 60 * 60 * 1000, cleanupMs = 15 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new sqlite3.Database(path.join(dir, 'sessions.sqlite'));
    try { fs.chmodSync(path.join(dir, 'sessions.sqlite'), 0o600); } catch (e) { /* 檔案可能尚未建立 */ }

    this.ready = new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA busy_timeout = 5000');
        this.db.run(
          `CREATE TABLE IF NOT EXISTS sessions (
             sid TEXT PRIMARY KEY,
             sess TEXT NOT NULL,
             expires INTEGER NOT NULL,
             user_id INTEGER
           )`,
          (err) => (err ? reject(err) : resolve())
        );
        this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)');
        this.db.run('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
      });
    });

    this._cleanup = setInterval(() => this.purgeExpired(), cleanupMs);
    if (this._cleanup.unref) this._cleanup.unref();
  }

  purgeExpired() {
    this.db.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()], () => {});
  }

  _expiryOf(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    const t = exp ? new Date(exp).getTime() : NaN;
    return Number.isFinite(t) ? t : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    this.ready.then(() => {
      this.db.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, null);
        if (row.expires <= Date.now()) {
          this.destroy(sid, () => cb(null, null));
          return;
        }
        try {
          cb(null, JSON.parse(row.sess));
        } catch (e) {
          cb(e);
        }
      });
    }, cb);
  }

  set(sid, sess, cb = () => {}) {
    this.ready.then(() => {
      const userId = sess && sess.userId ? sess.userId : null;
      this.db.run(
        'INSERT OR REPLACE INTO sessions (sid, sess, expires, user_id) VALUES (?, ?, ?, ?)',
        [sid, JSON.stringify(sess), this._expiryOf(sess), userId],
        (err) => cb(err || null)
      );
    }, cb);
  }

  touch(sid, sess, cb = () => {}) {
    this.ready.then(() => {
      this.db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [this._expiryOf(sess), sid], (err) => cb(err || null));
    }, cb);
  }

  destroy(sid, cb = () => {}) {
    this.ready.then(() => {
      this.db.run('DELETE FROM sessions WHERE sid = ?', [sid], (err) => cb(err || null));
    }, cb);
  }

  /** 使某使用者的其他 session 全部失效（改密碼、重設密碼、停用帳號時使用） */
  destroyByUserId(userId, exceptSid, cb = () => {}) {
    this.ready.then(() => {
      this.db.run(
        'DELETE FROM sessions WHERE user_id = ? AND sid != ?',
        [userId, exceptSid || ''],
        (err) => cb(err || null)
      );
    }, cb);
  }

  close(cb = () => {}) {
    clearInterval(this._cleanup);
    this.db.close(cb);
  }
}

module.exports = { SqliteSessionStore };
