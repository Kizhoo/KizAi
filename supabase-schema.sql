-- ═══════════════════════════════════════════════════════════════
--  KizAi v4 — Database Schema + Admin Account
--  Jalankan di Supabase SQL Editor → Run All
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── PROFILES ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  avatar_color    TEXT    DEFAULT '#4f7fff',
  avatar_emoji    TEXT    DEFAULT '😊',
  telegram_id     TEXT    DEFAULT '',
  bio             TEXT    DEFAULT '',
  role            TEXT    DEFAULT 'user' CHECK (role IN ('user','admin')),
  plan            TEXT    DEFAULT 'free' CHECK (plan IN ('free','premium','vip')),
  plan_expires    TIMESTAMPTZ DEFAULT NULL,
  xp              INTEGER DEFAULT 0,
  level           INTEGER DEFAULT 1,
  coins           INTEGER DEFAULT 50,
  streak          INTEGER DEFAULT 0,
  streak_last     DATE    DEFAULT NULL,
  games_played    INTEGER DEFAULT 0,
  chat_messages   INTEGER DEFAULT 0,
  tools_used      INTEGER DEFAULT 0,
  referral_code   TEXT    UNIQUE DEFAULT NULL,
  referral_count  INTEGER DEFAULT 0,
  achievements    TEXT[]  DEFAULT '{}',
  is_banned       BOOLEAN DEFAULT FALSE,
  preferences     JSONB   DEFAULT '{"email":"","theme":"dark","accent":"blue","language":"id","fontSize":"md"}',
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_id        TEXT    UNIQUE NOT NULL,
  user_id         UUID    REFERENCES profiles(id) ON DELETE SET NULL,
  telegram_id     TEXT    DEFAULT '',
  customer_name   TEXT    DEFAULT '',
  email           TEXT    DEFAULT '',
  plan            TEXT    NOT NULL CHECK (plan IN ('premium','vip')),
  duration        INTEGER NOT NULL,
  price           INTEGER NOT NULL DEFAULT 0,
  payment_method  TEXT    DEFAULT 'qris',
  coupon          TEXT    DEFAULT NULL,
  discount        INTEGER DEFAULT 0,
  status          TEXT    DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  payment_data    JSONB   DEFAULT '{}',
  note            TEXT    DEFAULT '',
  activated_at    TIMESTAMPTZ DEFAULT NULL,
  expires_at      TIMESTAMPTZ DEFAULT NULL,
  notified        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id            UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id       UUID    REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  title         TEXT    DEFAULT 'Chat Baru',
  model_id      TEXT    DEFAULT 'llama-8b',
  is_pinned     BOOLEAN DEFAULT FALSE,
  message_count INTEGER DEFAULT 0,
  last_message  TEXT    DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_id  UUID    REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  user_id     UUID    REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user','assistant','system')),
  content     TEXT    NOT NULL,
  model_id    TEXT    DEFAULT NULL,
  tokens_used INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id    UUID    REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type       TEXT    DEFAULT 'info' CHECK (type IN ('info','success','warning','achievement','system')),
  title      TEXT    NOT NULL,
  message    TEXT    DEFAULT '',
  icon       TEXT    DEFAULT '🔔',
  is_read    BOOLEAN DEFAULT FALSE,
  action_url TEXT    DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID    REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  type        TEXT    DEFAULT 'general',
  description TEXT    NOT NULL,
  icon        TEXT    DEFAULT '⚡',
  xp_earned   INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS referrals (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  referrer_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  referred_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  coins_given INTEGER DEFAULT 100,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id)
);

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_username  ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_xp        ON profiles(xp DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_plan      ON profiles(plan);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_session  ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_orders_user        ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_notifs_user        ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity_log(user_id, created_at DESC);

-- ── AUTO-UPDATE TIMESTAMP ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS sessions_updated_at ON chat_sessions;
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── AUTO-CREATE PROFILE ON SIGNUP ────────────────────────────
-- Trigger ini membuat profile otomatis saat user baru daftar
-- Dengan penanganan konflik username yang robust
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_username TEXT;
  v_base     TEXT;
  v_counter  INTEGER := 0;
BEGIN
  v_base := LOWER(COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'username'), ''),
    SPLIT_PART(NEW.email, '@', 1)
  ));
  v_base := REGEXP_REPLACE(v_base, '[^a-z0-9_]', '', 'g');
  IF LENGTH(v_base) < 3 THEN v_base := 'user' || SUBSTR(REPLACE(NEW.id::text,'-',''),1,6); END IF;
  v_base     := SUBSTR(v_base, 1, 15);
  v_username := v_base;

  WHILE EXISTS(SELECT 1 FROM profiles WHERE username = v_username) AND v_counter < 99 LOOP
    v_counter  := v_counter + 1;
    v_username := v_base || v_counter;
  END LOOP;

  INSERT INTO profiles(id, username, preferences)
  VALUES(
    NEW.id, v_username,
    jsonb_build_object('email', NEW.email, 'theme','dark','accent','blue','language','id','fontSize','md')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_user error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals     ENABLE ROW LEVEL SECURITY;

-- Drop old policies
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname='public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- New clean policies
CREATE POLICY "profiles_all"     ON profiles      USING (true) WITH CHECK (auth.uid() = id);
CREATE POLICY "orders_own"       ON orders        USING (auth.uid() = user_id);
CREATE POLICY "sessions_own"     ON chat_sessions USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "messages_own"     ON chat_messages USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "notifs_own"       ON notifications  USING (auth.uid() = user_id);
CREATE POLICY "activity_own"     ON activity_log  USING (auth.uid() = user_id);
CREATE POLICY "bookmarks_own"    ON bookmarks     USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "referrals_own"    ON referrals     USING (auth.uid() = referrer_id OR auth.uid() = referred_id);

-- ═══════════════════════════════════════════════════════════════
--  ADMIN ACCOUNT
--  Username : admin
--  Password : KizAi@Admin2025!
--  Email    : admin@kizai.id
--
--  Cara buat admin account:
--  1. Jalankan SQL di bawah ini SETELAH schema di atas
--  2. Atau daftar manual di /auth lalu jalankan:
--     UPDATE profiles SET role='admin' WHERE username='namauser';
-- ═══════════════════════════════════════════════════════════════

-- Buat admin user via Supabase Auth
DO $$
DECLARE
  admin_uid UUID;
BEGIN
  -- Cek apakah admin sudah ada
  SELECT id INTO admin_uid FROM auth.users WHERE email = 'admin@kizai.id';

  IF admin_uid IS NULL THEN
    -- Buat user baru
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin, role
    ) VALUES (
      gen_random_uuid(),
      '00000000-0000-0000-0000-000000000000',
      'admin@kizai.id',
      crypt('KizAi@Admin2025!', gen_salt('bf')),
      NOW(), NOW(), NOW(),
      '{"provider":"email","providers":["email"]}',
      '{"username":"admin"}',
      false, 'authenticated'
    )
    RETURNING id INTO admin_uid;

    RAISE NOTICE 'Admin user created with id: %', admin_uid;
  ELSE
    RAISE NOTICE 'Admin user already exists with id: %', admin_uid;
  END IF;

  -- Buat/update profile admin
  INSERT INTO profiles (id, username, role, plan, coins, xp, level, preferences)
  VALUES (
    admin_uid, 'admin', 'admin', 'vip', 99999, 99999, 99,
    '{"email":"admin@kizai.id","theme":"dark","accent":"blue","language":"id","fontSize":"md"}'
  )
  ON CONFLICT (id) DO UPDATE SET
    role = 'admin',
    plan = 'vip',
    coins = 99999,
    xp = 99999,
    level = 99,
    updated_at = NOW();

  RAISE NOTICE 'Admin profile ready.';
END $$;
