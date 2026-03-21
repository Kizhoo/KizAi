'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, ok, err, preflight, parseEvent, rateLimit } = require('./utils/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  let client;
  try { client = sb(); }
  catch (e) { return err('Konfigurasi server bermasalah: ' + e.message, 500); }

  const { method, query, body, headers, ip } = parseEvent(event);
  const action = query.action || '';

  /* ── REGISTER ── */
  if (method === 'POST' && action === 'register') {
    if (!rateLimit('reg:' + ip, 5, 300000))
      return err('Terlalu banyak percobaan. Coba lagi dalam 5 menit.', 429);

    const { username = '', email = '', password = '', telegram_id = '' } = body;
    if (!username.trim() || !email.trim() || !password) return err('Username, email, dan password wajib diisi');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username.trim())) return err('Username 3-20 karakter (huruf, angka, underscore)');
    if (password.length < 6) return err('Password minimal 6 karakter');
    if (!email.includes('@') || !email.includes('.')) return err('Format email tidak valid');

    const emailClean = email.toLowerCase().trim();
    const uname      = username.toLowerCase().trim();

    const { data: existing } = await client.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (existing) return err('Username sudah dipakai, pilih yang lain', 409);

    let authUser = null;
    const { data: adminData, error: adminErr } = await client.auth.admin.createUser({
      email: emailClean, password, email_confirm: true,
      user_metadata: { username: uname },
    });
    if (!adminErr && adminData?.user) {
      authUser = adminData.user;
    } else {
      const { data: sd, error: se } = await client.auth.signUp({ email: emailClean, password, options: { data: { username: uname } } });
      if (se) {
        if (se.message.toLowerCase().includes('already')) return err('Email sudah terdaftar. Silakan login.', 409);
        return err(se.message);
      }
      authUser = sd?.user;
    }
    if (!authUser?.id) return err('Gagal membuat akun. Coba lagi.');

    const refCode = uname.slice(0, 4).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
    await client.from('profiles').upsert({
      id: authUser.id, username: uname, telegram_id: telegram_id.trim() || '',
      referral_code: refCode, coins: 50, xp: 0, level: 1, streak: 0,
      preferences: { email: emailClean, theme: 'dark', accent: 'blue', language: 'id', fontSize: 'md' },
    }, { onConflict: 'id' }).catch(() => {});

    await client.from('activity_log').insert({ user_id: authUser.id, type: 'register', description: 'Bergabung KizAi', icon: '🎉', xp_earned: 0 }).catch(() => {});

    const { data: session, error: le } = await client.auth.signInWithPassword({ email: emailClean, password });
    if (le || !session?.session) return ok({ needs_login: true, message: 'Akun dibuat! Silakan login.' }, 201);

    const { data: profile } = await client.from('profiles').select('*').eq('id', authUser.id).single();
    const plan = effectivePlan(profile);
    return ok({ access_token: session.session.access_token, user: { ...profile, email: emailClean, effective_plan: plan, accessible_models: accessibleModels(plan) } }, 201);
  }

  /* ── LOGIN ── */
  if (method === 'POST' && action === 'login') {
    if (!rateLimit('login:' + ip, 10, 60000))
      return err('Terlalu banyak percobaan. Tunggu 1 menit.', 429);

    const { identifier = '', password = '' } = body;
    if (!identifier.trim() || !password) return err('Email/username dan password wajib diisi');

    let email = identifier.trim().toLowerCase();
    if (!email.includes('@')) {
      const { data: p } = await client.from('profiles').select('id,preferences').eq('username', email).maybeSingle();
      if (!p) return err('Username tidak ditemukan', 401);
      if (p.preferences?.email) {
        email = p.preferences.email;
      } else {
        try {
          const { data: au } = await client.auth.admin.getUserById(p.id);
          if (au?.user?.email) { email = au.user.email; }
          else return err('Akun ditemukan tapi email tidak tersimpan. Login dengan email.', 401);
        } catch { return err('Gagal verifikasi akun. Login dengan email.', 401); }
      }
    }

    const { data: session, error: le } = await client.auth.signInWithPassword({ email, password });
    if (le) {
      if (le.message.includes('Email not confirmed')) return err('Email belum dikonfirmasi. Hubungi admin.', 401);
      return err('Email/username atau password salah', 401);
    }
    if (!session?.session) return err('Gagal membuat sesi. Coba lagi.', 401);

    const { data: profile } = await client.from('profiles').select('*').eq('id', session.user.id).single();
    if (!profile) return err('Profil tidak ditemukan.', 404);
    if (profile.is_banned) return err('Akun dinonaktifkan. Hubungi support.', 403);

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    let newStreak = profile.streak || 0;
    let coinBonus = 0;
    if (profile.streak_last !== today) {
      coinBonus = 10;
      if (profile.streak_last === yesterday) { newStreak++; if (newStreak === 7) coinBonus += 50; if (newStreak === 30) coinBonus += 200; }
      else newStreak = 1;
    }
    const upd = { last_seen: new Date().toISOString() };
    if (profile.streak_last !== today) {
      upd.streak = newStreak; upd.streak_last = today;
      if (coinBonus > 0) upd.coins = (profile.coins || 0) + coinBonus;
    }
    await client.from('profiles').update(upd).eq('id', profile.id).catch(() => {});

    const plan = effectivePlan(profile);
    return ok({ access_token: session.session.access_token, user: { ...profile, ...upd, email: session.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) } });
  }

  /* ── GET PROFILE ── */
  if (method === 'GET' && action === 'profile') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    const { count } = await client.from('profiles').select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return ok({ user: { ...user, rank: (count || 0) + 1 } });
  }

  /* ── UPDATE PROFILE ── */
  if (method === 'PUT' && action === 'update_profile') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    const { username, bio, telegram_id } = body;
    if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return err('Username tidak valid');
    if (username && username.toLowerCase() !== user.username) {
      const { data: ex } = await client.from('profiles').select('id').eq('username', username.toLowerCase()).maybeSingle();
      if (ex) return err('Username sudah dipakai', 409);
    }
    const upd = { updated_at: new Date().toISOString() };
    if (username) upd.username = username.toLowerCase().trim();
    if (bio !== undefined) upd.bio = bio.slice(0, 200);
    if (telegram_id !== undefined) upd.telegram_id = telegram_id.trim();
    await client.from('profiles').update(upd).eq('id', user.id);
    return ok({ ok: true });
  }

  /* ── UPDATE AVATAR ── */
  if (method === 'PUT' && action === 'update_avatar') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    await client.from('profiles').update({ avatar_emoji: body.avatar_emoji, avatar_color: body.avatar_color }).eq('id', user.id);
    return ok({ ok: true });
  }

  /* ── CHANGE PASSWORD ── */
  if (method === 'POST' && action === 'change_password') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    const { current_password, new_password } = body;
    if (!current_password || !new_password) return err('Semua field wajib diisi');
    if (new_password.length < 6) return err('Password baru minimal 6 karakter');
    const { error: se } = await client.auth.signInWithPassword({ email: user.email, password: current_password });
    if (se) return err('Password saat ini salah');
    await client.auth.admin.updateUserById(user.id, { password: new_password });
    return ok({ ok: true });
  }

  /* ── NOTIFICATIONS ── */
  if (method === 'GET' && action === 'notifications') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return ok({ notifications: [] }); // jangan error, return kosong
    const { data } = await client.from('notifications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30);
    return ok({ notifications: data || [] });
  }

  if (method === 'POST' && action === 'read_notification') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    await client.from('notifications').update({ is_read: true }).eq('id', body.id).eq('user_id', user.id);
    return ok({ ok: true });
  }

  if (method === 'POST' && action === 'read_all_notifications') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    return ok({ ok: true });
  }

  /* ── LEADERBOARD ── */
  if (method === 'GET' && action === 'leaderboard') {
    const sortMap = { xp:'xp', messages:'chat_messages', games:'games_played', streak:'streak', coins:'coins' };
    const sortCol = sortMap[query.sort] || 'xp';
    const limit = Math.min(parseInt(query.limit) || 20, 100);
    const { data } = await client.from('profiles').select('username,avatar_emoji,avatar_color,plan,level,xp,chat_messages,games_played,streak,coins').order(sortCol, { ascending: false }).limit(limit);
    return ok({ leaderboard: (data || []).map((u, i) => ({ ...u, rank: i + 1 })) });
  }

  if (method === 'GET' && action === 'my_rank') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return ok({ rank: 0, xp: 0 });
    const { count } = await client.from('profiles').select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return ok({ rank: (count || 0) + 1, xp: user.xp || 0 });
  }

  /* ── ACTIVITY ── */
  if (method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    const { data } = await client.from('activity_log').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    return ok({ activity: data || [] });
  }

  /* ── UPDATE PREFS ── */
  if (method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    await client.from('profiles').update({ preferences: { ...(user.preferences || {}), ...body }, updated_at: new Date().toISOString() }).eq('id', user.id);
    return ok({ ok: true });
  }

  /* ── DELETE ACCOUNT ── */
  if (method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    await client.from('profiles').delete().eq('id', user.id).catch(() => {});
    await client.auth.admin.deleteUser(user.id).catch(() => {});
    return ok({ ok: true });
  }

  return err(`Action tidak dikenal: "${action}"`, 404);
};
