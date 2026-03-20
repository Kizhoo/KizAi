-- ============================================================
-- KizAi v2 — Supabase SQL Schema (COMPLETE + FIXED)
-- Cara pakai: Supabase Dashboard > SQL Editor > New Query > Run
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── PROFILES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  avatar_color    TEXT DEFAULT '#5B5FEE',
  avatar_emoji    TEXT DEFAULT '😊',
  telegram_id     TEXT DEFAULT '',
  bio             TEXT DEFAULT '',
  role            TEXT DEFAULT 'user' CHECK (role IN ('user','admin')),
  plan            TEXT DEFAULT 'free' CHECK (plan IN ('free','premium','vip')),
  plan_expires    TIMESTAMPTZ DEFAULT NULL,
  xp              INTEGER DEFAULT 0,
  level           INTEGER DEFAULT 1,
  coins           INTEGER DEFAULT 50,
  streak          INTEGER DEFAULT 0,
  streak_last     DATE DEFAULT NULL,
  games_played    INTEGER DEFAULT 0,
  chat_messages   INTEGER DEFAULT 0,
  tools_used      INTEGER DEFAULT 0,
  referral_code   TEXT UNIQUE DEFAULT NULL,
  preferences     JSONB DEFAULT '{"theme":"dark","language":"id","notificationsEnabled":true}',
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ORDERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id          TEXT UNIQUE NOT NULL,
  user_id           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  telegram_id       TEXT DEFAULT '',
  customer_name     TEXT DEFAULT '',
  email             TEXT DEFAULT '',
  plan              TEXT NOT NULL CHECK (plan IN ('premium','vip')),
  duration          INTEGER NOT NULL,
  price             INTEGER NOT NULL DEFAULT 0,
  payment_method    TEXT DEFAULT 'qris',
  coupon            TEXT DEFAULT NULL,
  discount          INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  snap_token        TEXT DEFAULT NULL,
  snap_redirect_url TEXT DEFAULT NULL,
  payment_data      JSONB DEFAULT '{}',
  activated_at      TIMESTAMPTZ DEFAULT NULL,
  expires_at        TIMESTAMPTZ DEFAULT NULL,
  notified          BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHAT SESSIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id       UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title         TEXT DEFAULT 'New Chat',
  model_id      TEXT DEFAULT 'llama-8b',
  is_pinned     BOOLEAN DEFAULT FALSE,
  message_count INTEGER DEFAULT 0,
  last_message  TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHAT MESSAGES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_id  UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  model_id    TEXT DEFAULT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTIFICATIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type        TEXT DEFAULT 'info' CHECK (type IN ('info','success','warning','achievement','system')),
  title       TEXT NOT NULL,
  message     TEXT DEFAULT '',
  icon        TEXT DEFAULT '🔔',
  is_read     BOOLEAN DEFAULT FALSE,
  action_url  TEXT DEFAULT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── BOOKMARKS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmarks (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type        TEXT DEFAULT 'tool',
  item_id     TEXT NOT NULL,
  item_name   TEXT DEFAULT '',
  item_emoji  TEXT DEFAULT '⭐',
  note        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type, item_id)
);

-- ── ANNOUNCEMENTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  type        TEXT DEFAULT 'info',
  is_active   BOOLEAN DEFAULT TRUE,
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── SITE SETTINGS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements     ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE POLICY IF NOT EXISTS "profiles_select" ON profiles FOR SELECT
  USING (auth.uid() = id OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
CREATE POLICY IF NOT EXISTS "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY IF NOT EXISTS "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Orders
CREATE POLICY IF NOT EXISTS "orders_select" ON orders FOR SELECT
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY IF NOT EXISTS "orders_insert" ON orders FOR INSERT WITH CHECK (TRUE);
CREATE POLICY IF NOT EXISTS "orders_update" ON orders FOR UPDATE USING (TRUE);

-- Chat
CREATE POLICY IF NOT EXISTS "sessions_all" ON chat_sessions FOR ALL USING (user_id = auth.uid());
CREATE POLICY IF NOT EXISTS "messages_all" ON chat_messages FOR ALL USING (user_id = auth.uid());

-- Bookmarks & Notifications
CREATE POLICY IF NOT EXISTS "bookmarks_all"     ON bookmarks     FOR ALL USING (user_id = auth.uid());
CREATE POLICY IF NOT EXISTS "notifications_all" ON notifications FOR ALL USING (user_id = auth.uid());

-- Announcements
CREATE POLICY IF NOT EXISTS "announcements_read"  ON announcements FOR SELECT USING (is_active = TRUE);
CREATE POLICY IF NOT EXISTS "announcements_admin" ON announcements FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- ── TRIGGERS ──────────────────────────────────────────────────

-- Auto-create profile row saat user baru register
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE _username TEXT; _code TEXT;
BEGIN
  _username := COALESCE(NEW.raw_user_meta_data->>'username', SPLIT_PART(NEW.email,'@',1));
  _code     := UPPER(SUBSTRING(MD5(NEW.id::TEXT), 1, 8));
  INSERT INTO profiles (id, username, referral_code, coins)
  VALUES (NEW.id, _username, _code, 50)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Auto updated_at
CREATE OR REPLACE FUNCTION upd_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS profiles_ts ON profiles;
DROP TRIGGER IF EXISTS orders_ts   ON orders;
DROP TRIGGER IF EXISTS sessions_ts ON chat_sessions;
CREATE TRIGGER profiles_ts  BEFORE UPDATE ON profiles      FOR EACH ROW EXECUTE FUNCTION upd_timestamp();
CREATE TRIGGER orders_ts    BEFORE UPDATE ON orders        FOR EACH ROW EXECUTE FUNCTION upd_timestamp();
CREATE TRIGGER sessions_ts  BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION upd_timestamp();

-- Auto level dari XP
CREATE OR REPLACE FUNCTION sync_level()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.level := GREATEST(1, FLOOR(SQRT(NEW.xp::FLOAT / 80)) + 1); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS auto_level ON profiles;
CREATE TRIGGER auto_level BEFORE UPDATE OF xp ON profiles FOR EACH ROW EXECUTE FUNCTION sync_level();

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_plan     ON profiles(plan);
CREATE INDEX IF NOT EXISTS idx_profiles_xp       ON profiles(xp DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user     ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session  ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_notif_user        ON notifications(user_id, is_read, created_at DESC);

-- ── VIEWS ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW leaderboard AS
SELECT id, username, avatar_color, avatar_emoji, level, xp, coins, streak, plan,
  games_played, chat_messages, RANK() OVER (ORDER BY xp DESC) AS rank
FROM profiles WHERE role = 'user' ORDER BY xp DESC LIMIT 100;

CREATE OR REPLACE VIEW admin_stats AS
SELECT
  (SELECT COUNT(*) FROM profiles WHERE role='user')                                                           AS total_users,
  (SELECT COUNT(*) FROM profiles WHERE plan='premium')                                                        AS premium_users,
  (SELECT COUNT(*) FROM profiles WHERE plan='vip')                                                            AS vip_users,
  (SELECT COUNT(*) FROM orders)                                                                               AS total_orders,
  (SELECT COUNT(*) FROM orders WHERE status='approved')                                                       AS approved_orders,
  (SELECT COUNT(*) FROM orders WHERE status='pending')                                                        AS pending_orders,
  (SELECT COALESCE(SUM(price),0) FROM orders WHERE status='approved')                                         AS total_revenue,
  (SELECT COUNT(*) FROM chat_messages WHERE role='user')                                                      AS total_chats,
  (SELECT COUNT(*) FROM profiles WHERE created_at > NOW()-INTERVAL '7 days')                                 AS new_users_week,
  (SELECT COUNT(*) FROM orders    WHERE created_at > NOW()-INTERVAL '7 days')                                 AS new_orders_week,
  (SELECT COALESCE(SUM(price),0) FROM orders WHERE status='approved' AND created_at > NOW()-INTERVAL '30 days') AS revenue_month;

-- ── DEFAULT DATA ──────────────────────────────────────────────
INSERT INTO site_settings (key, value) VALUES
  ('maintenance_mode',  '"false"'),
  ('registration_open', '"true"'),
  ('midtrans_active',   '"true"')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- SELESAI! Langkah selanjutnya:
-- 1. Supabase Dashboard → Settings → API
-- 2. Copy "Project URL" → SUPABASE_URL
-- 3. Copy "service_role" secret → SUPABASE_SERVICE_KEY
-- 4. Set di Vercel Environment Variables
-- ============================================================
