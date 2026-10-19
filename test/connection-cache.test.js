'use strict';
/**
 * lib/connection-cache.js 單元測試：上限（LRU）、使用中不回收、閒置回收、並發只開一條連線
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionCache } = require('../lib/connection-cache');

const silent = { log() {}, warn() {}, error() {} };

function makeCache(opts = {}) {
  const clock = { t: 1000 };
  const closed = [];
  let opened = 0;
  const cache = new ConnectionCache({
    max: 3, idleMs: 60000, now: () => clock.t, log: silent,
    close: async (conn) => { closed.push(conn.id); },
    ...opts
  });
  const open = (id) => async () => ({ id: id + '#' + (++opened) });
  return { cache, clock, closed, open, opened: () => opened };
}

test('同一個 key 重複取用回傳同一條連線，並發只開一次', async () => {
  const { cache, open, opened } = makeCache();
  const [a, b] = await Promise.all([cache.get('k', open('k')), cache.get('k', open('k'))]);
  assert.equal(a, b);
  assert.equal(opened(), 1);
  assert.equal(await cache.get('k', open('k')), a);
  assert.equal(opened(), 1);
});

test('達上限時關閉最久未使用的連線', async () => {
  const { cache, clock, closed, open } = makeCache();
  const a = await cache.get('a', open('a')); clock.t += 10;
  await cache.get('b', open('b')); clock.t += 10;
  await cache.get('c', open('c')); clock.t += 10;
  await cache.get('a', open('a')); clock.t += 10; // a 變成最近使用，最久未用的是 b
  await cache.get('d', open('d'));
  assert.deepEqual(closed, ['b#2']);
  assert.equal(cache.size, 3);
  assert.equal(cache.has('b'), false);
  assert.equal(await cache.get('a', open('a')), a);
});

test('使用中的連線不會被回收；全部使用中時暫時超過上限', async () => {
  const { cache, clock, closed, open } = makeCache({ max: 2 });
  const a = await cache.get('a', open('a')); clock.t += 10;
  const b = await cache.get('b', open('b')); clock.t += 10;
  const releaseA = cache.retain(a);
  const releaseB = cache.retain(b);
  await cache.get('c', open('c'));
  assert.deepEqual(closed, []);
  assert.equal(cache.size, 3);
  releaseA(); releaseA(); // 重複 release 不會讓計數變負
  clock.t += 10;
  await cache.get('d', open('d'));
  assert.deepEqual(closed, ['a#1', 'c#3'].filter(x => closed.includes(x)));
  assert.ok(closed.includes('a#1'));
  assert.ok(!closed.includes('b#2'));
  releaseB();
});

test('sweep 只關閉閒置超過 idleMs 且沒有請求在用的連線', async () => {
  const { cache, clock, closed, open } = makeCache();
  const a = await cache.get('a', open('a'));
  await cache.get('b', open('b'));
  const release = cache.retain(a);
  clock.t += 61000;
  assert.equal(await cache.sweep(), 1);
  assert.deepEqual(closed, ['b#2']);
  release();
  clock.t += 61000;
  assert.equal(await cache.sweep(), 1);
  assert.deepEqual(closed, ['b#2', 'a#1']);
  assert.equal(cache.size, 0);
});

test('開啟失敗不會留在快取裡，可重試', async () => {
  const { cache, open } = makeCache();
  await assert.rejects(cache.get('k', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(cache.has('k'), false);
  const conn = await cache.get('k', open('k'));
  assert.ok(conn);
});

test('evict 立即關閉並移除；closeAll 關閉全部', async () => {
  const { cache, closed, open } = makeCache();
  await cache.get('a', open('a'));
  await cache.get('b', open('b'));
  assert.equal(await cache.evict('a'), true);
  assert.equal(await cache.evict('nope'), false);
  assert.deepEqual(closed, ['a#1']);
  await cache.closeAll();
  assert.deepEqual(closed, ['a#1', 'b#2']);
  assert.equal(cache.size, 0);
});
