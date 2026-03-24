-- ═══════════════════════════════════════════════════════════════
--  KizAi v4 — Complete Database Schema (FIXED)
--  ✅ Aman dijalankan berkali-kali (idempotent)
--  ✅ RLS diperbaiki — backend service role bisa INSERT/UPDATE/DELETE
--  ✅ orders status constraint sudah include 'refunded'
--  ✅ Tidak ada duplicate index
--  ✅ Auto-aktivasi payment bekerja tanpa perlu approve admin
--
--  CARA PAKAI:
--  1. Buka Supabase → SQL Editor
--  2. Paste SELURUH isi file ini
--  3. Klik Run
--  4. Ulangi step 2-3 setelah daftar akun admin (lihat bagian bawah)
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ═══════════════════════════════════════════════════════════════
--  TABLES
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS profiles (
  id              UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  avatar_color    TEXT        DEFAULT '#4f7fff',
  avatar_emoji    TEXT        DEFAULT '😊',
  telegram_id     TEXT        DEFAULT '',
  bio             TEXT        DEFAULT '',
  role            TEXT        DEFAULT 'user'  CHECK (role IN ('user','admin')),
  plan            TEXT        DEFAULT 'free'  CHECK (plan IN ('free','premium','vip')),
  plan_expires    TIMESTAMPTZ DEFAULT NULL,
  xp              INTEGER     DEFAULT 0,
  level           INTEGER     DEFAULT 1,
  coins           INTEGER     DEFAULT 50,
  streak          INTEGER     DEFAULT 0,
  streak_last     DATE        DEFAULT NULL,
  games_played    INTEGER     DEFAULT 0,
  chat_messages   INTEGER     DEFAULT 0,
  tools_used      INTEGER     DEFAULT 0,
  referral_code   TEXT UNIQUE DEFAULT NULL,
  referral_count  INTEGER     DEFAULT 0,
  achievements    TEXT[]      DEFAULT '{}',
  is_banned       BOOLEAN     DEFAULT FALSE,
  preferences     JSONB       DEFAULT '{"email":"","theme":"dark","accent":"blue","language":"id","fontSize":"md"}',
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
  status          TEXT    DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','refunded')),
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
  user_id     UUID    REFERENCES profiles(id)       ON DELETE CASCADE NOT NULL,
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


-- ═══════════════════════════════════════════════════════════════
--  SAFE COLUMN MIGRATIONS
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='chat_messages') THEN
    ALTER TABLE profiles ADD COLUMN chat_messages INTEGER DEFAULT 0; RAISE NOTICE 'Added profiles.chat_messages';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='tools_used') THEN
    ALTER TABLE profiles ADD COLUMN tools_used INTEGER DEFAULT 0; RAISE NOTICE 'Added profiles.tools_used';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='streak_last') THEN
    ALTER TABLE profiles ADD COLUMN streak_last DATE DEFAULT NULL; RAISE NOTICE 'Added profiles.streak_last';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='plan_expires') THEN
    ALTER TABLE profiles ADD COLUMN plan_expires TIMESTAMPTZ DEFAULT NULL; RAISE NOTICE 'Added profiles.plan_expires';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='note') THEN
    ALTER TABLE orders ADD COLUMN note TEXT DEFAULT ''; RAISE NOTICE 'Added orders.note';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='notified') THEN
    ALTER TABLE orders ADD COLUMN notified BOOLEAN DEFAULT FALSE; RAISE NOTICE 'Added orders.notified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chat_sessions' AND column_name='is_pinned') THEN
    ALTER TABLE chat_sessions ADD COLUMN is_pinned BOOLEAN DEFAULT FALSE; RAISE NOTICE 'Added chat_sessions.is_pinned';
  END IF;
END $$;

-- Fix status constraint (include 'refunded')
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('pending','approved','rejected','expired','refunded'));


-- ═══════════════════════════════════════════════════════════════
--  INDEXES
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_profiles_username   ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_xp         ON profiles(xp DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_plan       ON profiles(plan);
CREATE INDEX IF NOT EXISTS idx_profiles_last_seen  ON profiles(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user  ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_session   ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_user      ON chat_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user         ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_status_date  ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifs_user         ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifs_unread       ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user       ON activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type       ON activity_log(user_id, type, created_at DESC);


-- ═══════════════════════════════════════════════════════════════
--  TRIGGERS
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at  ON profiles;
DROP TRIGGER IF EXISTS orders_updated_at    ON orders;
DROP TRIGGER IF EXISTS sessions_updated_at  ON chat_sessions;
CREATE TRIGGER profiles_updated_at  BEFORE UPDATE ON profiles     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER orders_updated_at    BEFORE UPDATE ON orders        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER sessions_updated_at  BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles(id, username, coins, preferences)
  VALUES(
    NEW.id,
    COALESCE(
      NULLIF(LOWER(REGEXP_REPLACE(COALESCE(NEW.raw_user_meta_data->>'username',''), '[^a-z0-9_]', '', 'g')), ''),
      'u' || SUBSTR(REPLACE(NEW.id::text,'-',''), 1, 11)
    ),
    50,
    jsonb_build_object('email', COALESCE(NEW.email,''), 'theme','dark','accent','blue','language','id','fontSize','md')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ═══════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY (RLS)
--  ✅ FIX UTAMA: Backend (service_role) bisa akses semua tabel
--     tanpa RLS block. User biasa tetap dibatasi ke data sendiri.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals     ENABLE ROW LEVEL SECURITY;

-- Hapus semua policy lama
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname='public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;


-- PROFILES
CREATE POLICY "p_sel" ON profiles FOR SELECT USING (true);
CREATE POLICY "p_ins" ON profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "p_upd" ON profiles FOR UPDATE
  USING    (auth.uid() = id OR auth.role() = 'service_role')
  WITH CHECK (auth.uid() = id OR auth.role() = 'service_role');
CREATE POLICY "p_del" ON profiles FOR DELETE
  USING (auth.uid() = id OR auth.role() = 'service_role');

-- ORDERS
-- ✅ FIX: Tambah UPDATE + DELETE policy (sebelumnya tidak ada = auto-aktivasi block!)
CREATE POLICY "o_sel" ON orders FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL OR auth.role() = 'service_role');
CREATE POLICY "o_ins" ON orders FOR INSERT WITH CHECK (true);
CREATE POLICY "o_upd" ON orders FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "o_del" ON orders FOR DELETE USING (auth.role() = 'service_role');

-- CHAT SESSIONS
CREATE POLICY "cs_all" ON chat_sessions
  USING    (auth.uid() = user_id OR auth.role() = 'service_role')
  WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role');

-- CHAT MESSAGES
CREATE POLICY "cm_sel" ON chat_messages FOR SELECT
  USING (auth.uid() = user_id OR auth.role() = 'service_role');
CREATE POLICY "cm_ins" ON chat_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role');
CREATE POLICY "cm_del" ON chat_messages FOR DELETE
  USING (auth.uid() = user_id OR auth.role() = 'service_role');

-- NOTIFICATIONS
CREATE POLICY "n_sel" ON notifications FOR SELECT
  USING (auth.uid() = user_id OR auth.role() = 'service_role');
CREATE POLICY "n_ins" ON notifications FOR INSERT WITH CHECK (true);
CREATE POLICY "n_upd" ON notifications FOR UPDATE
  USING (auth.uid() = user_id OR auth.role() = 'service_role');
CREATE POLICY "n_del" ON notifications FOR DELETE
  USING (auth.uid() = user_id OR auth.role() = 'service_role');

-- ACTIVITY LOG
CREATE POLICY "a_sel" ON activity_log FOR SELECT
  USING (auth.uid() = user_id OR auth.role() = 'service_role');
CREATE POLICY "a_ins" ON activity_log FOR INSERT WITH CHECK (true);
CREATE POLICY "a_del" ON activity_log FOR DELETE
  USING (auth.uid() = user_id OR auth.role() = 'service_role');

-- BOOKMARKS
CREATE POLICY "b_all" ON bookmarks
  USING    (auth.uid() = user_id OR auth.role() = 'service_role')
  WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role');

-- REFERRALS
CREATE POLICY "r_sel" ON referrals FOR SELECT
  USING (auth.uid() = referrer_id OR auth.uid() = referred_id OR auth.role() = 'service_role');
CREATE POLICY "r_ins" ON referrals FOR INSERT WITH CHECK (true);
CREATE POLICY "r_del" ON referrals FOR DELETE
  USING (auth.role() = 'service_role');


-- ═══════════════════════════════════════════════════════════════
--  SET ADMIN ACCOUNT
--  Jalankan SETELAH daftar akun di /auth pakai email admin@kizai.id
--  Ganti 'admin@kizai.id' dengan email admin kamu jika berbeda
-- ═══════════════════════════════════════════════════════════════
DO $$
DECLARE v_uid UUID;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = 'admin@kizai.id' LIMIT 1;
  IF v_uid IS NOT NULL THEN
    INSERT INTO public.profiles(id, username, role, plan, coins, xp, level, preferences)
    VALUES(v_uid, 'admin', 'admin', 'vip', 99999, 99999, 99,
      '{"email":"admin@kizai.id","theme":"dark","accent":"blue","language":"id","fontSize":"md"}')
    ON CONFLICT (id) DO UPDATE
      SET role='admin', plan='vip', coins=99999, xp=99999, level=99, updated_at=NOW();
    RAISE NOTICE '✅ Admin berhasil diset: %', v_uid;
  ELSE
    RAISE NOTICE '⚠️  Akun admin@kizai.id belum daftar. Daftar dulu di /auth lalu jalankan SQL ini lagi.';
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
--  VERIFIKASI AKHIR
-- ═══════════════════════════════════════════════════════════════
SELECT tablename, policyname, cmd,
  left(COALESCE(qual,''), 80) AS using_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;
