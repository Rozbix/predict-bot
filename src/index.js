import { makeDb, initSchema } from './db.js';
import { api } from './platform.js';
import { handleUpdate } from './bot.js';
import { marketJobs } from './market.js';
import { drainOutbox, processCards } from './outbox.js';
import { OUTBOX_PER_TICK, CARDS_PER_TICK, SYMBOLS } from './config.js';

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export async function tick(env, now = Date.now()) {
  const meter = { n: 0 };
  const db = makeDb(env, meter);
  const steps = [
    ['market', () => marketJobs(env, db, now, meter)],
    ['outbox', () => drainOutbox(env, db, meter, OUTBOX_PER_TICK)],
    ['cards', () => processCards(env, db, meter, CARDS_PER_TICK)],
  ];
  const report = {};
  for (const [name, fn] of steps) {
    try { report[name] = (await fn()) ?? 'ok'; } catch (e) { report[name] = 'ERROR: ' + e.message; console.error(name, e.stack || e.message); }
  }
  report.subrequests = meter.n;
  return report;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // ---- وب‌هوک ربات‌ها ----
    if (req.method === 'POST' && parts[0] === 'webhook' && ['telegram', 'bale'].includes(parts[1])) {
      if (!env.WEBHOOK_SECRET || parts[2] !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const hdr = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (parts[1] === 'telegram' && hdr && hdr !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      const upd = await req.json().catch(() => null);
      if (upd) ctx.waitUntil(handleUpdate(env, parts[1], upd).catch((e) => console.error('update failed', e.stack || e.message)));
      return new Response('ok');
    }

    // ---- مسیرهای مدیریتی ----
    if (parts[0] === 'admin') {
      const key = url.searchParams.get('key') || req.headers.get('X-Admin-Key');
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      try {
        const db = makeDb(env);
        if (parts[1] === 'init') return json({ ok: true, statements: await initSchema(db) });
        if (parts[1] === 'tables') {
          const t = await db.all(`SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
          return json(t.map((x) => ({ name: x.name, sql: x.sql })));
        }
        if (parts[1] === 'tick') return json(await tick(env));
        if (parts[1] === 'prices') {                       // تست کوئری‌های منبع قیمت
          const { getPrice } = await import('./market.js');
          const out = {};
          for (const k of Object.keys(SYMBOLS)) out[k] = await getPrice(db, k).catch((e) => 'ERROR: ' + e.message);
          return json(out);
        }
        if (parts[1] === 'webhookinfo') {                   // وضعیت وب‌هوک و اعتبار توکن‌ها
          const res = {};
          for (const p of ['telegram', 'bale']) {
            const token = p === 'telegram' ? env.TELEGRAM_BOT_TOKEN : env.BALE_BOT_TOKEN;
            if (!token) { res[p] = 'توکن تنظیم نشده'; continue; }
            const P = api(env, p);
            const me = await P.call('getMe'), wi = await P.call('getWebhookInfo');
            res[p] = { token_ok: !!me.ok, bot: me.result?.username, getMe_error: me.ok ? undefined : me.description,
              webhook_url_set: !!wi.result?.url, pending_updates: wi.result?.pending_update_count,
              last_error_message: wi.result?.last_error_message, last_error_date: wi.result?.last_error_date, raw: wi.ok ? undefined : wi };
          }
          return json(res);
        }
        if (parts[1] === 'setup') {
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(env.WEBHOOK_SECRET || '')) {
            return json({ ok: false, error: 'WEBHOOK_SECRET نامعتبر یا خالی است. فقط حروف انگلیسی، عدد، _ و - مجاز است (بدون فاصله/نمادهای دیگر). آن را دوباره با wrangler secret put WEBHOOK_SECRET ست کنید.' }, 400);
          }
          const res = {};
          for (const p of ['telegram', 'bale']) {
            const token = p === 'telegram' ? env.TELEGRAM_BOT_TOKEN : env.BALE_BOT_TOKEN;
            if (!token) { res[p] = 'توکن تنظیم نشده (رد شد)'; continue; }
            const P = api(env, p);
            const me = await P.call('getMe');
            if (!me.ok) { res[p] = { ok: false, error: 'توکن نامعتبر است (getMe ناموفق): ' + me.description }; continue; }
            const hook = `${url.origin}/webhook/${p}/${env.WEBHOOK_SECRET}`;
            res[p] = {
              setWebhook: await P.call('setWebhook', p === 'telegram'
                ? { url: hook, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true }
                : { url: hook }),
              setMyCommands: await P.call('setMyCommands', { commands: [
                { command: 'start', description: 'شروع / منوی اصلی' },
                { command: 'predict', description: 'ثبت پیش‌بینی' },
                { command: 'leaderboard', description: 'لیدربورد' },
                { command: 'profile', description: 'پروفایل من' },
                { command: 'help', description: 'راهنما' },
              ] }),
            };
          }
          return json(res);
        }
      } catch (e) { return json({ ok: false, error: e.message }, 500); }
      return json({ routes: ['init', 'setup', 'webhookinfo', 'tables', 'prices', 'tick'] });
    }
    return new Response('nerkh predict bot ✅', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.scheduledTime).then((r) => { if (Object.values(r).some((v) => String(v).startsWith('ERROR'))) console.error(JSON.stringify(r)); }));
  },
};
