'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors, rateLimit } = require('../lib/supabase');

const loginAttempts = new Map();

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  // BUG FIX #1: req.connection deprecated di Node 18+, pakai req.socket sebagai fallback
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.connection?.remoteAddress
    || 'unknown';

  /* ════════════════════════════════
     REGISTER
     ════════════════════════════════ */
  if (req.method === 'POST' && action === 'register') {
    if (!rateLimit(loginAttempts, 'reg:' + ip, 5, 300000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan, coba lagi dalam 5 menit' });

    const { username, email, password, telegram_id } = req.body || {};
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
    const { data: existingUser } = await client
      .from('profiles').select('id').eq('username', usernameClean).maybeSingle();
    if (existingUser)
      return res.status(409).json({ error: 'Username sudah dipakai, coba yang lain' });

    // BUG FIX #2: Coba admin.createUser dulu (butuh service_role key)
    // Kalau gagal (misal pakai anon key), fallback ke signUp biasa
    // BUG FIX #3: email_confirm: true agar user tidak perlu verifikasi email
    let authUser = null;

    const { data: adminData, error: adminErr } = await client.auth.admin.createUser({
      email:         emailClean,
      password,
      email_confirm: true,    // langsung confirm, tidak perlu klik link
      user_metadata: { username: usernameClean },
    });

    if (!adminErr && adminData?.user) {
      authUser = adminData.user;
    } else {
      // Fallback ke signUp (kalau pakai anon key atau admin gagal)
      console.warn('[register] admin.createUser gagal:', adminErr?.message, '— fallback ke signUp');
      const { data: signupData, error: signupErr } = await client.auth.signUp({
        email:    emailClean,
        password,
        options:  { data: { username: usernameClean } },
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

    // Buat profil user
    const referralCode = usernameClean.slice(0, 4).toUpperCase()
      + Math.random().toString(36).slice(2, 6).toUpperCase();

    const { error: profileErr } = await client.from('profiles').upsert({
      id:           authUser.id,
      username:     usernameClean,
      telegram_id:  telegram_id || '',
      referral_code:referralCode,
      coins:        50,
      xp:           0,
      level:        1,
      streak:       0,
      preferences:  { email: emailClean, theme: 'dark', language: 'id', notifications: true },
    }, { onConflict: 'id' });

    if (profileErr && !profileErr.message?.includes('duplicate'))
      console.error('[register] Profile upsert error:', profileErr.message);

    // Activity log (opsional, tidak gagalkan register)
    await client.from('activity_log').insert({
      user_id:     authUser.id,
      type:        'register',
      description: 'Bergabung dengan KizAi',
      icon:        '🎉',
      xp_earned:   0,
    }).catch(() => {});

    // Auto-login setelah register
    const { data: session, error: loginErr } = await client.auth.signInWithPassword({
      email: emailClean, password,
    });

    if (loginErr || !session?.session) {
      // BUG FIX #4: Kalau auto-login gagal (misalnya email masih unconfirmed di Supabase),
      // jangan return 201 dengan message saja — tetap kasih tahu user agar login manual
      console.warn('[register] Auto-login gagal:', loginErr?.message);
      return res.status(201).json({
        message: 'Akun berhasil dibuat! Silakan login.',
        // BUG FIX #5: Kirim flag agar frontend tahu harus redirect ke login, bukan dashboard
        needs_login: true,
      });
    }

    const { data: profile } = await client.from('profiles').select('*').eq('id', authUser.id).single();
    const plan = effectivePlan(profile);

    return res.status(201).json({
      access_token: session.session.access_token,
      user: {
        ...profile,
        email:              emailClean,
        effective_plan:     plan,
        accessible_models:  accessibleModels(plan),
      },
    });
  }

  /* ════════════════════════════════
     LOGIN
     ════════════════════════════════ */
  if (req.method === 'POST' && action === 'login') {
    if (!rateLimit(loginAttempts, 'login:' + ip, 10, 60000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan login, tunggu 1 menit' });

    const { identifier, password } = req.body || {};
    if (!identifier || !password)
      return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

    let email = identifier.trim().toLowerCase();

    // Login pakai username → cari email-nya dulu
    if (!email.includes('@')) {
      // BUG FIX #6: Lookup email dari profiles, fallback ke auth.users kalau tidak ada di preferences
      const { data: p } = await client
        .from('profiles')
        .select('id, preferences')
        .eq('username', email)
        .maybeSingle();

      if (!p) return res.status(401).json({ error: 'Username tidak ditemukan' });

      // Ambil email dari preferences
      const emailFromPrefs = p.preferences?.email;
      if (emailFromPrefs) {
        email = emailFromPrefs;
      } else {
        // Fallback: ambil dari auth.users berdasarkan user_id
        try {
          const { data: authUserData } = await client.auth.admin.getUserById(p.id);
          if (authUserData?.user?.email) {
            email = authUserData.user.email;
            // Simpan ke preferences agar ke depannya langsung ketemu
            await client.from('profiles').update({
              preferences: { ...(p.preferences || {}), email: authUserData.user.email }
            }).eq('id', p.id);
          } else {
            return res.status(401).json({ error: 'Username tidak ditemukan atau email belum tersimpan' });
          }
        } catch (e) {
          return res.status(401).json({ error: 'Gagal mencari akun, coba gunakan email untuk login' });
        }
      }
    }

    const { data: session, error: loginErr } = await client.auth.signInWithPassword({ email, password });

    if (loginErr) {
      // Pesan error yang lebih informatif
      if (loginErr.message.includes('Email not confirmed'))
        return res.status(401).json({ error: 'Email belum dikonfirmasi. Cek inbox email kamu atau hubungi admin.' });
      if (loginErr.message.includes('Invalid login credentials'))
        return res.status(401).json({ error: 'Email/username atau password salah' });
      return res.status(401).json({ error: loginErr.message });
    }

    if (!session?.session)
      return res.status(401).json({ error: 'Gagal membuat sesi login, coba lagi' });

    const { data: profile } = await client.from('profiles').select('*').eq('id', session.user.id).single();
    if (!profile)
      return res.status(404).json({ error: 'Profil tidak ditemukan, hubungi admin' });
    if (profile.is_banned)
      return res.status(403).json({ error: 'Akun ini telah dinonaktifkan. Hubungi support.' });

    // Update streak & last_seen
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const lastSeen  = profile.streak_last;

    let newStreak = profile.streak || 0;
    let coinBonus = 0;

    if (lastSeen !== today) {
      coinBonus = 10; // bonus login harian
      if (lastSeen === yesterday) {
        newStreak++;
        if (newStreak === 7)  coinBonus += 50;
        if (newStreak === 30) coinBonus += 200;
      } else {
        newStreak = 1; // streak putus
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
      user: {
        ...profile,
        ...updateData,
        email:             session.user.email,
        effective_plan:    plan,
        accessible_models: accessibleModels(plan),
      },
    });
  }

  /* ════════════════════════════════
     GET PROFILE
     ════════════════════════════════ */
  if (req.method === 'GET' && action === 'profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { count } = await client.from('profiles')
      .select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return res.json({ user: { ...user, rank: (count || 0) + 1 } });
  }

  /* ════════════════════════════════
     UPDATE PROFILE
     ════════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { username, bio, telegram_id } = req.body || {};
    if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username tidak valid' });
    if (username && username !== user.username) {
      const { data: ex } = await client.from('profiles').select('id').eq('username', username.toLowerCase()).maybeSingle();
      if (ex) return res.status(409).json({ error: 'Username sudah dipakai' });
    }
    const updates = { updated_at: new Date().toISOString() };
    if (username)              updates.username     = username.toLowerCase();
    if (bio !== undefined)     updates.bio          = bio.slice(0, 200);
    if (telegram_id !== undefined) updates.telegram_id = telegram_id;
    const { error } = await client.from('profiles').update(updates).eq('id', user.id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  /* ════════════════════════════════
     UPDATE AVATAR
     ════════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_avatar') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { avatar_emoji, avatar_color } = req.body || {};
    await client.from('profiles').update({ avatar_emoji, avatar_color }).eq('id', user.id);
    return res.json({ ok: true });
  }

  /* ════════════════════════════════
     CHANGE PASSWORD
     ════════════════════════════════ */
  if (req.method === 'POST' && action === 'change_password') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password)
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (new_password.length < 6)
      return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
    const { error: signInErr } = await client.auth.signInWithPassword({ email: user.email, password: current_password });
    if (signInErr)
      return res.status(400).json({ error: 'Password saat ini salah' });
    const { error } = await client.auth.admin.updateUserById(user.id, { password: new_password });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  /* ════════════════════════════════
     NOTIFICATIONS
     ════════════════════════════════ */
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
    const { id } = req.body || {};
    await client.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'read_all_notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    return res.json({ ok: true });
  }

  /* ════════════════════════════════
     LEADERBOARD
     ════════════════════════════════ */
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

  /* ════════════════════════════════
     ACTIVITY
     ════════════════════════════════ */
  if (req.method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('activity_log').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    return res.json({ activity: data || [] });
  }

  /* ════════════════════════════════
     UPDATE PREFS
     ════════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const current = user.preferences || {};
    await client.from('profiles').update({
      preferences: { ...current, ...req.body },
      updated_at:  new Date().toISOString(),
    }).eq('id', user.id);
    return res.json({ ok: true });
  }

  /* ════════════════════════════════
     DELETE ACCOUNT
     ════════════════════════════════ */
  if (req.method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').delete().eq('id', user.id);
    await client.auth.admin.deleteUser(user.id);
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: 'Action tidak ditemukan: ' + action });
};
