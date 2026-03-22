'use strict';
const { Router } = require('express');
const { sb, verifyToken, effectivePlan, accessibleModels, rateLimit } = require('../lib/supabase');

const router = Router();

router.all('*', async (req, res) => {
  let client;
  try { client = sb(); } 
  catch(e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || 'unknown';

  /* ══ REGISTER ══════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'register') {
    if (!rateLimit('reg:'+ip, 5, 300000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Tunggu 5 menit.' });

    const { username='', email='', password='', telegram_id='' } = req.body;
    const uname = username.trim().toLowerCase();
    const emailClean = email.trim().toLowerCase();

    if (!uname || !emailClean || !password)
      return res.status(400).json({ error: 'Username, email, dan password wajib diisi' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname))
      return res.status(400).json({ error: 'Username 3-20 karakter (huruf, angka, underscore)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });

    // Cek username duplikat
    const { data: ex } = await client.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (ex) return res.status(409).json({ error: 'Username sudah dipakai, pilih yang lain' });

    // Daftar via signUp (email_confirm harus OFF di Supabase dashboard)
    const { data: signupData, error: signupErr } = await client.auth.signUp({
      email: emailClean,
      password,
      options: { data: { username: uname } }
    });

    if (signupErr) {
      const m = signupErr.message.toLowerCase();
      if (m.includes('already') || m.includes('registered') || m.includes('duplicate'))
        return res.status(409).json({ error: 'Email sudah terdaftar. Silakan login.' });
      return res.status(400).json({ error: signupErr.message });
    }

    const uid = signupData?.user?.id;
    if (!uid) return res.status(400).json({ error: 'Gagal membuat akun. Coba lagi.' });

    // Buat profile manual (trigger mungkin sudah handle ini, tapi kita upsert untuk safety)
    const ref = uname.slice(0,4).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
    await client.from('profiles').upsert({
      id: uid, username: uname,
      telegram_id: (telegram_id||'').trim(),
      referral_code: ref,
      coins: 50, xp: 0, level: 1, streak: 0,
      preferences: { email: emailClean, theme:'dark', accent:'blue', language:'id', fontSize:'md' }
    }, { onConflict: 'id' }).catch(e => console.warn('profile upsert:', e.message));

    // Welcome notification
    await client.from('notifications').insert({
      user_id: uid, type: 'success',
      title: '🎉 Selamat datang di KizAi!',
      message: `Halo ${uname}! Akun berhasil dibuat. Kamu dapat 50 koin bonus!`,
      icon: '🎉'
    }).catch(()=>{});

    // Auto-login
    const { data: sess, error: loginErr } = await client.auth.signInWithPassword({
      email: emailClean, password
    });

    if (loginErr || !sess?.session) {
      console.warn('Auto-login failed:', loginErr?.message);
      return res.status(201).json({ needs_login: true, message: 'Akun dibuat! Silakan login.' });
    }

    const { data: profile } = await client.from('profiles').select('*').eq('id', uid).single();
    if (!profile) return res.status(201).json({ needs_login: true, message: 'Akun dibuat! Silakan login.' });

    const plan = effectivePlan(profile);
    return res.status(201).json({
      access_token: sess.session.access_token,
      refresh_token: sess.session.refresh_token,
      user: { ...profile, email: emailClean, effective_plan: plan, accessible_models: accessibleModels(plan) }
    });
  }

  /* ══ LOGIN ═════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'login') {
    if (!rateLimit('login:'+ip, 10, 60000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Tunggu 1 menit.' });

    const { identifier='', password='' } = req.body;
    if (!identifier.trim() || !password)
      return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

    let email = identifier.trim().toLowerCase();

    // Username → cari email
    if (!email.includes('@')) {
      const { data: p } = await client.from('profiles')
        .select('id,preferences').eq('username', email).maybeSingle();
      if (!p) return res.status(401).json({ error: 'Username tidak ditemukan' });
      if (p.preferences?.email) {
        email = p.preferences.email;
      } else {
        const { data: au } = await client.auth.admin.getUserById(p.id).catch(()=>({data:null}));
        if (!au?.user?.email) return res.status(401).json({ error: 'Tidak bisa login dengan username, coba pakai email.' });
        email = au.user.email;
        await client.from('profiles').update({ preferences: { ...(p.preferences||{}), email } }).eq('id', p.id).catch(()=>{});
      }
    }

    const { data: sess, error: le } = await client.auth.signInWithPassword({ email, password });
    if (le) {
      if (le.message.toLowerCase().includes('email not confirmed'))
        return res.status(401).json({ error: 'Email belum dikonfirmasi. Cek inbox atau hubungi admin.' });
      return res.status(401).json({ error: 'Email/username atau password salah' });
    }
    if (!sess?.session) return res.status(401).json({ error: 'Gagal login. Coba lagi.' });

    const { data: profile } = await client.from('profiles').select('*').eq('id', sess.user.id).single();
    if (!profile) return res.status(404).json({ error: 'Profil tidak ditemukan.' });
    if (profile.is_banned) return res.status(403).json({ error: 'Akun dinonaktifkan.' });

    // Streak
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
    let streak = profile.streak || 0, bonus = 0;
    if (profile.streak_last !== today) {
      bonus = 10;
      streak = profile.streak_last === yesterday ? streak+1 : 1;
      if (streak===7) bonus+=50;
      if (streak===30) bonus+=200;
    }
    const upd = { last_seen: new Date().toISOString() };
    if (profile.streak_last !== today) {
      upd.streak = streak; upd.streak_last = today;
      if (bonus > 0) upd.coins = (profile.coins||0) + bonus;
    }
    await client.from('profiles').update(upd).eq('id', profile.id).catch(()=>{});

    const plan = effectivePlan(profile);
    return res.json({
      access_token: sess.session.access_token,
      refresh_token: sess.session.refresh_token,
      user: { ...profile, ...upd, email: sess.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) }
    });
  }

  /* ══ GET PROFILE ═══════════════════════════════════════ */
  if (req.method === 'GET' && action === 'profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { count } = await client.from('profiles').select('id',{count:'exact',head:true}).gt('xp', user.xp||0);
    return res.json({ user: { ...user, rank: (count||0)+1 } });
  }

  if (req.method === 'PUT' && action === 'update_profile') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { username, bio, telegram_id } = req.body;
    if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username tidak valid' });
    if (username && username.toLowerCase() !== user.username) {
      const { data: ex } = await client.from('profiles').select('id').eq('username',username.toLowerCase()).maybeSingle();
      if (ex) return res.status(409).json({ error: 'Username sudah dipakai' });
    }
    const upd = { updated_at: new Date().toISOString() };
    if (username) upd.username = username.toLowerCase().trim();
    if (bio !== undefined) upd.bio = bio.slice(0,200);
    if (telegram_id !== undefined) upd.telegram_id = telegram_id.trim();
    await client.from('profiles').update(upd).eq('id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'PUT' && action === 'update_avatar') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').update({ avatar_emoji: req.body.avatar_emoji, avatar_color: req.body.avatar_color }).eq('id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'change_password') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || new_password.length < 6)
      return res.status(400).json({ error: 'Password tidak valid' });
    const { error: se } = await client.auth.signInWithPassword({ email: user.email, password: current_password });
    if (se) return res.status(400).json({ error: 'Password saat ini salah' });
    await client.auth.admin.updateUserById(user.id, { password: new_password });
    return res.json({ ok: true });
  }

  /* ══ NOTIFICATIONS ═════════════════════════════════════ */
  if (req.method === 'GET' && action === 'notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.json({ notifications: [] });
    const { data } = await client.from('notifications').select('*').eq('user_id', user.id).order('created_at',{ascending:false}).limit(30);
    return res.json({ notifications: data||[] });
  }
  if (req.method === 'POST' && action === 'read_notification') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications').update({ is_read: true }).eq('id', req.body.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }
  if (req.method === 'POST' && action === 'read_all_notifications') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    return res.json({ ok: true });
  }

  /* ══ LEADERBOARD ═══════════════════════════════════════ */
  if (req.method === 'GET' && action === 'leaderboard') {
    const cols = { xp:'xp', messages:'chat_messages', games:'games_played', streak:'streak', coins:'coins' };
    const col = cols[req.query.sort] || 'xp';
    const limit = Math.min(parseInt(req.query.limit)||20, 100);
    const { data } = await client.from('profiles')
      .select('username,avatar_emoji,avatar_color,plan,level,xp,chat_messages,games_played,streak,coins')
      .order(col, { ascending: false }).limit(limit);
    return res.json({ leaderboard: (data||[]).map((u,i)=>({...u, rank: i+1})) });
  }
  if (req.method === 'GET' && action === 'my_rank') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.json({ rank:0, xp:0 });
    const { count } = await client.from('profiles').select('id',{count:'exact',head:true}).gt('xp', user.xp||0);
    return res.json({ rank: (count||0)+1, xp: user.xp||0 });
  }

  /* ══ ACTIVITY ══════════════════════════════════════════ */
  if (req.method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('activity_log').select('*').eq('user_id', user.id).order('created_at',{ascending:false}).limit(50);
    return res.json({ activity: data||[] });
  }

  if (req.method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').update({ preferences: { ...(user.preferences||{}), ...req.body }, updated_at: new Date().toISOString() }).eq('id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    await client.from('profiles').delete().eq('id', user.id).catch(()=>{});
    await client.auth.admin.deleteUser(user.id).catch(()=>{});
    return res.json({ ok: true });
  }

  return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
});

module.exports = router;
