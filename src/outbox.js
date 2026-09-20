// صف ارسال پیام‌ها + تولید کارت‌ها.  دلیل وجود صف: پلن رایگان فقط ۵۰ درخواست خروجی در هر اجرا اجازه می‌دهد،
// پس پیام‌های انبوه (نتایج روزانه و ...) در دقیقه‌های متوالی و تکه‌تکه ارسال می‌شوند.
import { api } from './platform.js';
import { SYMBOLS, SUBREQUEST_BUDGET } from './config.js';
import { displayName, fmt, jalaliDate, clock, botLink } from './util.js';
import { renderCards, textCard } from './card.js';

export const outboxStmt = (platform, chat, text, key, buttons) => [
  'INSERT OR IGNORE INTO outbox(dedupe_key,platform,chat_id,text,buttons,created_at) VALUES(?,?,?,?,?,?)',
  [key, platform, String(chat), text, buttons ? JSON.stringify(buttons) : null, Date.now()],
];

export async function drainOutbox(env, db, meter, limit) {
  const room = SUBREQUEST_BUDGET - meter.n - 2;
  const n = Math.min(limit, room);
  if (n <= 0) return 0;
  const rows = await db.all(`SELECT id,platform,chat_id,text,buttons,attempts FROM outbox WHERE status='pending' ORDER BY id LIMIT ?`, [n]);
  const apis = {}, upd = [];
  let sent = 0;
  for (const r of rows) {
    if (meter.n >= SUBREQUEST_BUDGET - 1) break;
    const P = (apis[r.platform] ||= api(env, r.platform, meter));
    const res = await P.sendMessage(r.chat_id, r.text, r.buttons ? JSON.parse(r.buttons) : undefined);
    if (res.ok) { upd.push([`UPDATE outbox SET status='sent',attempts=attempts+1 WHERE id=?`, [r.id]]); sent++; continue; }
    if (res.error_code === 429) break;                                   // محدودیت نرخ: بماند برای دقیقه‌ی بعد
    const blocked = res.error_code === 403 || /blocked|chat not found|deactivated/i.test(res.description || '');
    if (blocked) {
      upd.push([`UPDATE outbox SET status='failed',attempts=attempts+1 WHERE id=?`, [r.id]]);
      upd.push([`UPDATE users SET is_blocked=1 WHERE platform=? AND chat_id=?`, [r.platform, r.chat_id]]);
    } else {
      upd.push([`UPDATE outbox SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,attempts=attempts+1 WHERE id=?`, [r.id]]);
    }
  }
  if (upd.length) await db.batch(upd);
  return sent;
}

// ---------- کارت‌های تصویری ----------
export async function processCards(env, db, meter, limit) {
  if (SUBREQUEST_BUDGET - meter.n < 8) return 0;
  const rows = await db.all(
    `SELECT p.id AS pid,p.symbol,p.guess,p.price_at_guess,p.created_at,
            u.id AS id,u.platform,u.chat_id,u.platform_user_id,u.username,u.first_name,u.display_mode,u.alias,u.is_legendary
     FROM predictions p JOIN users u ON u.id=p.user_id
     WHERE p.card_status='pending' AND p.status!='voided' ORDER BY p.id LIMIT ?`, [limit]);
  if (!rows.length) return 0;

  const apis = {};
  const items = [];
  for (const r of rows) {
    if (SUBREQUEST_BUDGET - meter.n < 6) break;
    const sym = SYMBOLS[r.symbol];
    const P = (apis[r.platform] ||= api(env, r.platform, meter));
    const name = displayName(r).replace('👑 ', '');
    items.push({
      row: r, P, key: r.pid,
      d: {
        key: r.pid, name, plainName: name, legendary: !!r.is_legendary, emoji: sym.emoji, symbolTitle: sym.title, unit: sym.unit,
        guess: fmt(r.guess, sym.decimals), priceAtGuess: fmt(r.price_at_guess, sym.decimals),
        dateStr: jalaliDate(r.created_at), timeStr: clock(r.created_at),
        avatar: r.display_mode === 'anon' ? null : await P.avatarDataUri(r.platform_user_id),   // حریم خصوصی: ناشناس ⇒ بدون آواتار
      },
    });
  }
  const pngs = await renderCards(env, items.map((i) => i.d));
  const upd = [];
  for (const it of items) {
    const r = it.row;
    const buttons = { inline_keyboard: [[{ text: '🎯 تو هم حدس بزن و کل‌کل کن!', url: botLink(env, r.platform, r.id) }]] };
    const png = pngs.get(it.key);
    let ok = false, kind = 'sent';
    if (png) {
      const cap = `${it.d.emoji} پیش‌بینی من برای ${it.d.symbolTitle}: ${it.d.guess} ${it.d.unit}\nتو هم حدس بزن و کل‌کل کن 👇`;
      ok = (await it.P.sendPhoto(r.chat_id, png, cap, buttons)).ok;
    }
    if (!ok) { ok = (await it.P.sendMessage(r.chat_id, textCard(it.d), buttons)).ok; kind = 'text'; }
    if (ok) upd.push([`UPDATE predictions SET card_status=? WHERE id=?`, [kind, r.pid]]);
  }
  if (upd.length) await db.batch(upd);
  return upd.length;
}
