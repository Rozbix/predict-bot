// کلاینت سبک Turso روی HTTP (Hrana over HTTP) — بدون نیاز به SDK
// هر فراخوانی db.batch() فقط «یک» subrequest مصرف می‌کند (مهم برای سقف ۵۰ تایی پلن رایگان).

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    username TEXT, first_name TEXT,
    display_mode TEXT, alias TEXT, alias_lower TEXT,
    is_legendary INTEGER NOT NULL DEFAULT 0, legendary_since TEXT,
    premium_until INTEGER NOT NULL DEFAULT 0,
    referrer_id INTEGER, referral_count INTEGER NOT NULL DEFAULT 0, referral_counted INTEGER NOT NULL DEFAULT 0,
    state TEXT, state_data TEXT,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER, last_seen INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_platform ON users(platform, platform_user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_alias ON users(alias_lower) WHERE alias_lower IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS predictions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, symbol TEXT NOT NULL, day TEXT NOT NULL,
    guess REAL NOT NULL, price_at_guess REAL,
    status TEXT NOT NULL DEFAULT 'pending',        -- pending | scored | voided
    final_price REAL, error_pct REAL, rank_pos INTEGER, accuracy INTEGER, xp INTEGER NOT NULL DEFAULT 0,
    card_status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | text
    created_at INTEGER, scored_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pred_user_sym_day ON predictions(user_id, symbol, day)`,
  `CREATE INDEX IF NOT EXISTS ix_pred_day_sym ON predictions(day, symbol, status)`,
  `CREATE INDEX IF NOT EXISTS ix_pred_card ON predictions(card_status, id)`,
  `CREATE TABLE IF NOT EXISTS daily_final_prices(
    symbol TEXT NOT NULL, day TEXT NOT NULL,
    status TEXT NOT NULL,                          -- open | holiday | final | void
    final_price REAL, final_ts INTEGER, note TEXT, created_at INTEGER,
    PRIMARY KEY(symbol, day))`,
  `CREATE TABLE IF NOT EXISTS price_snapshots(
    symbol TEXT NOT NULL, day TEXT NOT NULL, slot INTEGER NOT NULL,
    price REAL NOT NULL, ts INTEGER,
    PRIMARY KEY(symbol, day, slot))`,
  `CREATE TABLE IF NOT EXISTS leaderboards(
    user_id INTEGER NOT NULL, scope TEXT NOT NULL,  -- scope: usd|gold|coin|xau|overall
    xp INTEGER NOT NULL DEFAULT 0, scored_count INTEGER NOT NULL DEFAULT 0, accuracy_sum INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id, scope))`,
  `CREATE INDEX IF NOT EXISTS ix_lb_scope_xp ON leaderboards(scope, xp DESC)`,
  `CREATE TABLE IF NOT EXISTS outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT UNIQUE, platform TEXT NOT NULL, chat_id TEXT NOT NULL,
    text TEXT NOT NULL, buttons TEXT,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS ix_outbox_status ON outbox(status, id)`,
  `CREATE TABLE IF NOT EXISTS job_runs(job TEXT NOT NULL, day TEXT NOT NULL, ran_at INTEGER, PRIMARY KEY(job, day))`,
];

function enc(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  return { type: 'text', value: String(v) };
}
function dec(c) {
  if (!c || c.type === 'null') return null;
  if (c.type === 'integer') return Number(c.value);
  if (c.type === 'float') return Number(c.value);
  return c.value;
}

export function makeDb(env, meter) {
  if (env.__db) return env.__db;                       // برای تست‌های محلی
  const base = String(env.TURSO_URL || '').replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  if (!base) throw new Error('TURSO_URL تنظیم نشده است');

  async function batch(stmts) {
    if (!stmts.length) return [];
    if (meter) meter.n++;
    const res = await fetch(base + '/v2/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          ...stmts.map(([sql, args]) => ({ type: 'execute', stmt: { sql, args: (args || []).map(enc) } })),
          { type: 'close' },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return stmts.map((s, i) => {
      const r = j.results[i];
      if (!r || r.type === 'error') throw new Error(`Turso: ${r?.error?.message || 'unknown'} | ${s[0].replace(/\s+/g, ' ').slice(0, 90)}`);
      const rs = r.response.result;
      const cols = rs.cols.map((c) => c.name);
      return {
        rows: rs.rows.map((row) => Object.fromEntries(row.map((c, k) => [cols[k], dec(c)]))),
        changes: rs.affected_row_count || 0,
      };
    });
  }
  // برای دستورهای زیاد: قطعه‌قطعه (هر قطعه یک subrequest)
  async function bigBatch(stmts, size = 200) {
    const out = [];
    for (let i = 0; i < stmts.length; i += size) out.push(...(await batch(stmts.slice(i, i + size))));
    return out;
  }
  return {
    batch, bigBatch,
    async all(sql, args) { return (await batch([[sql, args]]))[0].rows; },
    async get(sql, args) { return (await batch([[sql, args]]))[0].rows[0] || null; },
    async run(sql, args) { return (await batch([[sql, args]]))[0].changes; },
  };
}

export async function initSchema(db) {
  await db.batch(SCHEMA.map((s) => [s, []]));
  return SCHEMA.length;
}
