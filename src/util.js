// ابزارهای زمان (تهران)، اعداد فارسی، فرمت، نام نمایشی
import { REFERRAL_UNLOCK } from './config.js';
const TZ_OFFSET_MIN = 210; // UTC+03:30 (ایران از ۱۴۰۱ ساعت تابستانی ندارد)

export function tehranNow(ms = Date.now()) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return {
    day: d.toISOString().slice(0, 10),        // YYYY-MM-DD میلادی به وقت تهران
    dow: d.getUTCDay(),                       // 0=یکشنبه ... 6=شنبه
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
export const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const FA_DOW = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];   // مطابق با اندیس getUTCDay استاندارد جاوااسکریپت
export const disabledDaysLabel = (dows) => dows.map((d) => FA_DOW[d]).join(' و ');
export function nextOpenDayName(dows, fromDow) {
  for (let i = 1; i <= 7; i++) { const d = (fromDow + i) % 7; if (!dows.includes(d)) return FA_DOW[d]; }
  return '';
}
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';
export function toLatinDigits(s) {
  return String(s).replace(/[۰-۹]/g, (c) => FA.indexOf(c)).replace(/[٠-٩]/g, (c) => AR.indexOf(c));
}
export function parseNumber(text, allowDecimal) {
  let t = toLatinDigits(text).replace(/[\s,٬،]/g, '').replace(/٫/g, '.');
  if (!allowDecimal) t = t.replace(/\.(?=\d{3}(\D|$))/g, '');   // 88.450 → 88450
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!allowDecimal && !Number.isInteger(n)) return null;
  return n;
}
export const fmt = (n, decimals = 0) =>
  Number(n).toLocaleString('fa-IR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const fmtPct = (n) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: 2 }) + '٪';

export const jalaliDate = (ms) =>
  new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tehran' }).format(ms);
export const jalaliDateFromDay = (day) => jalaliDate(Date.parse(day + 'T09:00:00Z'));
export const clock = (ms) =>
  new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(ms);

// زمان (عدد ثانیه/میلی‌ثانیه یا رشته) → میلی‌ثانیه
export function parseTs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';   // بدون منطقه زمانی ⇒ UTC فرض می‌شود
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function cleanAlias(input) {
  const s = String(input || '')
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 20) return null;
  if (/^[@#\/]/.test(s) || /https?:|t\.me|ble\.ir|www\./i.test(s)) return null;
  return s;
}

export function displayName(u) {
  let name;
  if (u.display_mode === 'custom' && u.alias) name = u.alias;
  else if (u.display_mode === 'username' && (u.username || u.first_name)) name = u.username ? '@' + u.username : u.first_name;
  else name = `ناشناس #${u.id}`;
  return (u.is_legendary ? '👑 ' : '') + name;
}

export const hasSignalAccess = (u, now = Date.now()) =>
  !!u.is_legendary || (u.premium_until || 0) > now || (u.referral_count || 0) >= REFERRAL_UNLOCK;

export const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${(i + 1).toLocaleString('fa-IR')}.`;
export const botLink = (env, platform, userId) => {
  const ref = userId ? `?start=ref_${userId}` : '';
  return platform === 'bale'
    ? `https://ble.ir/${env.BALE_BOT_USERNAME}${ref}`
    : `https://t.me/${env.TELEGRAM_BOT_USERNAME}${ref}`;
};
