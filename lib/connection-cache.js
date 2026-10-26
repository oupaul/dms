/**
 * 有上限、可閒置回收的連線快取（用於每位使用者的 SQLite 連線）。
 *
 *  - max：快取連線數的軟上限。新增連線時若已達上限，會關閉最久未使用且目前沒有請求在用的連線；
 *    若全部都在使用中則不強制關閉（暫時超過上限，避免中斷進行中的請求）。
 *  - idleMs：超過此時間沒被取用且沒有請求在用的連線，會由 sweep() 關閉。
 *  - retain()/release()：請求期間標記連線「使用中」，使用中的連線不會被回收。
 *
 * 不依賴 sqlite3：開啟與關閉連線的方式由呼叫端提供，方便單元測試。
 */
class ConnectionCache {
  constructor({ max = 20, idleMs = 30 * 60 * 1000, close, now = Date.now, log = console } = {}) {
    if (typeof close !== 'function') throw new TypeError('ConnectionCache 需要 close(conn) 函式');
    this.max = max;
    this.idleMs = idleMs;
    this._close = close;
    this._now = now;
    this._log = log;
    this._entries = new Map();   // key -> { promise, conn, lastUsed, inUse }
    this._byConn = new Map();    // conn -> entry
    this._timer = null;
  }

  get size() { return this._entries.size; }

  has(key) { return this._entries.has(key); }

  // 取得（必要時以 open() 建立）連線；同一個 key 同時多次呼叫只會建立一條連線
  async get(key, open) {
    const existing = this._entries.get(key);
    if (existing) {
      existing.lastUsed = this._now();
      return existing.promise;
    }
    // 先同步挑出要回收的連線並從快取移除，再登記新連線——中間不能有 await，
    // 否則並發的同 key 請求會各自開一條連線
    const victims = this._takeVictims();
    const entry = { promise: null, conn: null, lastUsed: this._now(), inUse: 0 };
    entry.promise = Promise.resolve().then(open).then((conn) => {
      entry.conn = conn;
      this._byConn.set(conn, entry);
      return conn;
    }, (err) => {
      if (this._entries.get(key) === entry) this._entries.delete(key);
      throw err;
    });
    this._entries.set(key, entry);
    for (const [victimKey, victimEntry] of victims) await this._closeEntry(victimKey, victimEntry);
    return entry.promise;
  }

  // 標記某連線「使用中」，回傳 release()；通常綁在 res 的 close 事件
  retain(conn) {
    const entry = this._byConn.get(conn);
    if (!entry) return () => {};
    entry.inUse++;
    entry.lastUsed = this._now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.inUse = Math.max(0, entry.inUse - 1);
      entry.lastUsed = this._now();
    };
  }

  // 立即關閉並移除（不論是否使用中）；key 不存在時什麼都不做
  async evict(key) {
    const entry = this._entries.get(key);
    if (!entry) return false;
    await this._closeEntry(key, entry);
    return true;
  }

  // 關閉閒置過久、且沒有請求在用的連線；回傳被關閉的數量
  async sweep() {
    const cutoff = this._now() - this.idleMs;
    const stale = [...this._entries].filter(([, e]) => e.conn && e.inUse === 0 && e.lastUsed <= cutoff);
    for (const [key, entry] of stale) await this._closeEntry(key, entry);
    return stale.length;
  }

  startSweeper(intervalMs = Math.min(this.idleMs, 5 * 60 * 1000)) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.sweep().then((n) => {
        if (n > 0) this._log.log(`已關閉 ${n} 條閒置的資料庫連線（剩餘 ${this.size}）`);
      }).catch(err => this._log.error('回收閒置資料庫連線失敗:', err));
    }, intervalMs);
    this._timer.unref();
  }

  async closeAll() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    for (const [key, entry] of [...this._entries]) await this._closeEntry(key, entry);
  }

  // 為新連線騰出空間：把最久未使用且沒有請求在用的連線移出快取（同步），回傳 [key, entry] 讓呼叫端關閉
  _takeVictims() {
    const victims = [];
    while (this._entries.size >= this.max) {
      let victimKey = null;
      let victim = null;
      for (const [key, e] of this._entries) {
        if (!e.conn || e.inUse > 0) continue;
        if (!victim || e.lastUsed < victim.lastUsed) { victimKey = key; victim = e; }
      }
      if (!victim) {
        this._log.warn(`資料庫連線快取已達上限 ${this.max}，且全部使用中，暫時超過上限`);
        break;
      }
      this._log.log(`資料庫連線快取已達上限 ${this.max}，關閉最久未使用的連線: ${victimKey}`);
      this._entries.delete(victimKey);
      this._byConn.delete(victim.conn);
      victims.push([victimKey, victim]);
    }
    return victims;
  }

  async _closeEntry(key, entry) {
    if (this._entries.get(key) === entry) this._entries.delete(key);
    if (entry.conn) this._byConn.delete(entry.conn);
    try {
      const conn = entry.conn || await entry.promise.catch(() => null);
      if (conn) await this._close(conn);
    } catch (err) {
      this._log.error(`關閉資料庫連線失敗 (${key}):`, err);
    }
  }
}

module.exports = { ConnectionCache };
