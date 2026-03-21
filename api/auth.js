'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors, rateLimit } = require('../lib/supabase');

const loginAttempts = new Map();

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

  // ── REGISTER ──
  if (req.method === 'POST' && action === 'register') {
    if (!rateLimit(loginAttempts, 'reg:'+ip, 5, 300000))
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

    const emailClean = email.toLowerCase().trim();
    const usernameClean = username.toLowerCase();

    // Check username uniqueness
    const { data: existing } = await client.from('profiles').select('id').eq('username', usernameClean).maybeSingle();
    if (existing) return res.status(409).json({ error: 'Username sudah dipakai, coba yang lain' });

    // Create auth user
    let authUser = null;
    const { data: adminData, error: adminErr } = await client.auth.admin.createUser({
      email: emailClean, password, email_confirm: true,
      user_metadata: { username: usernameClean },
    });

    if (adminErr) {
      const { data: signupData, error: signupErr } = await client.auth.signUp({
        email: emailClean, password,
        options: { data: { username: usernameClean } }
      });
      if (signupErr) {
        if (signupErr.message.toLowerCase().includes('already'))
          return res.status(409).json({ error: 'Email sudah terdaftar, gunakan email lain' });
        return res.status(400).json({ error: signupErr.message });
      }
      authUser = signupData?.user;
    } else {
      authUser = adminData?.user;
    }

    if (!authUser) return res.status(400).json({ error: 'Gagal membuat akun, coba lagi' });

    // Create profile
    const referralCode = usernameClean.slice(0,4).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
    const { error: profileErr } = await client.from('profiles').upsert({
      id: authUser.id, username: usernameClean,
      telegram_id: telegram_id || '',
      referral_code: referralCode,
      coins: 50, xp: 0, level: 1, streak: 0,
      preferences: { email: emailClean, theme: 'dark', language: 'id', notifications: true },
    }, { onConflict: 'id' });

    if (profileErr && !profileErr.message?.includes('duplicate'))
      console.error('Profile create error:', profileErr.message);

    // Log activity
    await client.from('activity_log').insert({
      user_id: authUser.id, type: 'register', description: 'Bergabung dengan KizAi', icon: '🎉', xp_earned: 0
    }).catch(() => {});

    // Auto-login
    const { data: session, error: loginErr } = await client.auth.signInWithPassword({ email: emailClean, password });
    if (loginErr || !session?.session)
      return res.status(201).json({ message: 'Akun berhasil dibuat! Silakan login.' });

    const { data: profile } = await client.from('profiles').select('*').eq('id', authUser.id).single();
    const plan = effectivePlan(profile);
    return res.status(201).json({
      access_token: session.session.access_token,
      user: { ...profile, email: emailClean, effective_plan: plan, accessible_models: accessibleModels(plan) },
    });
  }

  // ── LOGIN ──
  if (req.method === 'POST' && action === 'login') {
    if (!rateLimit(loginAttempts, 'login:'+ip, 10, 60000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan login, tunggu 1 menit' });

    const { identifier, password } = req.body || {};
    if (!identifier || !password)
      return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

    let email = identifier.trim().toLowerCase();

    // If username, look up email
    if (!email.includes('@')) {
      const { data: p } = await client.from('profiles').select('preferences').eq('username', email).maybeSingle();
      if (!p?.preferences?.email) return res.status(401).json({ error: 'Username tidak ditemukan' });
      email = p.preferences.email;
    }

    const { data: session, error: loginErr } = await client.auth.signInWithPassword({ email, password });
    if (loginErr || !session?.session)
      return res.status(401).json({ error: 'Email/username atau password salah' });

    const { data: profile } = await client.from('profiles').select('*').eq('id', session.user.id).single();
    if (!profile) return res.status(404).json({ error: 'Profil tidak ditemukan' });
    if (profile.is_banned) return res.status(403).json({ error: 'Akun ini telah dinonaktifkan. Hubungi support.' });

    // Update last_seen & streak
    const today = new Date().toISOString().split('T')[0];
    const lastSeen = profile.streak_last;
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    let newStreak = profile.streak || 0;
    let coinBonus = 10; // daily login bonus

    if (lastSeen === today) {
      coinBonus = 0; // already logged in today
    } else if (lastSeen === yesterday) {
      newStreak++;
      if (newStreak === 7) coinBonus += 50;
      else if (newStreak === 30) coinBonus += 200;
    } else {
      newStreak = 1;
    }

    const updateData = { last_seen: new Date().toISOString() };
    if (lastSeen !== today) {
      updateData.streak = newStreak;
      updateData.streak_last = today;
      if (coinBonus > 0) updateData.coins = (profile.coins || 0) + coinBonus;
    }

    await client.from('profiles').update(updateData).eq('id', profile.id);

    const plan = effectivePlan(profile);
    return res.json({
      access_token: session.session.access_token,
      user: { ...profile, ...updateData, email: session.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) },
    });
  }

  // ── GET PROFILE ──
  if (req.method === 'GET' && action === 'profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    // Get rank
    const { count } = await client.from('profiles').select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return res.json({ user: { ...user, rank: (count || 0) + 1 } });
  }

  // ── UPDATE PROFILE ──
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
    const updates = {};
    if (username) updates.username = username.toLowerCase();
    if (bio !== undefined) updates.bio = bio.slice(0, 200);
    if (telegram_id !== undefined) updates.telegram_id = telegram_id;
    updates.updated_at = new Date().toISOString();
    const { error } = await client.from('profiles').update(updates).eq('id', user.id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  // ── UPDATE AVATAR ──
  if (req.method === 'PUT' && action === 'update_avatar') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { avatar_emoji, avatar_color } = req.body || {};
    await client.from('profiles').update({ avatar_emoji, avatar_color }).eq('id', user.id);
    return res.json({ ok: true });
  }

  // ── CHANGE PASSWORD ──
  if (req.method === 'POST' && action === 'change_password') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
    // Re-verify current password
    const { error: signInErr } = await client.auth.signInWithPassword({ email: user.email, password: current_password });
    if (signInErr) return res.status(400).json({ error: 'Password saat ini salah' });
    const { error } = await client.auth.admin.updateUserById(user.id, { password: new_password });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  // ── GET NOTIFICATIONS ──
  if (req.method === 'GET' && action === 'notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('notifications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30);
    return res.json({ notifications: data || [] });
  }

  // ── READ NOTIFICATION ──
  if (req.method === 'POST' && action === 'read_notification') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { id } = req.body || {};
    await client.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  // ── READ ALL NOTIFICATIONS ──
  if (req.method === 'POST' && action === 'read_all_notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    return res.json({ ok: true });
  }

  // ── LEADERBOARD ──
  if (req.method === 'GET' && action === 'leaderboard') {
    const sort = req.query.sort || 'xp';
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const validSorts = { xp:'xp', messages:'chat_messages', tools:'tools_used', games:'games_played', streak:'streak', coins:'coins' };
    const sortCol = validSorts[sort] || 'xp';
    const { data } = await client.from('profiles').select('username,avatar_emoji,avatar_color,plan,level,xp,chat_messages,tools_used,games_played,streak,coins').order(sortCol, { ascending: false }).limit(limit);
    const lb = (data || []).map((u, i) => ({ ...u, rank: i + 1 }));
    return res.json({ leaderboard: lb });
  }

  // ── MY RANK ──
  if (req.method === 'GET' && action === 'my_rank') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { count } = await client.from('profiles').select('id', { count: 'exact', head: true }).gt('xp', user.xp || 0);
    return res.json({ rank: (count || 0) + 1, xp: user.xp || 0 });
  }

  // ── ACTIVITY ──
  if (req.method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('activity_log').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    return res.json({ activity: data || [] });
  }

  // ── UPDATE PREFS ──
  if (req.method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const updates = req.body || {};
    const current = user.preferences || {};
    await client.from('profiles').update({ preferences: { ...current, ...updates }, updated_at: new Date().toISOString() }).eq('id', user.id);
    return res.json({ ok: true });
  }

  // ── DELETE ACCOUNT ──
  if (req.method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').delete().eq('id', user.id);
    await client.auth.admin.deleteUser(user.id);
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: 'Action tidak ditemukan: ' + action });
};
