-- جداول مسابقه (با /admin/init هم ساخته می‌شوند)
CREATE TABLE IF NOT EXISTS users(
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
  created_at INTEGER, last_seen INTEGER);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_platform ON users(platform, platform_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_alias ON users(alias_lower) WHERE alias_lower IS NOT NULL;

CREATE TABLE IF NOT EXISTS predictions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, symbol TEXT NOT NULL, day TEXT NOT NULL,
  guess REAL NOT NULL, price_at_guess REAL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | scored | voided
  final_price REAL, error_pct REAL, rank_pos INTEGER, accuracy INTEGER, xp INTEGER NOT NULL DEFAULT 0,
  card_status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | text
  created_at INTEGER, scored_at INTEGER);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pred_user_sym_day ON predictions(user_id, symbol, day);

CREATE INDEX IF NOT EXISTS ix_pred_day_sym ON predictions(day, symbol, status);

CREATE INDEX IF NOT EXISTS ix_pred_card ON predictions(card_status, id);

CREATE TABLE IF NOT EXISTS daily_final_prices(
  symbol TEXT NOT NULL, day TEXT NOT NULL,
  status TEXT NOT NULL,                          -- open | holiday | final | void
  final_price REAL, final_ts INTEGER, note TEXT, created_at INTEGER,
  PRIMARY KEY(symbol, day));

CREATE TABLE IF NOT EXISTS price_snapshots(
  symbol TEXT NOT NULL, day TEXT NOT NULL, slot INTEGER NOT NULL,
  price REAL NOT NULL, ts INTEGER,
  PRIMARY KEY(symbol, day, slot));

CREATE TABLE IF NOT EXISTS leaderboards(
  user_id INTEGER NOT NULL, scope TEXT NOT NULL,  -- scope: usd|gold|coin|xau|overall
  xp INTEGER NOT NULL DEFAULT 0, scored_count INTEGER NOT NULL DEFAULT 0, accuracy_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, scope));

CREATE INDEX IF NOT EXISTS ix_lb_scope_xp ON leaderboards(scope, xp DESC);

CREATE TABLE IF NOT EXISTS outbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT UNIQUE, platform TEXT NOT NULL, chat_id TEXT NOT NULL,
  text TEXT NOT NULL, buttons TEXT,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER);

CREATE INDEX IF NOT EXISTS ix_outbox_status ON outbox(status, id);

CREATE TABLE IF NOT EXISTS job_runs(job TEXT NOT NULL, day TEXT NOT NULL, ran_at INTEGER, PRIMARY KEY(job, day));
