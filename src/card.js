// ساخت کارت تصویری قابل اشتراک‌گذاری (Dark Theme) با Browser Rendering + نسخه‌ی متنی جایگزین
import puppeteer from '@cloudflare/puppeteer';
import { BOT_TAGLINE } from './config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function cardHtml(d) {
  const accent = d.legendary ? '#f5c451' : '#4c8dff';
  const accent2 = d.legendary ? '#b8860b' : '#1e3a8a';
  const initial = esc([...d.plainName][0] || '?');
  const avatar = d.avatar
    ? `<img src="${d.avatar}" class="av">`
    : `<div class="av ph">${initial}</div>`;
  return `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1080px;height:566px;font-family:'Vazirmatn',Tahoma,sans-serif;background:#05080f;color:#e8eefc;overflow:hidden}
.card{position:relative;width:1080px;height:566px;padding:44px 56px;
 background:radial-gradient(900px 500px at 85% 0%,${accent2}55,transparent 60%),linear-gradient(160deg,#0c1424,#060a13 70%);
 border:4px solid ${accent};border-radius:0;box-shadow:inset 0 0 80px ${accent}22}
.top{display:flex;align-items:center;gap:22px}
.av{width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid ${accent}}
.ph{display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:900;background:#111a2e;color:${accent}}
.name{font-size:38px;font-weight:900}
.sub{font-size:22px;color:#8ea0c4;margin-top:4px}
.badge{margin-right:auto;padding:8px 22px;border:2px solid ${accent};border-radius:999px;color:${accent};font-size:22px;font-weight:700}
.mid{margin-top:34px;text-align:center}
.sym{font-size:34px;color:#b8c6e6;font-weight:700}
.num{font-size:112px;font-weight:900;line-height:1.15;color:${accent};text-shadow:0 0 40px ${accent}66;letter-spacing:1px}
.unit{font-size:32px;color:#b8c6e6}
.ref{margin-top:6px;font-size:22px;color:#7f91b6}
.bot{position:absolute;right:56px;left:56px;bottom:34px;display:flex;justify-content:space-between;align-items:center;
 font-size:22px;color:#7f91b6;border-top:1px solid #1c2840;padding-top:16px}
.tag{direction:ltr;color:${accent};font-weight:700;font-size:24px}
svg.deco{position:absolute;left:0;bottom:70px;width:100%;height:120px;opacity:.13}
</style></head><body><div class="card">
<svg class="deco" viewBox="0 0 1080 120" preserveAspectRatio="none"><polyline fill="none" stroke="${accent}" stroke-width="3" points="0,90 90,70 170,84 260,44 350,60 440,30 540,52 640,20 740,48 840,26 940,40 1080,8"/></svg>
<div class="top">${avatar}<div><div class="name">${esc(d.name)}</div><div class="sub">پیش‌بینی ثبت‌شده در مسابقه‌ی نرخ‌روز</div></div>
${d.legendary ? '<div class="badge">👑 تحلیل‌گر لجندری</div>' : ''}</div>
<div class="mid"><div class="sym">${d.emoji} پیش‌بینی قیمت ${esc(d.symbolTitle)} برای امروز</div>
<div class="num">${esc(d.guess)}</div><div class="unit">${esc(d.unit)}</div>
<div class="ref">قیمت لحظه‌ای هنگام ثبت: ${esc(d.priceAtGuess)} ${esc(d.unit)}</div></div>
<div class="bot"><div>🕒 ${esc(d.dateStr)} — ساعت ${esc(d.timeStr)}</div><div class="tag">${esc(BOT_TAGLINE)}</div></div>
</div></body></html>`;
}

// خروجی: Uint8Array (PNG) یا null اگر امکان رندر نبود (سهمیه/باینینگ/خطا)
export async function renderCards(env, list) {
  const out = new Map();
  if (!env.BROWSER || !list.length) return out;
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    for (const d of list) {
      let page;
      try {
        page = await browser.newPage();
        await page.setViewport({ width: 1080, height: 566, deviceScaleFactor: 1 });
        await page.setContent(cardHtml(d), { waitUntil: 'networkidle0', timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        out.set(d.key, await page.screenshot({ type: 'png' }));
      } catch (e) { console.error('card render failed', e.message); }
      finally { try { await page?.close(); } catch {} }
    }
  } catch (e) {
    console.error('browser launch failed', e.message);   // مثلاً 429: سهمیه ۱۰ دقیقه‌ای روزانه تمام شده
  } finally { try { await browser?.close(); } catch {} }
  return out;
}

export function textCard(d) {
  return `┏━━━━━━━━━━━━━━━━━━┓
${d.legendary ? '👑 ' : '👤 '}${d.plainName}
${d.emoji} پیش‌بینی ${d.symbolTitle}: ${d.guess} ${d.unit}
📍 قیمت لحظه‌ای: ${d.priceAtGuess} ${d.unit}
🕒 ${d.dateStr} — ${d.timeStr}
┗━━━━━━━━━━━━━━━━━━┛
${BOT_TAGLINE}`;
}
