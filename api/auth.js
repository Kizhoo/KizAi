'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors, rateLimit } = require('../lib/supabase');

const loginAttempts = new Map();

/* ═══════════════════════════════════════════════════════════════
   BODY PARSER
   @vercel/node dengan builds format SUDAH auto-parse JSON body.
   Fungsi ini handle edge case kalau belum di-parse.
   ═══════════════════════════════════════════════════════════════ */
async function parseBody(req) {
  // Vercel sudah parse → langsung pakai
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    return {};
  }
  // Fallback: baca stream manual
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
    setTimeout(() => resolve({}), 5000);
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  req.body = await parseBody(req);

  let client;
  try { client = sb(); }
  catch (e) {
    return res.status(500).json({ error: 'Konfigurasi server bermasalah. ' + e.message });
  }

  const action = req.query.action || '';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';

  /* ════════════════════════════════════════
     REGISTER
     ════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'register') {
    if (!rateLimit(loginAttempts, 'reg:' + ip, 5, 300000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi dalam 5 menit.' });

    const { username = '', email = '', password = '', telegram_id = '' } = req.body;

    // Validasi input
    if (!username.trim() || !email.trim() || !password)
      return res.status(400).json({ error: 'Username, email, dan password wajib diisi' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username.trim()))
      return res.status(400).json({ error: 'Username harus 3-20 karakter (huruf, angka, underscore saja)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    if (!email.includes('@') || !email.includes('.'))
      return res.status(400).json({ error: 'Format email tidak valid' });

    const emailClean    = email.toLowerCase().trim();
    const usernameClean = username.toLowerCase().trim();

    // Cek username belum dipakai
    const { data: existingUsername } = await client
      .from('profiles').select('id').eq('username', usernameClean).maybeSingle();
    if (existingUsername)
      return res.status(409).json({ error: 'Username sudah dipakai, pilih yang lain' });

    // Buat user di Supabase Auth
    let authUser = null;
    let authError = null;

    // Coba admin.createUser dulu (butuh service_role, email langsung confirmed)
    const { data: adminData, error: adminErr } = await client.auth.admin.createUser({
      email:         emailClean,
      password,
      email_confirm: true,  // skip verifikasi email
      user_metadata: { username: usernameClean },
    });

    if (!adminErr && adminData?.user) {
      authUser = adminData.user;
    } else {
      // Fallback: signUp biasa (user mungkin perlu verify email)
      console.warn('[register] admin.createUser gagal:', adminErr?.message, '— fallback signUp');
      const { data: signupData, error: signupErr } = await client.auth.signUp({
        email:    emailClean,
        password,
        options:  { data: { username: usernameClean } },
      });
      if (signupErr) {
        if (signupErr.message.toLowerCase().includes('already registered') ||
            signupErr.message.toLowerCase().includes('already exists'))
          return res.status(409).json({ error: 'Email sudah terdaftar. Gunakan email lain atau login.' });
        return res.status(400).json({ error: signupErr.message });
      }
      authUser = signupData?.user;
      authError = !authUser?.id ? 'User tidak terbentuk' : null;
    }

    if (!authUser?.id)
      return res.status(400).json({ error: authError || 'Gagal membuat akun. Coba lagi.' });

    // Buat profile (trigger handle_new_user sudah jalan, tapi upsert sebagai safety net)
    const referralCode = usernameClean.slice(0, 4).toUpperCase()
      + Math.random().toString(36).slice(2, 6).toUpperCase();

    const { error: profileErr } = await client.from('profiles').upsert({
      id:            authUser.id,
      username:      usernameClean,
      telegram_id:   telegram_id.trim() || '',
      referral_code: referralCode,
      coins:         50,
      xp:            0,
      level:         1,
      streak:        0,
      preferences:   {
        email:         emailClean,
        theme:        'dark',
        accent:       'blue',
        language:     'id',
        fontSize:     'md',
        notifications: { browser: false, email: true, telegram: true, streak: true, promo: true },
      },
    }, { onConflict: 'id' });

    if (profileErr) {
      console.error('[register] profile upsert error:', profileErr.message);
      // Jangan gagalkan — user sudah dibuat di Auth, profile akan coba dibuat lewat trigger
    }

    // Activity log
    await client.from('activity_log').insert({
      user_id: authUser.id, type: 'register',
      description: 'Bergabung dengan KizAi', icon: '🎉', xp_earned: 0,
    }).catch(() => {});

    // Auto-login langsung setelah daftar
    const { data: session, error: loginErr } = await client.auth.signInWithPassword({
      email: emailClean, password,
    });

    if (loginErr || !session?.session) {
      // Auto-login gagal (misal email masih unconfirmed di Supabase)
      console.warn('[register] auto-login gagal:', loginErr?.message);
      return res.status(201).json({
        needs_login: true,
        message:     'Akun berhasil dibuat! Silakan login.',
      });
    }

    const { data: profile } = await client.from('profiles').select('*').eq('id', authUser.id).single();
    const plan = effectivePlan(profile);

    return res.status(201).json({
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
      user: {
        ...profile,
        email:             emailClean,
        effective_plan:    plan,
        accessible_models: accessibleModels(plan),
      },
    });
  }

  /* ════════════════════════════════════════
     LOGIN
     ════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'login') {
    if (!rateLimit(loginAttempts, 'login:' + ip, 10, 60000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan login. Tunggu 1 menit.' });

    const { identifier = '', password = '' } = req.body;
    if (!identifier.trim() || !password)
      return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

    let email = identifier.trim().toLowerCase();

    // Login dengan username → cari email
    if (!email.includes('@')) {
      const { data: p } = await client.from('profiles')
        .select('id, preferences').eq('username', email).maybeSingle();

      if (!p)
        return res.status(401).json({ error: 'Username tidak ditemukan' });

      // Coba ambil email dari preferences
      if (p.preferences?.email) {
        email = p.preferences.email;
      } else {
        // Fallback: ambil dari auth.users via admin API
        try {
          const { data: au } = await client.auth.admin.getUserById(p.id);
          if (au?.user?.email) {
            email = au.user.email;
            // Simpan ke preferences agar ke depannya cepat
            await client.from('profiles').update({
              preferences: { ...(p.preferences || {}), email: au.user.email }
            }).eq('id', p.id).catch(() => {});
          } else {
            return res.status(401).json({ error: 'Akun ditemukan tapi email tidak tersimpan. Coba login dengan email.' });
          }
        } catch {
          return res.status(401).json({ error: 'Gagal memverifikasi akun. Coba login dengan email langsung.' });
        }
      }
    }

    const { data: session, error: loginErr } = await client.auth.signInWithPassword({ email, password });

    if (loginErr) {
      if (loginErr.message.includes('Email not confirmed'))
        return res.status(401).json({ error: 'Email belum dikonfirmasi. Hubungi admin untuk aktivasi.' });
      if (loginErr.message.includes('Invalid login credentials') || loginErr.message.includes('invalid_credentials'))
        return res.status(401).json({ error: 'Email/username atau password salah' });
      return res.status(401).json({ error: loginErr.message });
    }

    if (!session?.session)
      return res.status(401).json({ error: 'Gagal membuat sesi. Coba lagi.' });

    const { data: profile } = await client.from('profiles')
      .select('*').eq('id', session.user.id).single();

    if (!profile)
      return res.status(404).json({ error: 'Profil tidak ditemukan. Hubungi admin.' });
    if (profile.is_banned)
      return res.status(403).json({ error: 'Akun ini telah dinonaktifkan. Hubungi support.' });

    // Update streak & daily coin bonus
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const lastSeen  = profile.streak_last;
    let newStreak   = profile.streak || 0;
    let coinBonus   = 0;

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

    const updateData = { last_seen: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (lastSeen !== today) {
      updateData.streak      = newStreak;
      updateData.streak_last = today;
      if (coinBonus > 0) updateData.coins = (profile.coins || 0) + coinBonus;
    }

    await client.from('profiles').update(updateData).eq('id', profile.id).catch(() => {});

    const plan = effectivePlan(profile);
    return res.json({
      access_token:  session.session.access_token,
      refresh_token: session.session.refresh_token,
      user: {
        ...profile,
        ...updateData,
        email:             session.user.email,
        effective_plan:    plan,
        accessible_models: accessibleModels(plan),
      },
    });
  }

  /* ════════════════════════════════════════
     GET PROFILE
     ════════════════════════════════════════ */
  if (req.method === 'GET' && action === 'profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
    const { count } = await client.from('profiles')
      .select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return res.json({ user: { ...user, rank: (count || 0) + 1 } });
  }

  /* ════════════════════════════════════════
     UPDATE PROFILE
     ════════════════════════════════════════ */
  if (req.method === 'PUT' && action === 'update_profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { username, bio, telegram_id } = req.body;
    if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username tidak valid' });
    if (username && username.toLowerCase() !== user.username) {
      const { data: ex } = await client.from('profiles')
        .select('id').eq('username', username.toLowerCase()).maybeSingle();
      if (ex) return res.status(409).json({ error: 'Username sudah dipakai' });
    }
    const upd = { updated_at: new Date().toISOString() };
    if (username)              upd.username    = username.toLowerCase().trim();
    if (bio !== undefined)     upd.bio         = bio.slice(0, 200);
    if (telegram_id !== undefined) upd.telegram_id = telegram_id.trim();
    const { error } = await client.from('profiles').update(upd).eq('id', user.id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  /* UPDATE AVATAR */
  if (req.method === 'PUT' && action === 'update_avatar') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { avatar_emoji, avatar_color } = req.body;
    await client.from('profiles').update({ avatar_emoji, avatar_color }).eq('id', user.id);
    return res.json({ ok: true });
  }

  /* CHANGE PASSWORD */
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

  /* NOTIFICATIONS */
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
    await client.from('notifications')
      .update({ is_read: true }).eq('id', req.body?.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'read_all_notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications')
      .update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    return res.json({ ok: true });
  }

  /* LEADERBOARD */
  if (req.method === 'GET' && action === 'leaderboard') {
    const sortMap = {
      xp: 'xp', messages: 'chat_messages', tools: 'tools_used',
      games: 'games_played', streak: 'streak', coins: 'coins'
    };
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

  /* ACTIVITY */
  if (req.method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('activity_log').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    return res.json({ activity: data || [] });
  }

  /* UPDATE PREFS */
  if (req.method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').update({
      preferences: { ...(user.preferences || {}), ...req.body },
      updated_at:  new Date().toISOString(),
    }).eq('id', user.id);
    return res.json({ ok: true });
  }

  /* DELETE ACCOUNT */
  if (req.method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').delete().eq('id', user.id).catch(() => {});
    await client.auth.admin.deleteUser(user.id).catch(() => {});
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
};
