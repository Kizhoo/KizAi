-- KizAi v4 — Complete Database Schema
-- Run in Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── PROFILES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  avatar_color    TEXT DEFAULT '#4f7fff',
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
  referral_count  INTEGER DEFAULT 0,
  achievements    TEXT[] DEFAULT '{}',
  is_banned       BOOLEAN DEFAULT FALSE,
  preferences     JSONB DEFAULT '{"theme":"dark","accent":"blue","language":"id","email":"","notifications":{"browser":false,"email":true,"telegram":true,"streak":true,"promo":true},"privacy":{"leaderboard":true,"stats":true,"level":true}}',
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── ORDERS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id          TEXT UNIQUE NOT NULL,
  user_id           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  telegram_id       TEXT DEFAULT '',
  customer_name     TEXT DEFAULT '',
  email             TEXT DEFAULT '',
  plan              TEXT NOT NULL CHECK (plan IN ('premium','vip')),
  duration          INTEGER NOT NULL,
  -- CORRECT PRICES: premium (29000/69000) < vip (59000/139000)
  price             INTEGER NOT NULL DEFAULT 0,
  payment_method    TEXT DEFAULT 'qris',
  coupon            TEXT DEFAULT NULL,
  discount          INTEGER DEFAULT 0,
  status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  snap_token        TEXT DEFAULT NULL,
  snap_redirect_url TEXT DEFAULT NULL,
  payment_data      JSONB DEFAULT '{}',
  note              TEXT DEFAULT '',
  activated_at      TIMESTAMPTZ DEFAULT NULL,
  expires_at        TIMESTAMPTZ DEFAULT NULL,
  notified          BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHAT SESSIONS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id       UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title         TEXT DEFAULT 'Chat Baru',
  model_id      TEXT DEFAULT 'llama-8b',
  is_pinned     BOOLEAN DEFAULT FALSE,
  message_count INTEGER DEFAULT 0,
  last_message  TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHAT MESSAGES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_id  UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content     TEXT NOT NULL,
  model_id    TEXT DEFAULT NULL,
  tokens_used INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── NOTIFICATIONS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type       TEXT DEFAULT 'info' CHECK (type IN ('info','success','warning','achievement','system')),
  title      TEXT NOT NULL,
  message    TEXT DEFAULT '',
  icon       TEXT DEFAULT '🔔',
  is_read    BOOLEAN DEFAULT FALSE,
  action_url TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ACTIVITY LOG ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type        TEXT DEFAULT 'general',
  description TEXT NOT NULL,
  icon        TEXT DEFAULT '⚡',
  xp_earned   INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── BOOKMARKS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmarks (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id    UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type       TEXT DEFAULT 'tool',
  item_id    TEXT NOT NULL,
  item_name  TEXT DEFAULT '',
  item_emoji TEXT DEFAULT '⭐',
  note       TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, type, item_id)
);

-- ── REFERRALS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  referrer_id  UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  referred_id  UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  coins_given  INTEGER DEFAULT 100,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id)
);

-- ── INDEXES ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_xp ON profiles(xp DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_plan ON profiles(plan);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at DESC);

-- ── AUTO-UPDATE TIMESTAMP ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── AUTO-CREATE PROFILE ON SIGNUP ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE v_username TEXT;
BEGIN
  v_username := COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1));
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.id) THEN
    INSERT INTO profiles (id, username, preferences)
    VALUES (NEW.id, v_username, jsonb_build_object('email', NEW.email, 'theme', 'dark', 'language', 'id'))
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;

-- Policies (service role bypasses these, used for direct client queries)
CREATE POLICY "profiles_read_own" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "profiles_read_public" ON profiles FOR SELECT USING (true); -- leaderboard

CREATE POLICY "sessions_own" ON chat_sessions USING (auth.uid() = user_id);
CREATE POLICY "messages_own" ON chat_messages USING (auth.uid() = user_id);
CREATE POLICY "notifs_own" ON notifications USING (auth.uid() = user_id);
CREATE POLICY "activity_own" ON activity_log USING (auth.uid() = user_id);
CREATE POLICY "bookmarks_own" ON bookmarks USING (auth.uid() = user_id);

-- Orders are accessible by service role only (no direct client access)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_own" ON orders FOR SELECT USING (auth.uid() = user_id);
