'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors, rateLimit } = require('../lib/supabase');

const loginAttempts = new Map();

/* ── Body parser ───────────────────────────────────────────────
   Vercel serverless TIDAK otomatis parse req.body.
   Ini yang bikin "Respons tidak valid" — req.body = undefined
   → semua validasi gagal → throw error → return HTML bukan JSON.
   ─────────────────────────────────────────────────────────────── */
function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse body dulu sebelum apapun
  req.body = await parseBody(req);

  let client;
  try { client = sb(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';

  /* ════════════════════════════
     REGISTER
  ════════════════════════════ */
  if (req.method === 'POST' && action === 'register') {
    if (!rateLimit(loginAttempts, 'reg:' + ip, 5, 300000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi dalam 5 menit' });

    const { username, email, password, telegram_id } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'Username, email, dan password wajib diisi' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username 3-20 karakter (huruf, angka, underscore)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    if (!email.includes('@') || !email.includes('.'))
      return res.status(400).json({ error: 'Format email tidak valid' });

    const emailClean    = email.toLowerCase().trim();
    const usernameClean = username.toLowerCase().trim();

    // Cek username unik
    const { data: existingUser } = await client.from('profiles')
      .select('id').eq('username', usernameClean).maybeSingle();
    if (existingUser)
      return res.status(409).json({ error: 'Username sudah dipakai, coba yang lain' });

    // Buat user (admin.createUser → email langsung confirmed, tidak perlu klik link)
    let authUser = null;
    const { data: adminData, error: adminErr } = await client.auth.admin.createUser({
      email:         emailClean,
      password,
      email_confirm: true,
      user_metadata: { username: usernameClean },
    });

    if (!adminErr && adminData?.user) {
      authUser = adminData.user;
    } else {
      // Fallback ke signUp biasa (kalau pakai anon key bukan service_role)
      console.warn('[register] admin.createUser gagal:', adminErr?.message, '— fallback signUp');
      const { data: signupData, error: signupErr } = await client.auth.signUp({
        email:   emailClean,
        password,
        options: { data: { username: usernameClean } },
      });
      if (signupErr) {
        if (signupErr.message.toLowerCase().includes('already'))
          return res.status(409).json({ error: 'Email sudah terdaftar, gunakan email lain' });
        return res.status(400).json({ error: signupErr.message });
      }
      authUser = signupData?.user;
    }

    if (!authUser?.id)
      return res.status(400).json({ error: 'Gagal membuat akun, coba lagi' });

    // Buat profil
    const referralCode = usernameClean.slice(0, 4).toUpperCase()
      + Math.random().toString(36).slice(2, 6).toUpperCase();

    const { error: profileErr } = await client.from('profiles').upsert({
      id:            authUser.id,
      username:      usernameClean,
      telegram_id:   telegram_id || '',
      referral_code: referralCode,
      coins:         50, xp: 0, level: 1, streak: 0,
      preferences:   { email: emailClean, theme: 'dark', language: 'id', notifications: true },
    }, { onConflict: 'id' });

    if (profileErr && !profileErr.message?.includes('duplicate'))
      console.error('[register] Profile upsert error:', profileErr.message);

    // Activity log
    await client.from('activity_log').insert({
      user_id: authUser.id, type: 'register',
      description: 'Bergabung dengan KizAi', icon: '🎉', xp_earned: 0,
    }).catch(() => {});

    // Auto-login
    const { data: session, error: loginErr } = await client.auth.signInWithPassword({
      email: emailClean, password,
    });

    if (loginErr || !session?.session) {
      console.warn('[register] Auto-login gagal:', loginErr?.message);
      return res.status(201).json({ message: 'Akun berhasil dibuat! Silakan login.', needs_login: true });
    }

    const { data: profile } = await client.from('profiles').select('*').eq('id', authUser.id).single();
    const plan = effectivePlan(profile);
    return res.status(201).json({
      access_token: session.session.access_token,
      user: { ...profile, email: emailClean, effective_plan: plan, accessible_models: accessibleModels(plan) },
    });
  }

  /* ════════════════════════════
     LOGIN
  ════════════════════════════ */
  if (req.method === 'POST' && action === 'login') {
    if (!rateLimit(loginAttempts, 'login:' + ip, 10, 60000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan login, tunggu 1 menit' });

    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

    let email = identifier.trim().toLowerCase();

    // Login pakai username → cari email
    if (!email.includes('@')) {
      const { data: p } = await client.from('profiles')
        .select('id, preferences').eq('username', email).maybeSingle();
      if (!p) return res.status(401).json({ error: 'Username tidak ditemukan' });

      if (p.preferences?.email) {
        email = p.preferences.email;
      } else {
        // Fallback ambil dari auth.users
        try {
          const { data: au } = await client.auth.admin.getUserById(p.id);
          if (au?.user?.email) {
            email = au.user.email;
            await client.from('profiles').update({
              preferences: { ...(p.preferences || {}), email: au.user.email }
            }).eq('id', p.id);
          } else {
            return res.status(401).json({ error: 'Akun ditemukan tapi email tidak tersimpan. Coba login pakai email.' });
          }
        } catch {
          return res.status(401).json({ error: 'Gagal mencari akun. Coba login pakai email langsung.' });
        }
      }
    }

    const { data: session, error: loginErr } = await client.auth.signInWithPassword({ email, password });

    if (loginErr) {
      if (loginErr.message.includes('Email not confirmed'))
        return res.status(401).json({ error: 'Email belum dikonfirmasi. Hubungi admin untuk aktivasi.' });
      if (loginErr.message.includes('Invalid login credentials'))
        return res.status(401).json({ error: 'Email/username atau password salah' });
      return res.status(401).json({ error: loginErr.message });
    }
    if (!session?.session)
      return res.status(401).json({ error: 'Gagal membuat sesi, coba lagi' });

    const { data: profile } = await client.from('profiles').select('*').eq('id', session.user.id).single();
    if (!profile) return res.status(404).json({ error: 'Profil tidak ditemukan, hubungi admin' });
    if (profile.is_banned) return res.status(403).json({ error: 'Akun dinonaktifkan. Hubungi support.' });

    // Streak & daily coin
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const lastSeen  = profile.streak_last;
    let newStreak = profile.streak || 0;
    let coinBonus = 0;

    if (lastSeen !== today) {
      coinBonus = 10;
      if (lastSeen === yesterday) {
        newStreak++;
        if (newStreak === 7)  coinBonus += 50;
        if (newStreak === 30) coinBonus += 200;
      } else {
        newStreak = 1;
      }
    }

    const updateData = { last_seen: new Date().toISOString() };
    if (lastSeen !== today) {
      updateData.streak      = newStreak;
      updateData.streak_last = today;
      if (coinBonus > 0) updateData.coins = (profile.coins || 0) + coinBonus;
    }
    await client.from('profiles').update(updateData).eq('id', profile.id).catch(() => {});

    const plan = effectivePlan(profile);
    return res.json({
      access_token: session.session.access_token,
      user: { ...profile, ...updateData, email: session.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) },
    });
  }

  /* ════════════════════════════
     GET PROFILE
  ════════════════════════════ */
  if (req.method === 'GET' && action === 'profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { count } = await client.from('profiles')
      .select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return res.json({ user: { ...user, rank: (count || 0) + 1 } });
  }

  /* ════════════════════════════
     UPDATE PROFILE
  ════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { username, bio, telegram_id } = req.body;
    if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username tidak valid' });
    if (username && username !== user.username) {
      const { data: ex } = await client.from('profiles').select('id').eq('username', username.toLowerCase()).maybeSingle();
      if (ex) return res.status(409).json({ error: 'Username sudah dipakai' });
    }
    const upd = { updated_at: new Date().toISOString() };
    if (username)              upd.username     = username.toLowerCase();
    if (bio !== undefined)     upd.bio          = bio.slice(0, 200);
    if (telegram_id !== undefined) upd.telegram_id = telegram_id;
    const { error } = await client.from('profiles').update(upd).eq('id', user.id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  /* ════════════════════════════
     UPDATE AVATAR
  ════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_avatar') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { avatar_emoji, avatar_color } = req.body;
    await client.from('profiles').update({ avatar_emoji, avatar_color }).eq('id', user.id);
    return res.json({ ok: true });
  }

  /* ════════════════════════════
     CHANGE PASSWORD
  ════════════════════════════ */
  if (req.method === 'POST' && action === 'change_password') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
    const { error: signInErr } = await client.auth.signInWithPassword({ email: user.email, password: current_password });
    if (signInErr) return res.status(400).json({ error: 'Password saat ini salah' });
    const { error } = await client.auth.admin.updateUserById(user.id, { password: new_password });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  /* ════════════════════════════
     NOTIFICATIONS
  ════════════════════════════ */
  if (req.method === 'GET' && action === 'notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('notifications').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(30);
    return res.json({ notifications: data || [] });
  }

  if (req.method === 'POST' && action === 'read_notification') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications').update({ is_read: true }).eq('id', req.body?.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'read_all_notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    return res.json({ ok: true });
  }

  /* ════════════════════════════
     LEADERBOARD
  ════════════════════════════ */
  if (req.method === 'GET' && action === 'leaderboard') {
    const sortMap = { xp:'xp', messages:'chat_messages', tools:'tools_used', games:'games_played', streak:'streak', coins:'coins' };
    const sortCol = sortMap[req.query.sort] || 'xp';
    const limit   = Math.min(parseInt(req.query.limit) || 20, 100);
    const { data } = await client.from('profiles')
      .select('username,avatar_emoji,avatar_color,plan,level,xp,chat_messages,tools_used,games_played,streak,coins')
      .order(sortCol, { ascending: false }).limit(limit);
    return res.json({ leaderboard: (data || []).map((u, i) => ({ ...u, rank: i + 1 })) });
  }

  if (req.method === 'GET' && action === 'my_rank') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { count } = await client.from('profiles')
      .select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return res.json({ rank: (count || 0) + 1, xp: user.xp || 0 });
  }

  /* ════════════════════════════
     ACTIVITY
  ════════════════════════════ */
  if (req.method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('activity_log').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    return res.json({ activity: data || [] });
  }

  /* ════════════════════════════
     UPDATE PREFS
  ════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').update({
      preferences: { ...(user.preferences || {}), ...req.body },
      updated_at:  new Date().toISOString(),
    }).eq('id', user.id);
    return res.json({ ok: true });
  }

  /* ════════════════════════════
     DELETE ACCOUNT
  ════════════════════════════ */
  if (req.method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').delete().eq('id', user.id);
    await client.auth.admin.deleteUser(user.id);
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: 'Action tidak ditemukan: ' + action });
};
