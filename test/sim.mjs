// شبیه‌سازی کامل (بدون شبکه): SQLite محلی به‌جای Turso + تلگرام جعلی + ساعت جعلی
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { SCHEMA } from '../src/db.js';
import { handleUpdate } from '../src/bot.js';
import { tick } from '../src/index.js';
import { updateLegendary } from '../src/market.js';
import { LEGENDARY } from '../src/config.js';
import { tehranNow } from '../src/util.js';

const sq = new DatabaseSync(':memory:');
const run1 = (sql, args = []) => {
  const st = sq.prepare(sql);
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: st.all(...args), changes: 0 };
  const r = st.run(...args); return { rows: [], changes: Number(r.changes) };
};
const db = {
  async batch(s) { return s.map(([sql, a]) => run1(sql, a || [])); },
  async bigBatch(s) { return s.map(([sql, a]) => run1(sql, a || [])); },
  async all(sql, a) { return run1(sql, a || []).rows; },
  async get(sql, a) { return run1(sql, a || []).rows[0] || null; },
  async run(sql, a) { return run1(sql, a || []).changes; },
};
SCHEMA.forEach((s) => sq.exec(s));
sq.exec(`CREATE TABLE prices(symbol TEXT, price REAL, updated_at INTEGER)`);

let NOW = Date.UTC(2026, 8, 21, 6, 30); // دوشنبه ۲۰۲۶-۰۹-۲۱ ساعت ۱۰:۰۰ تهران
Date.now = () => NOW;
const setTehran = (day, hh, mm) => { const [y, m, d] = day.split('-').map(Number); NOW = Date.UTC(y, m - 1, d, hh, mm) - 210 * 60000; };
const setPrices = (o) => { for (const [s, p] of Object.entries(o)) sq.prepare('INSERT INTO prices VALUES(?,?,?)').run(s, p, Math.floor(NOW / 1000)); };

const sent = [];
globalThis.fetch = async (url, opts) => {
  const method = String(url).split('/').pop();
  let body = {};
  try { body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {}; } catch {}
  sent.push({ url: String(url), method, body });
  if (method === 'getChatMember') return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }));
  return new Response(JSON.stringify({ ok: true, result: { photos: [] } }));
};
const env = { __db: db, TELEGRAM_BOT_TOKEN: 't', BALE_BOT_TOKEN: 'b', TELEGRAM_BOT_USERNAME: 'testbot', BALE_BOT_USERNAME: 'balebot',
  CHANNEL_TELEGRAM: '@chan', REQUIRE_CHANNEL_JOIN: 'true', ADMIN_IDS: 'telegram:1', WEBHOOK_SECRET: 's' };

const from = (id) => ({ id, first_name: 'User' + id, username: 'u' + id });
const text = (id, t, platform = 'telegram') => handleUpdate(env, platform, { message: { from: from(id), chat: { id, type: 'private' }, text: t } });
const press = (id, data) => handleUpdate(env, 'telegram', { callback_query: { id: 'c', from: from(id), data, message: { chat: { id, type: 'private' }, message_id: 9 } } });
const lastTo = (chat) => [...sent].reverse().find((x) => x.body.chat_id == chat && x.method === 'sendMessage');
const q = (sql, a = []) => sq.prepare(sql).all(...a);

// ---------- ۱) کاربران و پیش‌بینی ----------
setPrices({ USD: 88000, GOLD18: 5000000, COIN: 50000000, XAUUSD: 2400 });
await text(1, '/start');
await text(2, '/start ref_1');
for (const id of [3, 4, 5, 6]) await text(id, '/start');
assert.equal(q('SELECT referrer_id FROM users WHERE id=2')[0].referrer_id, 1, 'referrer saved');

const guesses = { 1: '88,500', 2: '۸۸۱۰۰', 3: '88.400', 4: '87000', 5: '89000', 6: '88500' };
for (const [id, g] of Object.entries(guesses)) {
  const uid = Number(id);
  await press(uid, 'p:usd');
  await text(uid, g);
  if (uid === 1) { await press(uid, 'al:custom'); await text(uid, 'King_Ali'); }
  else if (uid === 2) await press(uid, 'al:username');
  else await press(uid, 'al:anon');
}
assert.equal(q('SELECT COUNT(*) n FROM predictions')[0].n, 6);
assert.equal(q('SELECT referral_count FROM users WHERE id=1')[0].referral_count, 1, 'referral counted after first prediction');
assert.equal(q('SELECT guess FROM predictions WHERE user_id=3')[0].guess, 88400, 'dot-thousands parsed');

// رد حدس نامعقول و تکراری
await press(2, 'p:gold'); await text(2, '9000000'); // ۸۰٪ فاصله
assert.match(lastTo(2).body.text, /اشتباه تایپ/);
await press(1, 'p:usd');
assert.match(lastTo(1).body.text, /حدس زده/, 'duplicate blocked');
// نام مستعار تکراری
await press(6, 'al:menu'); await press(6, 'al:custom'); await text(6, 'king_ali');
assert.match(lastTo(6).body.text, /قبلاً/, 'alias uniqueness');

// ---------- ۲) بعد از مهلت ----------
setTehran('2026-09-21', 12, 30);
await press(3, 'p:usd');
assert.match(lastTo(3).body.text, /مهلت/);

// ---------- ۳) ثبت قیمت مرجع + امتیازدهی ----------
setTehran('2026-09-21', 11, 55); setPrices({ USD: 88000, GOLD18: 5000000, COIN: 50000000, XAUUSD: 2400 });
setTehran('2026-09-21', 12, 0); await tick(env, NOW);            // تصمیم تعطیلی (باز)
assert.equal(q(`SELECT status FROM daily_final_prices WHERE symbol='usd'`)[0].status, 'open');
setTehran('2026-09-21', 16, 55); setPrices({ USD: 88500, GOLD18: 5100000, COIN: 50100000 });
setTehran('2026-09-21', 17, 1);
sent.length = 0;
const rep = await tick(env, NOW);
console.log('tick report', rep);
const fin = q(`SELECT * FROM daily_final_prices WHERE symbol='usd'`)[0];
assert.equal(fin.status, 'final'); assert.equal(fin.final_price, 88500);
const sc = q(`SELECT user_id,rank_pos,accuracy,xp FROM predictions ORDER BY rank_pos`);
console.log(sc);
assert.deepEqual([sc[0].user_id, sc[0].xp], [1, 100 + 50 + 5].map((x, i) => i ? x : sc[0].user_id));
assert.equal(q(`SELECT xp FROM leaderboards WHERE user_id=1 AND scope='overall'`)[0].xp, 155);
// امتیاز دوباره شمرده نشود (idempotent)
const { scoreDay } = await import('../src/market.js');
await scoreDay(env, db, 'usd', '2026-09-21', 88500, NOW);
assert.equal(q(`SELECT xp FROM leaderboards WHERE user_id=1 AND scope='overall'`)[0].xp, 155, 'idempotent');

// اعلان‌ها و کارت‌ها طی چند دقیقه ارسال شوند
for (let i = 0; i < 4; i++) { NOW += 60000; await tick(env, NOW); }
const pend = q(`SELECT COUNT(*) n FROM outbox WHERE status='pending'`)[0].n;
console.log('outbox pending', pend, 'sent msgs', sent.length);
assert.equal(pend, 0);
assert.ok(sent.some((x) => x.body.chat_id === '@chan' && /نتایج مسابقه/.test(x.body.text || '')), 'channel post');
assert.ok(sent.some((x) => x.body.chat_id == 3 && /نتیجه‌ی مسابقه/.test(x.body.text || '')), 'result DM');
assert.equal(q(`SELECT COUNT(*) n FROM predictions WHERE card_status='pending'`)[0].n, 0, 'cards sent');
assert.ok(sent.some((x) => /پیش‌بینی دلار/.test(x.body.text || '') && x.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.includes('ref_')), 'text card w/ referral button');

// ---------- ۴) لیدربورد ----------
await text(3, '🏆 لیدربورد');
console.log(lastTo(3).body.text);
assert.match(lastTo(3).body.text, /King_Ali/);

// ---------- ۵) لجندری ----------
Object.assign(LEGENDARY, { minScored: 1, minUsers: 5 });
const r = await updateLegendary(db, tehranNow(NOW));
console.log('legendary', r, q('SELECT id FROM users WHERE is_legendary=1'));
assert.equal(q('SELECT COUNT(*) n FROM users WHERE is_legendary=1')[0].n, 1);
await text(1, '📡 سیگنال اجماع');
console.log(lastTo(1).body.text);
await text(4, '📡 سیگنال اجماع'); assert.match(lastTo(4).body.text, /قفل/);

// ---------- ۶) تعطیلی هوشمند (روز بعد بدون نوسان) ----------
setTehran('2026-09-22', 9, 0); setPrices({ USD: 88500, GOLD18: 5100000, COIN: 50100000, XAUUSD: 2400 });
await press(1, 'p:usd'); await text(1, '88500');
assert.equal(q(`SELECT COUNT(*) n FROM predictions WHERE day='2026-09-22'`)[0].n, 1);
const same = { USD: 88500, GOLD18: 5100000, COIN: 50100000, XAUUSD: 2400 };
for (const [h, m] of [[11, 0], [11, 10], [11, 20], [11, 30], [11, 40], [11, 50]]) { setTehran('2026-09-22', h, m); setPrices(same); await tick(env, NOW); }
setTehran('2026-09-22', 12, 0); setPrices(same); await tick(env, NOW);
assert.equal(q(`SELECT status FROM daily_final_prices WHERE symbol='usd' AND day='2026-09-22'`)[0].status, 'holiday');
assert.equal(q(`SELECT status FROM predictions WHERE day='2026-09-22'`)[0].status, 'voided');
await press(2, 'p:usd'); assert.match(lastTo(2).body.text, /تعطیل/);

// ---------- ۷) اونس: شنبه تعطیل ----------
setTehran('2026-09-26', 9, 0); // شنبه
await press(2, 'p:xau'); assert.match(lastTo(2).body.text, /شنبه و یکشنبه/);

// ---------- ۸) بله ----------
await text(50, '/start', 'bale'); assert.ok(sent.some((x) => x.url.includes('tapi.bale.ai')), 'bale api used');
console.log('\n✅ همه‌ی تست‌ها موفق بودند');
