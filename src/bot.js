// منطق ربات (مشترک بین تلگرام و بله)
import { makeDb } from './db.js';
import { api, kb } from './platform.js';
import {
  SYMBOLS, MARKETS, SCORING, LEGENDARY, REFERRAL_UNLOCK, CONSENSUS_MIN_LEGENDS,
} from './config.js';
import {
  tehranNow, parseNumber, fmt, fmtPct, jalaliDate, jalaliDateFromDay, displayName, hasSignalAccess, medal, cleanAlias, botLink,
} from './util.js';
import { getPrice, windowState } from './market.js';
import { outboxStmt } from './outbox.js';

const BTN = {
  predict: '🎯 ثبت پیش‌بینی', board: '🏆 لیدربورد', profile: '👤 پروفایل من',
  invite: '🔗 دعوت دوستان', signal: '🔮 پیش‌بینی لجندری‌ها چیه؟', help: 'ℹ️ راهنما', admin: '🛠 پنل ادمین',
};
const ROWS = [[BTN.predict, BTN.board], [BTN.profile, BTN.invite], [BTN.signal, BTN.help]];
const menu = (c) => kb.reply(isAdmin(c) ? [...ROWS, [BTN.admin]] : ROWS);
const SCOPES = [['overall', '🌐 کلی'], ...Object.entries(SYMBOLS).map(([k, s]) => [k, `${s.emoji} ${s.title}`])];

export async function handleUpdate(env, platform, upd) {
  try { return await handleUpdateInner(env, platform, upd); }
  catch (e) {
    console.error('handleUpdate error:', e.stack || e.message);
    try {                                          // خطا هیچ‌وقت ساکت نماند
      const f = (upd.callback_query || upd.message)?.from, chat = (upd.callback_query?.message || upd.message)?.chat;
      if (f && chat && chat.type === 'private') {
        const admin = (env.ADMIN_IDS || '').split(',').map((x) => x.trim()).includes(`${platform}:${f.id}`);
        await api(env, platform).sendMessage(chat.id, '⚠️ خطای موقتی رخ داد؛ چند لحظه‌ی دیگر دوباره تلاش کن.' + (admin ? `\n\n🛠 (فقط ادمین)\n${String(e.message).slice(0, 400)}` : ''));
      }
    } catch {}
  }
}

async function handleUpdateInner(env, platform, upd) {
  const meter = { n: 0 };
  const db = makeDb(env, meter);
  const P = api(env, platform, meter);
  const cb = upd.callback_query, msg = upd.message;
  const from = (cb || msg)?.from;
  const chat = cb ? cb.message?.chat : msg?.chat;
  if (!from || !chat || from.is_bot || ['group', 'supergroup', 'channel'].includes(chat.type)) {
    if (cb) await P.answerCallback(cb.id);
    return;
  }
  const c = { env, db, P, platform, chatId: String(chat.id), from };
  let ref = null;
  const m = msg?.text?.match(/^\/start(?:@\w+)?\s+ref_(\d+)/);
  if (m) ref = Number(m[1]);
  c.user = await upsertUser(c, ref);
  if (cb) return onCallback(c, cb);
  if (msg?.text) return onText(c, msg.text.trim());
}

async function upsertUser(c, ref) {
  const { db, platform, from } = c, now = Date.now(), pid = String(from.id);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
  const res = await db.batch([
    [`INSERT OR IGNORE INTO users(platform,platform_user_id,chat_id,username,first_name,referrer_id,created_at,last_seen)
      VALUES(?,?,?,?,?,(SELECT id FROM users WHERE id=?),?,?)`, [platform, pid, c.chatId, from.username || null, name, ref, now, now]],
    [`UPDATE users SET chat_id=?,username=?,first_name=?,last_seen=?,is_blocked=0 WHERE platform=? AND platform_user_id=?`,
      [c.chatId, from.username || null, name, now, platform, pid]],
    ['SELECT * FROM users WHERE platform=? AND platform_user_id=?', [platform, pid]],
  ]);
  return res[2].rows[0];
}

const send = (c, text, buttons) => c.P.sendMessage(c.chatId, text, buttons);
const setState = (c, state, data) =>
  c.db.run('UPDATE users SET state=?,state_data=? WHERE id=?', [state ?? null, data === undefined ? null : typeof data === 'string' ? data : JSON.stringify(data), c.user.id]);
const isAdmin = (c) => (c.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).includes(`${c.platform}:${c.from.id}`);
const canSeeSignal = (c) => isAdmin(c) || hasSignalAccess(c.user);   // ادمین‌ها همیشه دسترسی دارند (برای مشاهده/تست)
const timeLeft = (min) => (min >= 60 ? `${fmt(Math.floor(min / 60))} ساعت و ${fmt(min % 60)} دقیقه` : `${fmt(min)} دقیقه`);
const hhmm = (s) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

// ---------------- پیام‌های متنی ----------------
async function onText(c, text) {
  if (text.startsWith('/')) return onCommand(c, text);
  const menuTap = Object.values(BTN).includes(text);
  if (menuTap && c.user.state) { await setState(c, null); c.user.state = null; }
  switch (text) {
    case BTN.predict: return showPredictMenu(c);
    case BTN.board: return showLeaderboard(c, 'overall');
    case BTN.profile: return showProfile(c);
    case BTN.invite: return showInvite(c);
    case BTN.signal: return showSignal(c);
    case BTN.help: return showHelp(c);
    case BTN.admin: return showAdmin(c);
  }
  if (c.user.state === 'guess') return onGuess(c, text);
  if (c.user.state === 'guess_confirm') return onGuessConfirmText(c, text);
  if (c.user.state === 'alias_text') return onAliasText(c, text);
  if (c.user.state === 'admin_premium' && isAdmin(c)) return adminPremiumInput(c, text);
  if (c.user.state === 'admin_bc' && isAdmin(c)) return adminBroadcastInput(c, text);
  return send(c, 'از منوی پایین یکی را انتخاب کن 👇', menu(c));
}

async function onCommand(c, text) {
  const [cmd, ...args] = text.split(/\s+/);
  const name = cmd.replace(/@\w+$/, '').toLowerCase();
  if (name === '/start') {
    await setState(c, null);
    return send(c,
      `سلام ${c.from.first_name || ''} 👋\nبه مسابقه‌ی پیش‌بینی نرخ روز خوش اومدی!\n\n` +
      `هر روز قیمت «دلار، طلا، سکه و اونس» رو حدس بزن، امتیاز (XP) بگیر، با بقیه رقابت کن و اگه جزو ۱۰٪ برترها بشی نشان 👑 لجندری می‌گیری و «سیگنال اجماع» رو می‌بینی.\n\n` +
      `برای شروع 🎯 ثبت پیش‌بینی رو بزن.`, menu(c));
  }
  if (name === '/help') return showHelp(c);
  if (name === '/menu' || name === '/cancel') { await setState(c, null); return send(c, 'منوی اصلی 👇', menu(c)); }
  if (name === '/profile') return showProfile(c);
  if (name === '/admin' && isAdmin(c)) return showAdmin(c);
  if (name === '/leaderboard') return showLeaderboard(c, 'overall');
  if (name === '/predict') return showPredictMenu(c);
  if (!isAdmin(c)) return send(c, 'دستور نامعتبر. از منو استفاده کن 👇', menu(c));

  if (name === '/premium') return grantPremium(c, Number(args[0]), Number(args[1]));      // /premium <شناسه> <روز>
  if (name === '/stats') return adminStats(c);
  if (name === '/broadcast') return queueBroadcast(c, text.slice(cmd.length).trim());         // /broadcast متن
  return send(c, 'دستور نامعتبر.');
}

// ---------------- عضویت اجباری کانال ----------------
async function gateOk(c) {
  if (c.env.REQUIRE_CHANNEL_JOIN !== 'true') return true;
  const channel = c.platform === 'bale' ? c.env.CHANNEL_BALE : c.env.CHANNEL_TELEGRAM;
  if (!channel) return true;
  const member = await c.P.isChannelMember(channel, c.from.id);
  if (member !== false) return true;                 // null = نامشخص ⇒ اجازه بده (fail-open)
  const handle = channel.replace(/^@/, '');
  const url = c.platform === 'bale' ? `https://ble.ir/${handle}` : `https://t.me/${handle}`;
  await send(c, `برای شرکت در مسابقه اول عضو کانال ما شو 👇\nبعد از عضویت، «✅ عضو شدم» رو بزن.`,
    kb.inline([[{ text: '📢 عضویت در کانال', url }], [{ text: '✅ عضو شدم', callback_data: 'pm' }]]));
  return false;
}

// ---------------- ثبت پیش‌بینی ----------------
async function showPredictMenu(c, cb) {
  const t = tehranNow();
  const rows = await c.db.all('SELECT symbol FROM predictions WHERE user_id=? AND day=?', [c.user.id, t.day]);
  const done = new Set(rows.map((r) => r.symbol));
  const lines = Object.entries(SYMBOLS).map(([k, s]) => {
    const w = windowState(k);
    const st = done.has(k) ? '✅ ثبت شد' : w.open ? `⏳ تا ${hhmm(w.cfg.closeAt)}` : w.reason === 'weekend' ? '🚫 تعطیل' : '🔒 بسته';
    return `${s.emoji} ${s.title}: ${st}`;
  });
  const text = `🎯 کدام نماد را حدس می‌زنی؟\n(حدس قیمت ساعت مرجع همین امروز)\n\n${lines.join('\n')}`;
  const buttons = kb.inline(Object.entries(SYMBOLS).map(([k, s]) => [{ text: `${done.has(k) ? '✅' : s.emoji} ${s.title}`, callback_data: 'p:' + k }]));
  return send(c, text, buttons);
}

async function pickSymbol(c, key) {
  const sym = SYMBOLS[key];
  if (!sym) return;
  if (!(await gateOk(c))) return;
  const w = windowState(key);
  if (!w.open) {
    if (w.reason === 'weekend') return send(c, `🚫 ${w.cfg.label} در شنبه و یکشنبه تعطیل است؛ حدس‌زدن ${sym.title} از دوشنبه ادامه دارد.`);
    const d = await c.db.get('SELECT status FROM daily_final_prices WHERE symbol=? AND day=?', [key, w.t.day]);
    return send(c, d?.status === 'holiday'
      ? `🚫 امروز ${w.cfg.label} تعطیل تشخیص داده شد و مسابقه‌ی ${sym.title} برگزار نمی‌شود. فردا دوباره!`
      : `⏱ مهلت ثبت پیش‌بینی ${sym.title} امروز تمام شده (تا ${hhmm(w.cfg.closeAt)}). فردا زودتر بیا 😉`);
  }
  const [ex, price] = [await c.db.get('SELECT guess FROM predictions WHERE user_id=? AND symbol=? AND day=?', [c.user.id, key, w.t.day]), await getPrice(c.db, key).catch(() => null)];
  if (ex) return send(c, `✅ امروز برای ${sym.title} حدس زده‌ای: ${fmt(ex.guess, sym.decimals)} ${sym.unit}\nنتیجه بعد از ساعت ${hhmm(w.cfg.finalAt)} اعلام می‌شود.`);
  if (!price) return send(c, '⚠️ فعلاً قیمت لحظه‌ای در دسترس نیست. چند دقیقه‌ی دیگر دوباره تلاش کن.');
  await setState(c, 'guess', key);
  return send(c,
    `${sym.emoji} ${sym.title}\n\n💰 قیمت لحظه‌ای: ${fmt(price.price, sym.decimals)} ${sym.unit}\n` +
    `⏳ مهلت ثبت: ${timeLeft(w.minutesLeft)} دیگر (تا ${hhmm(w.cfg.closeAt)})\n\n` +
    `🔢 قیمت ساعت ${hhmm(w.cfg.finalAt)} امروز رو چند حدس می‌زنی؟ فقط عدد بفرست${sym.decimals ? ' (اعشار مجاز است)' : ''}.`,
    kb.inline([[{ text: '❌ انصراف', callback_data: 'cancel' }]]));
}

async function onGuess(c, text) {
  const key = c.user.state_data, sym = SYMBOLS[key];
  if (!sym) { await setState(c, null); return send(c, 'منوی اصلی 👇', menu(c)); }
  const guess = parseNumber(text, sym.decimals > 0);
  if (!guess) return send(c, '⚠️ فقط یک عدد معتبر بفرست (مثلاً ' + fmt(sym.decimals ? 2345.5 : 88450, sym.decimals) + ').');
  const w = windowState(key);
  if (!w.open) { await setState(c, null); return send(c, '⏱ مهلت ثبت پیش‌بینی تمام شد.', menu(c)); }
  const price = await getPrice(c.db, key).catch(() => null);
  if (!price) return send(c, '⚠️ قیمت لحظه‌ای در دسترس نیست؛ کمی بعد دوباره عدد را بفرست.');
  const dev = (Math.abs(guess - price.price) / price.price) * 100;
  if (dev > SCORING.maxDeviationPct) {                // هشدار نرم: رد نمی‌کنیم، فقط تأیید می‌گیریم (شاید غلط تایپی باشد، شاید پیش‌بینی یک جهش واقعی)
    await setState(c, 'guess_confirm', { key, guess, price: price.price });
    return send(c,
      `⚠️ عدد ${fmt(guess, sym.decimals)} با قیمت لحظه‌ای (${fmt(price.price, sym.decimals)} ${sym.unit}) حدود ${fmtPct(dev)} فاصله دارد؛ بیشتر از نوسان معمول امروز.\n` +
      `ممکن است اشتباه تایپی باشد یا واقعاً همچین جهشی را پیش‌بینی می‌کنی.\n\nثبت شود؟`,
      kb.inline([[{ text: '✅ بله، ثبت کن', callback_data: 'gc:yes' }, { text: '✏️ عدد را دوباره بفرستم', callback_data: 'gc:no' }]]));
  }
  return afterGuessOk(c, key, guess, price.price);
}

async function afterGuessOk(c, key, guess, priceAtGuess) {
  if (!c.user.display_mode) {                        // اولین پیش‌بینی ⇒ انتخاب نحوه‌ی نمایش نام
    await setState(c, 'alias_choice', { key, guess, price: priceAtGuess });
    return askAlias(c);
  }
  return savePrediction(c, key, guess, priceAtGuess);
}

function readPendingGuess(c) {
  try { const p = JSON.parse(c.user.state_data || 'null'); return p?.key ? p : null; } catch { return null; }
}

async function onGuessConfirmText(c, text) {
  const pending = readPendingGuess(c);
  if (!pending) { await setState(c, null); return send(c, 'منوی اصلی 👇', menu(c)); }
  await setState(c, 'guess', pending.key);            // بازگشت به حالت عادی ثبت حدس برای همین نماد
  c.user.state_data = pending.key;
  return onGuess(c, text);
}

async function onGuessConfirmYes(c) {
  const pending = readPendingGuess(c);
  if (!pending) return send(c, 'منوی اصلی 👇', menu(c));
  return afterGuessOk(c, pending.key, pending.guess, pending.price);
}

async function onGuessConfirmNo(c) {
  const pending = readPendingGuess(c);
  if (!pending) { await setState(c, null); return send(c, 'منوی اصلی 👇', menu(c)); }
  await setState(c, 'guess', pending.key);
  return send(c, '🔢 باشه، عدد جدید را بفرست:');
}

function askAlias(c) {
  const un = c.user.username ? '@' + c.user.username : (c.user.first_name || 'نام حساب من');
  return send(c, `🎭 نام تو در لیدربورد و کارت‌ها چطور نمایش داده شود؟\n(بعداً از «👤 پروفایل من» قابل تغییر است)`,
    kb.inline([
      [{ text: '🕶 ناشناس', callback_data: 'al:anon' }],
      [{ text: `👤 ${un}`, callback_data: 'al:username' }],
      [{ text: '✏️ نام مستعار دلخواه', callback_data: 'al:custom' }],
    ]));
}

async function onAliasText(c, text) {
  const alias = cleanAlias(text);
  if (!alias) return send(c, '⚠️ نام باید ۳ تا ۲۰ نویسه باشد و شامل لینک یا @ نباشد. دوباره بفرست.');
  try {
    await c.db.run(`UPDATE users SET display_mode='custom',alias=?,alias_lower=? WHERE id=?`, [alias, alias.toLowerCase(), c.user.id]);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return send(c, '⚠️ این نام قبلاً توسط کاربر دیگری انتخاب شده؛ یک نام دیگر بفرست.');
    throw e;
  }
  c.user.display_mode = 'custom'; c.user.alias = alias;
  return afterAlias(c);
}

async function setAliasMode(c, mode) {
  await c.db.run(`UPDATE users SET display_mode=?,alias=NULL,alias_lower=NULL WHERE id=?`, [mode, c.user.id]);
  c.user.display_mode = mode;
  return afterAlias(c);
}

async function afterAlias(c) {
  let pending = null;
  try { pending = c.user.state === 'alias_choice' || c.user.state === 'alias_text' ? JSON.parse(c.user.state_data || 'null') : null; } catch {}
  if (pending?.key) return savePrediction(c, pending.key, pending.guess, pending.price);
  await setState(c, null);
  return send(c, `✅ نام نمایشی تو: ${displayName(c.user)}`, menu(c));
}

async function savePrediction(c, key, guess, priceAtGuess) {
  const sym = SYMBOLS[key], w = windowState(key);
  if (!w.open) { await setState(c, null); return send(c, '⏱ مهلت ثبت پیش‌بینی تمام شد.', menu(c)); }
  const now = Date.now();
  const res = await c.db.batch([
    [`INSERT OR IGNORE INTO predictions(user_id,symbol,day,guess,price_at_guess,created_at) VALUES(?,?,?,?,?,?)`, [c.user.id, key, w.t.day, guess, priceAtGuess, now]],
    ['UPDATE users SET state=NULL,state_data=NULL WHERE id=?', [c.user.id]],
  ]);
  if (!res[0].changes) return send(c, '✅ امروز قبلاً برای این نماد حدس زده‌ای.', menu(c));

  await countReferral(c);
  const nextRow = Object.keys(SYMBOLS).filter((k) => k !== key && windowState(k).open)
    .map((k) => ({ text: `${SYMBOLS[k].emoji} ${SYMBOLS[k].title}`, callback_data: 'p:' + k }));
  await send(c,
    `✅ پیش‌بینی ثبت شد!\n\n${sym.emoji} ${sym.title}: ${fmt(guess, sym.decimals)} ${sym.unit}\n` +
    `🕒 نتیجه بعد از ساعت ${hhmm(w.cfg.finalAt)} اعلام می‌شود.\n\n` +
    `🖼 کارت اختصاصی پیش‌بینی‌ات تا چند دقیقه‌ی دیگر می‌آید؛ فوروارد کن و دوستانت را به کل‌کل دعوت کن!\n\n` +
    (await consensusText(c, key)),
    nextRow.length ? kb.inline([nextRow]) : undefined);
  return send(c, 'منوی اصلی 👇', menu(c));
}

// دعوت‌ها فقط وقتی «موفق» حساب می‌شوند که کاربر دعوت‌شده اولین پیش‌بینی‌اش را ثبت کند (ضد تقلب)
async function countReferral(c) {
  const u = c.user;
  if (!u.referrer_id || u.referral_counted) return;
  const ch = await c.db.run('UPDATE users SET referral_counted=1 WHERE id=? AND referral_counted=0', [u.id]);
  if (!ch) return;
  const r = await c.db.batch([
    ['UPDATE users SET referral_count=referral_count+1 WHERE id=?', [u.referrer_id]],
    ['SELECT platform,chat_id,referral_count FROM users WHERE id=?', [u.referrer_id]],
  ]);
  const ref = r[1].rows[0];
  if (!ref) return;
  const extra = ref.referral_count === REFERRAL_UNLOCK ? `\n\n🎉 به ${fmt(REFERRAL_UNLOCK)} دعوت رسیدی! «📡 سیگنال اجماع» برای همیشه برایت باز شد.` : '';
  await c.db.batch([outboxStmt(ref.platform, ref.chat_id,
    `🎉 یکی از دوستانت با لینک تو وارد مسابقه شد! دعوت‌های موفق: ${fmt(ref.referral_count)} از ${fmt(REFERRAL_UNLOCK)}${extra}`, `ref:${u.id}`)]);
}

// ---------------- سیگنال اجماع ----------------
async function consensusFor(c, keys) {
  const t = tehranNow();
  const res = await c.db.batch(keys.map((k) => [
    `SELECT AVG(p.guess) AS a,COUNT(*) AS n FROM predictions p JOIN users u ON u.id=p.user_id
     WHERE p.day=? AND p.symbol=? AND u.is_legendary=1 AND p.status!='voided'`, [t.day, k]]));
  return Object.fromEntries(keys.map((k, i) => [k, res[i].rows[0]]));
}
const lockedBox = (c) =>
  `🔒 سیگنال اجماع (میانگین حدس ${fmt(LEGENDARY.topPct)}٪ برترین تحلیل‌گران)\nقفل است — با پریمیوم یا دعوت ${fmt(REFERRAL_UNLOCK)} دوست جدید (${fmt(c.user.referral_count)}/${fmt(REFERRAL_UNLOCK)}) یا ورود به جمع 👑 لجندری‌ها باز می‌شود.`;

async function consensusText(c, key) {
  if (!canSeeSignal(c)) return lockedBox(c);
  const sym = SYMBOLS[key], r = (await consensusFor(c, [key]))[key];
  return r.n >= CONSENSUS_MIN_LEGENDS
    ? `📡 میانگین حدس ${fmt(LEGENDARY.topPct)}٪ برتر: ${fmt(r.a, sym.decimals)} ${sym.unit}`
    : `📡 سیگنال اجماع: هنوز حدس کافی از لجندری‌ها ثبت نشده.`;
}

async function showSignal(c) {
  if (!canSeeSignal(c)) {
    const contact = c.env.PREMIUM_CONTACT ? `\n\n⭐ خرید پریمیوم: ${c.env.PREMIUM_CONTACT}` : '';
    return send(c, lockedBox(c) + contact, kb.inline([[{ text: '🔗 دعوت دوستان', callback_data: 'inv' }]]));
  }
  const keys = Object.keys(SYMBOLS), r = await consensusFor(c, keys);
  const lines = keys.map((k) => {
    const s = SYMBOLS[k], x = r[k];
    return `${s.emoji} ${s.title}: ` + (x.n >= CONSENSUS_MIN_LEGENDS ? `${fmt(x.a, s.decimals)} ${s.unit} (${fmt(x.n)} نفر)` : 'داده‌ی کافی نیست');
  });
  return send(c, `📡 سیگنال اجماع امروز\nمیانگین حدس ${fmt(LEGENDARY.topPct)}٪ برترین تحلیل‌گران:\n\n${lines.join('\n')}\n\n⚠️ این یک اجماع آماری است و توصیه‌ی مالی نیست.`);
}

// ---------------- لیدربورد ----------------
async function showLeaderboard(c, scope, cb) {
  if (!SCOPES.find((s) => s[0] === scope)) scope = 'overall';
  const [top, me] = await c.db.batch([
    [`SELECT l.xp,l.scored_count,l.accuracy_sum,u.id,u.username,u.first_name,u.display_mode,u.alias,u.is_legendary
      FROM leaderboards l JOIN users u ON u.id=l.user_id WHERE l.scope=? ORDER BY l.xp DESC,l.scored_count DESC,u.id LIMIT 10`, [scope]],
    [`SELECT xp,(SELECT COUNT(*)+1 FROM leaderboards WHERE scope=? AND xp>l.xp) AS pos FROM leaderboards l WHERE user_id=? AND scope=?`, [scope, c.user.id, scope]],
  ]);
  const title = SCOPES.find((s) => s[0] === scope)[1];
  const lines = top.rows.map((r, i) => `${medal(i)} ${displayName(r)} — ${fmt(r.xp)} XP · دقت ${fmt(r.accuracy_sum / r.scored_count)}٪`);
  const mine = me.rows[0] ? `\n\n📍 رتبه‌ی تو: ${fmt(me.rows[0].pos)} با ${fmt(me.rows[0].xp)} XP` : '\n\n📍 هنوز در این جدول امتیازی نداری؛ اولین حدست را ثبت کن!';
  const text = `🏆 لیدربورد ${title}\n\n${lines.join('\n') || 'هنوز کسی امتیاز نگرفته. اولین نفر باش! 🚀'}${mine}`;
  const rows = [];
  for (let i = 0; i < SCOPES.length; i += 3) rows.push(SCOPES.slice(i, i + 3).map(([k, l]) => ({ text: (k === scope ? '• ' : '') + l, callback_data: 'lb:' + k })));
  const buttons = kb.inline(rows);
  if (cb?.message?.message_id) {
    const r = await c.P.editMessage(c.chatId, cb.message.message_id, text, buttons);
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }
  return send(c, text, buttons);
}

// ---------------- پروفایل / دعوت / راهنما ----------------
async function showProfile(c) {
  const u = c.user;
  const [lb, pos] = await c.db.batch([
    [`SELECT xp,scored_count,accuracy_sum FROM leaderboards WHERE user_id=? AND scope='overall'`, [u.id]],
    [`SELECT COUNT(*)+1 AS pos FROM leaderboards WHERE scope='overall' AND xp>(SELECT COALESCE(MAX(xp),0) FROM leaderboards WHERE user_id=? AND scope='overall')`, [u.id]],
  ]);
  const l = lb.rows[0];
  const status = u.is_legendary ? '👑 لجندری' : (u.premium_until > Date.now() ? `⭐ پریمیوم تا ${jalaliDate(u.premium_until)}` : 'عادی');
  const text =
    `👤 پروفایل\n\nشناسه: ${u.id}\nنام نمایشی: ${u.display_mode ? displayName(u) : 'هنوز انتخاب نشده'}\nوضعیت: ${status}\n` +
    (l ? `⭐ کل امتیاز: ${fmt(l.xp)} XP\n🏅 رتبه‌ی کلی: ${fmt(pos.rows[0].pos)}\n🎯 میانگین دقت: ${fmt(l.accuracy_sum / l.scored_count)}٪ (${fmt(l.scored_count)} پیش‌بینی)\n` : '⭐ هنوز پیش‌بینی نتیجه‌داری نداری\n') +
    `🔗 دعوت‌های موفق: ${fmt(u.referral_count)} از ${fmt(REFERRAL_UNLOCK)}\n📡 سیگنال اجماع: ${canSeeSignal(c) ? `باز ✅${!hasSignalAccess(u) ? ' (دسترسی ادمین)' : ''}` : 'قفل 🔒'}`;
  return send(c, text, kb.inline([[{ text: '✏️ تغییر نام نمایشی', callback_data: 'al:menu' }]]));
}

async function showInvite(c) {
  const link = botLink(c.env, c.platform, c.user.id);
  const text =
    `🔗 لینک اختصاصی دعوت تو:\n${link}\n\n` +
    `هر دوستی که با این لینک وارد شود و اولین پیش‌بینی‌اش را ثبت کند، یک «دعوت موفق» حساب می‌شود.\n` +
    `با ${fmt(REFERRAL_UNLOCK)} دعوت موفق «📡 سیگنال اجماع» برای همیشه برایت باز می‌شود.\n\n` +
    `📊 دعوت‌های موفق تو: ${fmt(c.user.referral_count)} از ${fmt(REFERRAL_UNLOCK)}`;
  const share = c.platform === 'telegram'
    ? kb.inline([[{ text: '📤 ارسال برای دوستان', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🎯 بیا با هم قیمت دلار و طلا رو حدس بزنیم و کل‌کل کنیم!')}` }]])
    : undefined;
  return send(c, text, share);
}

function showHelp(c) {
  const dom = MARKETS.domestic, glob = MARKETS.global;
  return send(c,
    `ℹ️ راهنمای مسابقه\n\n` +
    `🇮🇷 دلار / طلا / سکه: ثبت حدس تا ${hhmm(dom.closeAt)} — قیمت مرجع ساعت ${hhmm(dom.finalAt)}\n` +
    `🌍 اونس طلا: ثبت حدس تا ${hhmm(glob.closeAt)} — قیمت مرجع ساعت ${hhmm(glob.finalAt)} (شنبه و یکشنبه تعطیل)\n` +
    `(همه‌ی ساعت‌ها به وقت تهران)\n\n` +
    `⭐ امتیاز هر حدس = امتیاز دقت (تا ۱۰۰) + جایزه‌ی رتبه (نفر اول ${fmt(SCORING.rankBonus[0])}، دوم ${fmt(SCORING.rankBonus[1])}، سوم ${fmt(SCORING.rankBonus[2])} — با حداقل ${fmt(SCORING.minParticipantsForRankBonus)} شرکت‌کننده) + ${fmt(SCORING.participationXp)} امتیاز مشارکت.\n\n` +
    `🚫 اگر بازار تعطیل باشد (بدون نوسان)، پیش‌بینی‌های آن روز باطل می‌شود و امتیازی کسر نمی‌شود.\n` +
    `👑 ${fmt(LEGENDARY.topPct)}٪ برترین‌های ${fmt(LEGENDARY.windowDays)} روز اخیر «لجندری» می‌شوند و سیگنال اجماع را می‌بینند.`, menu(c));
}


// ---------------- پنل ادمین ----------------
function showAdmin(c) {
  if (!isAdmin(c)) return;
  return send(c, `🛠 پنل ادمین\n\nیکی از گزینه‌ها را انتخاب کن. (دستورهای معادل: /stats ، /premium شناسه روز ، /broadcast متن)`,
    kb.inline([
      [{ text: '📈 آمار سیستم', callback_data: 'ad:stats' }],
      [{ text: '⭐ اعطای پریمیوم', callback_data: 'ad:prem' }, { text: '📣 پیام همگانی', callback_data: 'ad:bc' }],
    ]));
}

async function adminStats(c) {
  const t = tehranNow();
  const r = await c.db.batch([
    ['SELECT platform,COUNT(*) n FROM users GROUP BY platform', []],
    ['SELECT symbol,COUNT(*) n FROM predictions WHERE day=? GROUP BY symbol', [t.day]],
    ['SELECT COUNT(*) n FROM users WHERE is_legendary=1', []],
    [`SELECT COUNT(*) n FROM outbox WHERE status='pending'`, []],
    ['SELECT COUNT(*) n FROM users WHERE is_blocked=1', []],
  ]);
  return send(c, `📈 آمار\nکاربران: ${r[0].rows.map((x) => `${x.platform}=${x.n}`).join(' ، ') || 0}\n` +
    `پیش‌بینی‌های امروز: ${r[1].rows.map((x) => `${x.symbol}=${x.n}`).join(' ، ') || 0}\n` +
    `لجندری: ${r[2].rows[0].n}\nبلاک‌کرده‌ها: ${r[4].rows[0].n}\nصف پیام (در انتظار): ${r[3].rows[0].n}`);
}

async function grantPremium(c, id, days) {
  if (!id || !days || days < 1) return send(c, 'فرمت: /premium <شناسه‌ی کاربر> <تعداد روز>   (شناسه در «👤 پروفایل» کاربر دیده می‌شود)');
  const now = Date.now();
  const ch = await c.db.run('UPDATE users SET premium_until=MAX(?,premium_until)+? WHERE id=?', [now, days * 86400000, id]);
  if (!ch) return send(c, 'کاربر پیدا نشد.');
  const u = await c.db.get('SELECT platform,chat_id,premium_until FROM users WHERE id=?', [id]);
  await c.db.batch([outboxStmt(u.platform, u.chat_id, `⭐ اشتراک پریمیوم شما تا ${jalaliDate(u.premium_until)} فعال شد. «📡 سیگنال اجماع» برایت باز است!`, `prem:${id}:${now}`)]);
  return send(c, `✅ پریمیوم کاربر ${id} تا ${jalaliDate(u.premium_until)} فعال شد.`);
}

async function queueBroadcast(c, body) {
  if (!body) return send(c, 'فرمت: /broadcast متن پیام');
  const now = Date.now();
  const ch = await c.db.run(
    `INSERT OR IGNORE INTO outbox(dedupe_key,platform,chat_id,text,created_at) SELECT 'bc:'||?||':'||id,platform,chat_id,?,? FROM users WHERE is_blocked=0`,
    [now, body, now]);
  return send(c, `✅ ${fmt(ch)} پیام در صف ارسال قرار گرفت (حدود ${fmt(Math.ceil(ch / 18))} دقیقه).`);
}

async function adminPremiumInput(c, text) {
  const [a, b] = text.split(/\s+/).map((x) => Number(parseNumber(x, false)));
  if (!a || !b) return send(c, '⚠️ دو عدد بفرست: شناسه‌ی کاربر و تعداد روز. مثل: 125 30');
  await setState(c, null);
  return grantPremium(c, a, b);
}

async function adminBroadcastInput(c, text) {
  await setState(c, 'admin_bc_confirm', text);
  const n = (await c.db.get('SELECT COUNT(*) n FROM users WHERE is_blocked=0')).n;
  return send(c, `📣 پیش‌نمایش پیام همگانی (به ${fmt(n)} کاربر):\n\n${text}`,
    kb.inline([[{ text: '✅ ارسال', callback_data: 'ad:bcgo' }, { text: '❌ انصراف', callback_data: 'cancel' }]]));
}

async function onAdminCallback(c, act) {
  if (!isAdmin(c)) return;
  if (act === 'stats') return adminStats(c);
  if (act === 'prem') { await setState(c, 'admin_premium'); return send(c, '⭐ شناسه‌ی کاربر و تعداد روز را با فاصله بفرست. مثل: 125 30'); }
  if (act === 'bc') { await setState(c, 'admin_bc'); return send(c, '📣 متن پیام همگانی را بفرست (قبل از ارسال، پیش‌نمایش می‌بینی):'); }
  if (act === 'bcgo' && c.user.state === 'admin_bc_confirm') {
    const body = c.user.state_data;
    await setState(c, null);
    return queueBroadcast(c, body);
  }
}

// ---------------- دکمه‌های شیشه‌ای ----------------
async function onCallback(c, cb) {
  await c.P.answerCallback(cb.id);
  const d = cb.data || '';
  if (d === 'gc:yes') return onGuessConfirmYes(c);
  if (d === 'gc:no') return onGuessConfirmNo(c);
  if (d.startsWith('ad:')) return onAdminCallback(c, d.slice(3));
  if (d === 'cancel') { await setState(c, null); return send(c, 'انصراف داده شد.', menu(c)); }
  if (d === 'pm') return showPredictMenu(c);
  if (d === 'inv') return showInvite(c);
  if (d.startsWith('p:')) return pickSymbol(c, d.slice(2));
  if (d.startsWith('lb:')) return showLeaderboard(c, d.slice(3), cb);
  if (d.startsWith('al:')) {
    const act = d.slice(3);
    if (act === 'menu') { await setState(c, 'alias_choice', null); c.user.state = 'alias_choice'; c.user.state_data = null; return askAlias(c); }
    if (act === 'anon' || act === 'username') return setAliasMode(c, act);
    if (act === 'custom') {
      await c.db.run(`UPDATE users SET state='alias_text' WHERE id=?`, [c.user.id]);
      c.user.state = 'alias_text';
      return send(c, '✏️ نام مستعار دلخواهت را بفرست (۳ تا ۲۰ نویسه، بدون لینک و @):');
    }
  }
}
