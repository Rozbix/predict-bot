// منطق بازار: پنجره‌های زمانی، تشخیص تعطیلی، ثبت قیمت مرجع، امتیازدهی، لجندری
import {
  SYMBOLS, MARKETS, SCORING, LEGENDARY, STALE_MINUTES, FRESH_MINUTES, FINAL_RETRY_MINUTES,
} from './config.js';
import { tehranNow, hm, addDays, fmt, fmtPct, jalaliDateFromDay, displayName, medal, botLink, parseTs } from './util.js';
import { outboxStmt } from './outbox.js';

// ---------- قیمت ----------
export async function getPrice(db, key) {
  const s = SYMBOLS[key].source;
  const row = await db.get(s.sql, s.args);
  if (!row) return null;
  const price = Number(row.price);
  if (!(price > 0)) return null;
  return { price, ts: parseTs(row.ts) };
}

export function windowState(key, now = Date.now()) {
  const cfg = MARKETS[SYMBOLS[key].market];
  const t = tehranNow(now);
  if (cfg.disabledDows.includes(t.dow)) return { open: false, reason: 'weekend', t, cfg };
  const close = hm(cfg.closeAt);
  if (t.minutes >= close) return { open: false, reason: 'closed', t, cfg };
  return { open: true, minutesLeft: close - t.minutes, t, cfg };
}

export function channelTargets(env) {
  const out = [];
  if (env.CHANNEL_TELEGRAM && env.TELEGRAM_BOT_USERNAME) out.push({ platform: 'telegram', chat: env.CHANNEL_TELEGRAM });
  if (env.CHANNEL_BALE && env.BALE_BOT_USERNAME) out.push({ platform: 'bale', chat: env.CHANNEL_BALE });
  return out;
}
const joinButton = (env, platform) => ({ inline_keyboard: [[{ text: '🎯 شرکت در مسابقه', url: botLink(env, platform) }]] });

// ---------- حلقه‌ی اصلی (هر دقیقه) ----------
export async function marketJobs(env, db, now, meter) {
  const t = tehranNow(now);
  const [st, jr] = await db.batch([
    ['SELECT symbol,status FROM daily_final_prices WHERE day=?', [t.day]],
    ['SELECT job FROM job_runs WHERE day=?', [t.day]],
  ]);
  const status = Object.fromEntries(st.rows.map((r) => [r.symbol, r.status]));
  const jobsDone = new Set(jr.rows.map((r) => r.job));

  if (t.minutes >= 5 && !jobsDone.has('nightly')) {
    try { await nightly(env, db, t, now); } catch (e) { console.error('nightly failed', e.message); }
  }

  for (const [key, sym] of Object.entries(SYMBOLS)) {
    const cfg = MARKETS[sym.market];
    if (cfg.disabledDows.includes(t.dow)) continue;
    const s = status[key];
    if (['final', 'holiday', 'void'].includes(s)) continue;
    try {
      const checkFrom = hm(cfg.holidayCheckFrom), closeAt = hm(cfg.closeAt), finalAt = hm(cfg.finalAt);
      if (t.minutes >= checkFrom && t.minutes < closeAt && t.minutes % 10 === 0) await takeSnapshot(db, key, t);
      if (t.minutes >= closeAt && t.minutes < finalAt && !s) await decideHoliday(env, db, key, t, now);
      else if (t.minutes >= finalAt) await finalize(env, db, key, t, now, cfg, finalAt);
    } catch (e) { console.error('market job failed', key, e.message); }
  }
}

async function takeSnapshot(db, key, t) {
  const p = await getPrice(db, key);
  if (!p) return;
  await db.run('INSERT OR IGNORE INTO price_snapshots(symbol,day,slot,price,ts) VALUES(?,?,?,?,?)', [key, t.day, t.minutes, p.price, p.ts]);
}

// ---------- تشخیص هوشمند تعطیلی ----------
async function decideHoliday(env, db, key, t, now) {
  const sym = SYMBOLS[key], cfg = MARKETS[sym.market];
  const cur = await getPrice(db, key);
  if (!cur) return;
  if (cur.ts && now - cur.ts > STALE_MINUTES * 60000) return;   // منبع قیمت کهنه است ⇒ تصمیم‌گیری نکن (احتمال خرابی منبع)
  const [snaps, prev] = await db.batch([
    ['SELECT price FROM price_snapshots WHERE symbol=? AND day=? ORDER BY slot', [key, t.day]],
    [`SELECT final_price FROM daily_final_prices WHERE symbol=? AND status='final' AND day<? ORDER BY day DESC LIMIT 1`, [key, t.day]],
  ]);
  const prices = snaps.rows.map((r) => r.price).concat(cur.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const rangePct = ((max - min) / min) * 100;
  const prevFinal = prev.rows[0]?.final_price;
  const movedPct = prevFinal ? (Math.abs(cur.price - prevFinal) / prevFinal) * 100 : Infinity;
  const closed = rangePct <= cfg.holidayThresholdPct && movedPct <= cfg.holidayThresholdPct;
  if (closed) {
    const userText = `🚫 بازار ${sym.title} امروز تعطیل تشخیص داده شد (بدون نوسان قیمت).\nپیش‌بینی امروز شما باطل شد و امتیازی کسر نمی‌شود. فردا دوباره حدس بزن! 🎯`;
    const chan = channelTargets(env).map((c) => outboxStmt(c.platform, c.chat,
      `📅 امروز ${cfg.label} تعطیل تشخیص داده شد؛ مسابقه‌ی پیش‌بینی امروز برگزار نمی‌شود.\nفردا حدس بزنید 👇`,
      `holiday:${sym.market}:${t.day}:${c.platform}`, joinButton(env, c.platform)));
    await closeDay(db, key, t.day, 'holiday', 'no_movement', userText, chan);
  } else {
    await db.run(`INSERT OR IGNORE INTO daily_final_prices(symbol,day,status,created_at) VALUES(?,?,'open',?)`, [key, t.day, Date.now()]);
  }
}

// ابطال پیش‌بینی‌های pending و ثبت وضعیت روز
async function closeDay(db, key, day, status, note, userText, extraStmts = []) {
  const now = Date.now();
  await db.batch([
    [`INSERT OR IGNORE INTO outbox(dedupe_key,platform,chat_id,text,created_at)
      SELECT 'void:'||p.id, u.platform, u.chat_id, ?, ? FROM predictions p JOIN users u ON u.id=p.user_id
      WHERE p.symbol=? AND p.day=? AND p.status='pending' AND u.is_blocked=0`, [userText, now, key, day]],
    [`UPDATE predictions SET status='voided' WHERE symbol=? AND day=? AND status='pending'`, [key, day]],
    ...extraStmts,
    [`INSERT OR REPLACE INTO daily_final_prices(symbol,day,status,note,created_at) VALUES(?,?,?,?,?)`, [key, day, status, note, now]],
  ]);
}

// ---------- ثبت قیمت مرجع ----------
async function finalize(env, db, key, t, now, cfg, finalAt) {
  const deadline = Math.min(finalAt + FINAL_RETRY_MINUTES, 23 * 60 + 59);
  const cur = await getPrice(db, key);
  const finalAtMs = now - (t.minutes - finalAt) * 60000;
  const fresh = cur && (!cur.ts || now - cur.ts <= FRESH_MINUTES * 60000);
  // ترجیحاً قیمتی که حداکثر ۱۰ دقیقه قبل از ساعت مرجع بروز شده؛ اگر تا ۱۵ دقیقه بعد نیامد، آخرین قیمت تازه را می‌پذیریم
  const near = cur && (!cur.ts || cur.ts >= finalAtMs - 10 * 60000 || t.minutes >= finalAt + 15);
  if (fresh && near) return scoreDay(env, db, key, t.day, cur.price, cur.ts || now);
  if (t.minutes >= deadline) {
    const sym = SYMBOLS[key];
    await closeDay(db, key, t.day, 'void', 'no_price',
      `⚠️ به‌دلیل مشکل در دریافت قیمت مرجع ${sym.title}، پیش‌بینی امروز باطل شد. امتیازی کسر نمی‌شود؛ از شما پوزش می‌خواهیم 🙏`);
    console.error('VOID no_price', key, t.day);
  }
}

// ---------- امتیازدهی (idempotent: با اجرای مجدد نتیجه یکسان است) ----------
export async function scoreDay(env, db, key, day, finalPrice, finalTs) {
  const sym = SYMBOLS[key];
  const rows = await db.all(
    `SELECT p.id AS pid,p.guess,p.created_at,u.id AS id,u.platform,u.chat_id,u.username,u.first_name,u.display_mode,u.alias,u.is_legendary,u.is_blocked
     FROM predictions p JOIN users u ON u.id=p.user_id WHERE p.symbol=? AND p.day=? AND p.status IN ('pending','scored')`, [key, day]);
  const items = rows.map((r) => ({ ...r, err: (Math.abs(r.guess - finalPrice) / finalPrice) * 100 }));
  items.sort((a, b) => a.err - b.err || a.created_at - b.created_at);
  const n = items.length, now = Date.now();
  const stmts = [];
  const date = jalaliDateFromDay(day);

  items.forEach((it, i) => {
    it.rank = i + 1;
    it.accuracy = Math.max(0, Math.round(100 * (1 - it.err / sym.tolerancePct)));
    const bonus = n >= SCORING.minParticipantsForRankBonus ? SCORING.rankBonus[i] || 0 : 0;
    it.xp = it.accuracy + bonus + SCORING.participationXp;
    stmts.push([
      `UPDATE predictions SET status='scored',final_price=?,error_pct=?,rank_pos=?,accuracy=?,xp=?,scored_at=? WHERE id=?`,
      [finalPrice, it.err, it.rank, it.accuracy, it.xp, now, it.pid]]);
  });

  if (n) {
    // لیدربورد یک «کش مشتق‌شده» است؛ هر بار از روی predictions بازسازی می‌شود ⇒ عدم دوباره‌شماری XP
    stmts.push([
      `INSERT INTO leaderboards(user_id,scope,xp,scored_count,accuracy_sum)
       SELECT user_id,symbol,SUM(xp),COUNT(*),SUM(accuracy) FROM predictions
       WHERE status='scored' AND symbol=? AND user_id IN (SELECT user_id FROM predictions WHERE symbol=? AND day=?)
       GROUP BY user_id
       ON CONFLICT(user_id,scope) DO UPDATE SET xp=excluded.xp,scored_count=excluded.scored_count,accuracy_sum=excluded.accuracy_sum`,
      [key, key, day]]);
    stmts.push([
      `INSERT INTO leaderboards(user_id,scope,xp,scored_count,accuracy_sum)
       SELECT user_id,'overall',SUM(xp),COUNT(*),SUM(accuracy) FROM predictions
       WHERE status='scored' AND user_id IN (SELECT user_id FROM predictions WHERE symbol=? AND day=?)
       GROUP BY user_id
       ON CONFLICT(user_id,scope) DO UPDATE SET xp=excluded.xp,scored_count=excluded.scored_count,accuracy_sum=excluded.accuracy_sum`,
      [key, day]]);

    // اعلان شخصی به هر شرکت‌کننده
    for (const it of items) {
      if (it.is_blocked) continue;
      const text =
        `📊 نتیجه‌ی مسابقه‌ی ${sym.emoji} ${sym.title} — ${date}\n\n` +
        `💰 قیمت مرجع نهایی: ${fmt(finalPrice, sym.decimals)} ${sym.unit}\n` +
        `🎯 حدس شما: ${fmt(it.guess, sym.decimals)}\n` +
        `📏 خطا: ${fmtPct(it.err)}\n` +
        `🏅 رتبه‌ی شما: ${fmt(it.rank)} از ${fmt(n)}\n` +
        `⭐ امتیاز این مسابقه: +${fmt(it.xp)} XP`;
      stmts.push(outboxStmt(it.platform, it.chat_id, text, `res:${it.pid}`,
        { inline_keyboard: [[{ text: '🏆 مشاهده‌ی لیدربورد', callback_data: 'lb:' + key }]] }));
    }
    // پست نتایج در کانال
    const top = items.slice(0, 3).map((it, i) => `${medal(i)} ${displayName(it)} — حدس ${fmt(it.guess, sym.decimals)} (خطا ${fmtPct(it.err)})`);
    const chanText =
      `🏆 نتایج مسابقه‌ی پیش‌بینی ${sym.emoji} ${sym.title} — ${date}\n\n` +
      `💰 قیمت مرجع: ${fmt(finalPrice, sym.decimals)} ${sym.unit}\n\n${top.join('\n')}\n\n` +
      `👥 ${fmt(n)} شرکت‌کننده\nفردا تو هم حدس بزن 👇`;
    for (const c of channelTargets(env)) stmts.push(outboxStmt(c.platform, c.chat, chanText, `chan:${key}:${day}:${c.platform}`, joinButton(env, c.platform)));
  }
  stmts.push([`INSERT OR REPLACE INTO daily_final_prices(symbol,day,status,final_price,final_ts,created_at) VALUES(?,?,'final',?,?,?)`,
    [key, day, finalPrice, finalTs, now]]);
  await db.bigBatch(stmts);
  return { n, items };
}

// ---------- کار شبانه: تکمیل روزهای جامانده + لجندری + پاکسازی ----------
async function nightly(env, db, t, now) {
  // ۱) روزهای گذشته‌ای که بدون وضعیت مانده‌اند ⇒ ابطال
  const orphans = await db.all(
    `SELECT DISTINCT p.symbol,p.day FROM predictions p WHERE p.status='pending' AND p.day<?
     AND NOT EXISTS (SELECT 1 FROM daily_final_prices d WHERE d.symbol=p.symbol AND d.day=p.day AND d.status IN ('final','holiday','void'))`, [t.day]);
  for (const o of orphans.slice(0, 6)) {
    await closeDay(db, o.symbol, o.day, 'void', 'missed',
      `⚠️ به‌دلیل اختلال در ثبت قیمت مرجع ${SYMBOLS[o.symbol]?.title || ''}، پیش‌بینی شما باطل شد. امتیازی کسر نمی‌شود 🙏`);
  }
  // ۲) لجندری‌ها
  await updateLegendary(db, t);
  // ۳) پاکسازی
  await db.batch([
    [`DELETE FROM outbox WHERE status!='pending' AND created_at<?`, [now - 7 * 86400000]],
    [`DELETE FROM price_snapshots WHERE day<?`, [addDays(t.day, -5)]],
    [`INSERT OR REPLACE INTO job_runs(job,day,ran_at) VALUES('nightly',?,?)`, [t.day, now]],
  ]);
}

export async function updateLegendary(db, t) {
  const since = addDays(t.day, -LEGENDARY.windowDays);
  const ranked = await db.all(
    `SELECT p.user_id AS id,u.platform,u.chat_id,u.is_legendary,COUNT(*) AS n,AVG(p.accuracy) AS a
     FROM predictions p JOIN users u ON u.id=p.user_id
     WHERE p.status='scored' AND p.day>=? GROUP BY p.user_id HAVING COUNT(*)>=? ORDER BY a DESC,n DESC,p.user_id`,
    [since, LEGENDARY.minScored]);
  const topN = ranked.length >= LEGENDARY.minUsers ? Math.ceil((ranked.length * LEGENDARY.topPct) / 100) : 0;
  const top = ranked.slice(0, topN);
  const ids = top.map((u) => Number(u.id));
  const stmts = [];
  stmts.push(ids.length
    ? [`UPDATE users SET is_legendary=0 WHERE is_legendary=1 AND id NOT IN (${ids.join(',')})`, []]
    : [`UPDATE users SET is_legendary=0 WHERE is_legendary=1`, []]);
  for (const u of top.filter((x) => !x.is_legendary)) {
    stmts.push([`UPDATE users SET is_legendary=1,legendary_since=? WHERE id=?`, [t.day, u.id]]);
    stmts.push(outboxStmt(u.platform, u.chat_id,
      `👑 تبریک! دقت پیش‌بینی‌های ${fmt(LEGENDARY.windowDays)} روز اخیر تو را وارد جمع ${fmt(LEGENDARY.topPct)}٪ برترین تحلیل‌گران کرد.\n\n` +
      `از حالا نشان 👑 کنار نامت در لیدربورد و کارت‌هایت می‌درخشد و «📡 سیگنال اجماع» (میانگین حدس برترین‌ها) برایت باز شد.`,
      `legend:${u.id}:${t.day}`));
  }
  await db.batch(stmts);
  return { ranked: ranked.length, promoted: top.filter((x) => !x.is_legendary).length };
}
