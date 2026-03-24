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

  /* ══ REGISTER ══════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'register') {
    if (!rateLimit('reg:'+ip, 5, 300000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Tunggu 5 menit.' });

    const { username='', email='', password='', telegram_id='', referral_code='' } = req.body;
    const uname = username.trim().toLowerCase();
    const emailClean = email.trim().toLowerCase();

    if (!uname || !emailClean || !password)
      return res.status(400).json({ error: 'Username, email, dan password wajib diisi' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname))
      return res.status(400).json({ error: 'Username 3-20 karakter (huruf, angka, underscore)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });

    // Cek username duplikat (1 call)
    const { data: ex } = await client.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (ex) return res.status(409).json({ error: 'Username sudah dipakai' });

    // Daftar (1 call) - email confirm harus OFF di Supabase dashboard
    const { data: sd, error: se } = await client.auth.signUp({
      email: emailClean, password,
      options: { data: { username: uname } }
    });

    if (se) {
      const m = se.message.toLowerCase();
      if (m.includes('already') || m.includes('registered'))
        return res.status(409).json({ error: 'Email sudah terdaftar. Silakan login.' });
      return res.status(400).json({ error: se.message });
    }

    const uid = sd?.user?.id;
    if (!uid) return res.status(400).json({ error: 'Gagal membuat akun. Coba lagi.' });

    // Handle referral bonus
    const ref = uname.slice(0,4).toUpperCase() + Math.random().toString(36).slice(2,6).toUpperCase();
    if (referral_code.trim()) {
      // Cari referrer
      client.from('profiles').select('id,coins,referral_count').eq('referral_code', referral_code.trim().toUpperCase()).maybeSingle()
        .then(({ data: referrer }) => {
          if (referrer && referrer.id !== uid) {
            // Bonus untuk referrer
            client.from('profiles').update({
              coins: (referrer.coins||0) + 100,
              referral_count: (referrer.referral_count||0) + 1
            }).eq('id', referrer.id).catch(()=>{});
            // Notif untuk referrer
            client.from('notifications').insert({
              user_id: referrer.id, type: 'achievement',
              title: '🎉 Referral Berhasil!',
              message: `${uname} bergabung pakai kode referral kamu! +100 koin bonus!`,
              icon: '🎁'
            }).catch(()=>{});
            // Bonus untuk user baru (+50 extra)
            client.from('profiles').update({ coins: 100 }).eq('id', uid).catch(()=>{}); // 50 base + 50 referral = 100
            // Catat referral
            client.from('referrals').insert({ referrer_id: referrer.id, referred_id: uid, coins_given: 100 }).catch(()=>{});
          }
        }).catch(()=>{});
    }

    // Buat profile + notif + log PARALLEL (tidak await satu-satu)
    Promise.allSettled([
      client.from('profiles').upsert({
        id: uid, username: uname,
        telegram_id: (telegram_id||'').trim(),
        referral_code: ref, coins: 50, xp: 0, level: 1, streak: 0,
        preferences: { email: emailClean, theme:'dark', accent:'blue', language:'id', fontSize:'md' }
      }, { onConflict: 'id' }),
      client.from('notifications').insert({
        user_id: uid, type: 'success',
        title: '🎉 Selamat datang di KizAi!',
        message: `Halo ${uname}! Akun berhasil dibuat. Kamu dapat 50 koin bonus!`,
        icon: '🎉'
      }),
      client.from('activity_log').insert({
        user_id: uid, type: 'register',
        description: 'Bergabung dengan KizAi', icon: '🎉', xp_earned: 0
      })
    ]); // Fire and forget - tidak perlu tunggu

    // Langsung auto-login (1 call)
    const { data: sess, error: le } = await client.auth.signInWithPassword({ email: emailClean, password });
    if (le || !sess?.session)
      return res.status(201).json({ needs_login: true, message: 'Akun dibuat! Silakan login.' });

    // Ambil profile (1 call) - mungkin belum ada karena parallel, pakai fallback
    const { data: profile } = await client.from('profiles').select('*').eq('id', uid).single();
    const plan = effectivePlan(profile);

    return res.status(201).json({
      access_token: sess.session.access_token,
      refresh_token: sess.session.refresh_token,
      user: {
        id: uid, username: uname, email: emailClean,
        plan: 'free', role: 'user', coins: 50, xp: 0, level: 1, streak: 0,
        avatar_emoji: '😊', avatar_color: '#4f7fff',
        ...(profile || {}),
        effective_plan: plan,
        accessible_models: accessibleModels(plan)
      }
    });
  }

  /* ══ REFRESH TOKEN ══════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'refresh') {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });
    const { data, error } = await client.auth.refreshSession({ refresh_token });
    if (error || !data?.session) return res.status(401).json({ error: 'Token tidak valid' });
    // Cek is_banned
    const { data: prof } = await client.from('profiles').select('is_banned').eq('id', data.user?.id).maybeSingle();
    if (prof?.is_banned) return res.status(403).json({ error: 'Akun dinonaktifkan' });
    return res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  }

  /* ══ LOGIN ══════════════════════════════════════════════════ */
  if (req.method === 'POST' && action === 'login') {
    if (!rateLimit('login:'+ip, 10, 60000))
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Tunggu 1 menit.' });

    const { identifier='', password='' } = req.body;
    if (!identifier.trim() || !password)
      return res.status(400).json({ error: 'Email/username dan password wajib diisi' });

    let email = identifier.trim().toLowerCase();

    // Username → cari email (1 call)
    if (!email.includes('@')) {
      const { data: p } = await client.from('profiles')
        .select('id,preferences').eq('username', email).maybeSingle();
      if (!p) return res.status(401).json({ error: 'Username tidak ditemukan' });
      email = p.preferences?.email || '';
      if (!email) {
        // Fallback: cari via admin API
        const { data: au } = await client.auth.admin.getUserById(p.id).catch(()=>({data:null}));
        email = au?.user?.email || '';
        if (!email) return res.status(401).json({ error: 'Tidak bisa login dengan username ini. Gunakan email.' });
        // Simpan email ke preferences untuk next login
        client.from('profiles').update({ preferences: {...(p.preferences||{}), email} }).eq('id', p.id).catch(()=>{});
      }
    }

    // Login (1 call)
    const { data: sess, error: le } = await client.auth.signInWithPassword({ email, password });
    if (le) {
      if (le.message.toLowerCase().includes('email not confirmed'))
        return res.status(401).json({ error: 'Email belum dikonfirmasi. Hubungi admin.' });
      return res.status(401).json({ error: 'Email/username atau password salah' });
    }
    if (!sess?.session) return res.status(401).json({ error: 'Gagal login. Coba lagi.' });

    // Ambil profile (1 call)
    const { data: profile } = await client.from('profiles').select('*').eq('id', sess.user.id).single();
    if (!profile) return res.status(404).json({ error: 'Profil tidak ditemukan.' });
    if (profile.is_banned) return res.status(403).json({ error: 'Akun dinonaktifkan.' });

    // Update streak di background (tidak await)
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
    let streak = profile.streak||0, bonus = 0;
    if (profile.streak_last !== today) {
      bonus = 10;
      streak = profile.streak_last === yesterday ? streak+1 : 1;
      if (streak===7) bonus+=50;
      if (streak===30) bonus+=200;
      const upd = { last_seen: new Date().toISOString(), streak, streak_last: today };
      if (bonus > 0) upd.coins = (profile.coins||0) + bonus;
      client.from('profiles').update(upd).eq('id', profile.id).catch(()=>{});
    } else {
      client.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', profile.id).catch(()=>{});
    }

    const plan = effectivePlan(profile);
    // Log activity (background)
    client.from('activity_log').insert({
      user_id: profile.id, type: 'login',
      description: 'Login ke KizAi', icon: '🔑', xp_earned: 0
    }).catch(()=>{});
    // Include updated coins/streak in response so frontend shows correct values
    const returnedUser = { ...profile, email: sess.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) };
    if (profile.streak_last !== today) {
      returnedUser.streak = streak;
      returnedUser.streak_last = today;
      if (bonus > 0) returnedUser.coins = (profile.coins||0) + bonus;
    }
    return res.json({
      access_token: sess.session.access_token,
      refresh_token: sess.session.refresh_token,
      user: returnedUser
    });
  }

  /* ══ GET PROFILE ════════════════════════════════════════════ */
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
    const upd = {
      avatar_emoji: req.body.avatar_emoji || user.avatar_emoji,
      avatar_color: req.body.avatar_color || user.avatar_color,
    };
    // Simpan foto ke preferences jika ada
    if (req.body.avatar_photo) {
      const photo = req.body.avatar_photo;
      // Validasi base64 image (max ~2MB = ~2.7MB base64)
      if (photo.startsWith('data:image/') && photo.length < 3000000) {
        upd.preferences = { ...(user.preferences || {}), avatar_photo: photo };
      }
    } else {
      // Hapus foto kalau pakai emoji
      const prefs = { ...(user.preferences || {}) };
      delete prefs.avatar_photo;
      upd.preferences = prefs;
    }
    await client.from('profiles').update(upd).eq('id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'change_password') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || new_password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    // Get email from auth.users (verifyToken includes it)
    const email = user.email || user.preferences?.email;
    if (!email) return res.status(400).json({ error: 'Email tidak ditemukan, hubungi admin' });
    const { error: se } = await client.auth.signInWithPassword({ email, password: current_password });
    if (se) return res.status(400).json({ error: 'Password saat ini salah' });
    await client.auth.admin.updateUserById(user.id, { password: new_password });
    return res.json({ ok: true });
  }

  /* ══ NOTIFICATIONS ══════════════════════════════════════════ */
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

  /* ══ LEADERBOARD ════════════════════════════════════════════ */
  if (req.method === 'GET' && action === 'leaderboard') {
    const cols = { xp:'xp', messages:'chat_messages', games:'games_played', streak:'streak', coins:'coins', tools:'tools_used' };
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

  /* ══ ACTIVITY ═══════════════════════════════════════════════ */
  if (req.method === 'GET' && action === 'activity') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('activity_log').select('*').eq('user_id', user.id).order('created_at',{ascending:false}).limit(50);
    return res.json({ activity: data||[] });
  }

  if (req.method === 'PUT' && action === 'update_prefs') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    // Whitelist keys yang boleh diubah user
    const ALLOWED = ['theme','accent','fontSize','reducedMotion','language','notif','privacy','gscores','todos','quicknote'];
    const safe = {};
    for (const k of ALLOWED) { if (req.body[k] !== undefined) safe[k] = req.body[k]; }
    await client.from('profiles').update({ preferences: {...(user.preferences||{}), ...safe}, updated_at: new Date().toISOString() }).eq('id', user.id);
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE' && action === 'delete_account') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    // Hapus semua data user
    const { data: sessions } = await client.from('chat_sessions').select('id').eq('user_id', user.id);
    for (const s of sessions||[]) {
      await client.from('chat_messages').delete().eq('session_id', s.id).catch(()=>{});
    }
    await client.from('chat_sessions').delete().eq('user_id', user.id).catch(()=>{});
    await client.from('notifications').delete().eq('user_id', user.id).catch(()=>{});
    await client.from('activity_log').delete().eq('user_id', user.id).catch(()=>{});
    await client.from('bookmarks').delete().eq('user_id', user.id).catch(()=>{});
    await client.from('profiles').delete().eq('id', user.id).catch(()=>{});
    await client.auth.admin.deleteUser(user.id).catch(()=>{});
    return res.json({ ok: true });
  }

  /* ══ UPDATE GAME STATS ════════════════════════════════════ */
  if (req.method === 'POST' && action === 'update_game_stats') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.json({ ok: false });
    const { xp_gained=5, coins_gained=2, score=0, game='' } = req.body;
    const newXp    = (user.xp||0) + xp_gained;
    const newCoins = (user.coins||0) + coins_gained;
    const newGames = (user.games_played||0) + 1;
    const newLevel = Math.floor(newXp / 100) + 1;
    await client.from('profiles').update({
      xp: newXp, coins: newCoins,
      games_played: newGames,
      level: newLevel,
      updated_at: new Date().toISOString()
    }).eq('id', user.id).catch(()=>{});
    // Activity log
    client.from('activity_log').insert({
      user_id: user.id, type: 'game',
      description: `Main game ${game}: skor ${score}`,
      icon: '🎮', xp_earned: xp_gained
    }).catch(()=>{});
    return res.json({ ok: true, xp: newXp, coins: newCoins, games_played: newGames });
  }

  /* ══ UPDATE TOOL STATS ═════════════════════════════════════ */
  if (req.method === 'POST' && action === 'update_tool_stats') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.json({ ok: false });
    const { tool_id='' } = req.body;
    const newTools = (user.tools_used||0) + 1;
    await client.from('profiles').update({
      tools_used: newTools,
      updated_at: new Date().toISOString()
    }).eq('id', user.id).catch(()=>{});
    // Activity log
    client.from('activity_log').insert({
      user_id: user.id, type: 'tool',
      description: `Pakai tool: ${tool_id}`,
      icon: '🔧', xp_earned: 0
    }).catch(()=>{});
    return res.json({ ok: true, tools_used: newTools });
  }

  /* ══ ADD COINS (generic) ════════════════════════════════════ */
  if (req.method === 'POST' && action === 'add_coins') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.json({ ok: false });
    const { amount=0, reason='' } = req.body;
    if (amount <= 0 || amount > 1000) return res.status(400).json({ error: 'Amount tidak valid' });
    const newCoins = (user.coins||0) + amount;
    await client.from('profiles').update({ coins: newCoins }).eq('id', user.id).catch(()=>{});
    return res.json({ ok: true, coins: newCoins });
  }

  /* ══ FORGOT PASSWORD ════════════════════════════════════ */
  if (req.method === 'POST' && action === 'forgot_password') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email wajib diisi' });
    // Supabase built-in password reset - sends magic link
    await client.auth.resetPasswordForEmail(email.toLowerCase().trim(), {
      redirectTo: (process.env.WEB_URL || 'https://kizhoo.my.id') + '/auth#reset'
    }).catch(()=>{});
    // Always return OK (don't leak if email exists)
    return res.json({ ok: true });
  }

    return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
});

module.exports = router;
