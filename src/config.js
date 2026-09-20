// =====================================================================
//  تنظیمات مرکزی مسابقه — بیشتر تغییرات شما فقط در همین فایل است
// =====================================================================

// ---------------------------------------------------------------------
// ۱) نمادها و «منبع قیمت»
// ---------------------------------------------------------------------
// مهم: کوئری‌های source را با ساختار واقعی جدول قیمت‌های خودتان در Turso تطبیق دهید.
// هر کوئری باید یک ردیف با ستون‌های زیر برگرداند:
//    price  → قیمت عددی
//    ts     → زمان آخرین بروزرسانی (اختیاری ولی بسیار توصیه‌شده؛ عدد ثانیه/میلی‌ثانیه یا رشته تاریخ ISO)
// برای پیدا کردن نام جدول‌ها: /admin/tables?key=ADMIN_KEY
export const SYMBOLS = {
  usd: {
    title: 'دلار', emoji: '💵', unit: 'تومان', market: 'domestic', decimals: 0,
    tolerancePct: 1.5,           // خطای بالاتر از این درصد ⇒ امتیاز دقت صفر
    source: { sql: 'SELECT price, updated_at AS ts FROM prices WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1', args: ['USD'] },
  },
  gold: {
    title: 'طلا ۱۸ عیار', emoji: '🪙', unit: 'تومان', market: 'domestic', decimals: 0,
    tolerancePct: 1.5,
    source: { sql: 'SELECT price, updated_at AS ts FROM prices WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1', args: ['GOLD18'] },
  },
  coin: {
    title: 'سکه امامی', emoji: '🏅', unit: 'تومان', market: 'domestic', decimals: 0,
    tolerancePct: 1.5,
    source: { sql: 'SELECT price, updated_at AS ts FROM prices WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1', args: ['COIN'] },
  },
  xau: {
    title: 'اونس طلا', emoji: '🥇', unit: 'دلار', market: 'global', decimals: 2,
    tolerancePct: 1,
    source: { sql: 'SELECT price, updated_at AS ts FROM prices WHERE symbol = ? ORDER BY updated_at DESC LIMIT 1', args: ['XAUUSD'] },
  },
};

// ---------------------------------------------------------------------
// ۲) پنجره‌های زمانی (همه به وقت تهران، فرمت HH:MM)
// ---------------------------------------------------------------------
// disabledDows: روزهای هفته‌ای که ثبت حدس غیرفعال است (0=یکشنبه … 6=شنبه به تعریف JavaScript)
export const MARKETS = {
  domestic: {
    closeAt: '12:00',            // پایان ثبت پیش‌بینی (آغاز از ۰۰:۰۰)
    holidayCheckFrom: '11:00',   // شروع بازه‌ی بررسی تعطیلی
    finalAt: '17:00',            // ساعت ثبت قیمت مرجع
    disabledDows: [],
    holidayThresholdPct: 0.01,   // تغییر کمتر یا مساوی این درصد ⇒ بازار تعطیل
    label: 'بازار داخلی',
  },
  global: {
    closeAt: '14:00',
    holidayCheckFrom: '12:00',
    finalAt: '23:30',
    disabledDows: [6, 0],        // شنبه و یکشنبه
    holidayThresholdPct: 0.01,
    label: 'بازار جهانی',
  },
};

// اگر آخرین قیمت منبع قدیمی‌تر از این مقدار (دقیقه) باشد، «داده کهنه» حساب می‌شود
export const STALE_MINUTES = 60;   // برای تشخیص تعطیلی (جلوگیری از ابطال اشتباه وقتی منبع قیمت از کار افتاده)
export const FRESH_MINUTES = 35;   // برای پذیرش قیمت نهایی
export const FINAL_RETRY_MINUTES = 180; // چند دقیقه بعد از ساعت نهایی هنوز تلاش کنیم (حداکثر تا ۲۳:۵۹)

// ---------------------------------------------------------------------
// ۳) امتیازدهی (XP)
// ---------------------------------------------------------------------
// XP هر پیش‌بینی = امتیاز دقت (۰..۱۰۰) + جایزه‌ی رتبه + امتیاز مشارکت
//   دقت = 100 × (1 − خطا٪ / tolerancePct)
export const SCORING = {
  participationXp: 5,
  minParticipantsForRankBonus: 3,  // جایزه رتبه فقط وقتی حداقل این تعداد شرکت‌کننده باشد
  rankBonus: [50, 30, 15],         // نفر اول، دوم، سوم
  maxDeviationPct: 10,             // حدس‌هایی که بیش از این درصد با قیمت لحظه‌ای فاصله دارند رد می‌شوند
};

// ---------------------------------------------------------------------
// ۴) لجندری، رفرال، پریمیوم
// ---------------------------------------------------------------------
export const LEGENDARY = { windowDays: 30, topPct: 10, minScored: 5, minUsers: 5 };
export const REFERRAL_UNLOCK = 5;         // تعداد دعوت موفق برای آنلاک دائمی سیگنال اجماع
export const CONSENSUS_MIN_LEGENDS = 3;   // حداقل تعداد حدس لجندری‌ها برای نمایش میانگین (حفظ حریم خصوصی)

// ---------------------------------------------------------------------
// ۵) عملیات
// ---------------------------------------------------------------------
export const OUTBOX_PER_TICK = 18;   // تعداد پیام صف در هر دقیقه (سقف ۵۰ subrequest در پلن رایگان)
export const CARDS_PER_TICK = 2;     // تعداد کارت تصویری در هر دقیقه (سقف ۳ مرورگر جدید در دقیقه)
export const SUBREQUEST_BUDGET = 46; // بودجه‌ی درخواست‌های خروجی در هر اجرا

export const BOT_TAGLINE = '@nerkhemroozchand_predict_bot';
