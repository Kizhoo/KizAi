'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors } = require('../lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  // ── REGISTER ────────────────────────────────────────────
  if (req.method === 'POST' && action === 'register') {
    const { username, email, password, telegram_id } = req.body || {};
    if (!username || !email || !password)
      return res.status(400).json({ error: 'Lengkapi semua field' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username: 3-20 karakter (huruf, angka, underscore)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });
    if (!email.includes('@'))
      return res.status(400).json({ error: 'Format email tidak valid' });

    const emailClean = email.toLowerCase().trim();
    const usernameClean = username.toLowerCase();

    // Cek username unik
    const { data: ex } = await client.from('profiles').select('id').eq('username', usernameClean).maybeSingle();
    if (ex) return res.status(409).json({ error: 'Username sudah dipakai, coba yang lain' });

    // Cek email sudah terdaftar
    const { data: exEmail } = await client.from('profiles')
      .select('id').maybeSingle();

    // Buat user via admin.createUser (lebih reliable, bypass trigger issue)
    let authUser = null;
    const { data: adminData, error: adminErr } = await client.auth.admin.createUser({
      email: emailClean,
      password,
      email_confirm: true,
      user_metadata: { username: usernameClean },
    });

    if (adminErr) {
      // Fallback ke signUp jika admin gagal
      const { data: signupData, error: signupErr } = await client.auth.signUp({
        email: emailClean,
        password,
        options: { data: { username: usernameClean } }
      });
      if (signupErr) {
        // Handle specific errors
        if (signupErr.message.includes('already registered') || signupErr.message.includes('already been registered'))
          return res.status(409).json({ error: 'Email sudah terdaftar, gunakan email lain' });
        return res.status(400).json({ error: signupErr.message });
      }
      authUser = signupData?.user;
    } else {
      authUser = adminData?.user;
    }

    if (!authUser) return res.status(400).json({ error: 'Gagal membuat akun, coba lagi' });

    // Buat profile (upsert aman meski trigger sudah buat row)
    const referralCode = usernameClean.toUpperCase().substring(0,4) + Math.random().toString(36).substring(2,6).toUpperCase();
    const { error: profileErr } = await client.from('profiles').upsert({
      id: authUser.id,
      username: usernameClean,
      telegram_id: telegram_id || '',
      referral_code: referralCode,
      coins: 50,
      streak: 1,
      streak_last: new Date().toISOString().split('T')[0],
      preferences: { email: emailClean, theme: 'dark', language: 'id', notificationsEnabled: true },
    }, { onConflict: 'id' });

    if (profileErr && !profileErr.message.includes('duplicate')) {
      console.error('Profile upsert error:', profileErr.message);
    }

    // Auto-login
    const { data: session, error: loginErr } = await client.auth.signInWithPassword({
      email: emailClean, password,
    });
    if (loginErr || !session?.session) {
      return res.status(201).json({ message: 'Akun dibuat! Silakan login.' });
    }

    const { data: profile } = await client.from('profiles').select('*').eq('id', authUser.id).single();
    const plan = effectivePlan(profile);
    return res.status(201).json({
      access_token: session.session.access_token,
      user: { ...profile, email: email.toLowerCase().trim(), effective_plan: plan, accessible_models: accessibleModels(plan) },
    });
  }

  // ── LOGIN ────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'login') {
    const raw = req.body || {};
    const identifier = (raw.identifier || raw.username || '').trim();
    const password   = raw.password || '';
    if (!identifier || !password)
      return res.status(400).json({ error: 'Lengkapi semua field' });

    let email = identifier;
    if (!identifier.includes('@')) {
      const { data: p } = await client.from('profiles').select('id,preferences').eq('username', identifier.toLowerCase()).maybeSingle();
      if (!p) return res.status(401).json({ error: 'Username atau password salah' });

      // Coba ambil email dari auth.users via admin API
      let emailFound = false;
      try {
        const { data: u } = await client.auth.admin.getUserById(p.id);
        if (u?.user?.email) { email = u.user.email; emailFound = true; }
      } catch {}

      // Fallback: cek apakah email disimpan di preferences
      if (!emailFound && p.preferences?.email) {
        email = p.preferences.email;
        emailFound = true;
      }

      if (!emailFound) {
        return res.status(401).json({ error: 'Login dengan email tidak bisa dilakukan. Coba login pakai email langsung.' });
      }
    }

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Username atau password salah' });

    const { data: profile } = await client.from('profiles').select('*').eq('id', data.user.id).single();

    // Update streak
    const today = new Date().toISOString().split('T')[0];
    let streak  = profile?.streak || 0;
    if (profile?.streak_last !== today) {
      const yest = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      streak = profile?.streak_last === yest ? streak + 1 : 1;
      await client.from('profiles').update({ last_seen: new Date().toISOString(), streak, streak_last: today }).eq('id', data.user.id);
    }

    const plan = effectivePlan(profile);
    return res.json({
      access_token: data.session.access_token,
      user: { ...profile, streak, email: data.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) },
    });
  }

  // ── ADMIN LOGIN ──────────────────────────────────────────
  if (req.method === 'POST' && action === 'admin-login') {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Lengkapi semua field' });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Email atau password salah' });
    const { data: profile } = await client.from('profiles').select('*').eq('id', data.user.id).single();
    if (!profile || profile.role !== 'admin')
      return res.status(403).json({ error: 'Akses ditolak. Akun ini bukan admin.' });
    const plan = effectivePlan(profile);
    return res.json({
      access_token: data.session.access_token,
      user: { ...profile, email: data.user.email, effective_plan: plan },
    });
  }

  // ── GET ME ───────────────────────────────────────────────
  if (req.method === 'GET' && action === 'me') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const plan = effectivePlan(user);
    return res.json({ user: { ...user, effective_plan: plan, accessible_models: accessibleModels(plan) } });
  }

  // ── UPDATE PROFILE ───────────────────────────────────────
  if (req.method === 'PUT' && action === 'profile') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const allowed = ['telegram_id','bio','avatar_color','avatar_emoji'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (req.body.preferences) {
      const { data: cur } = await client.from('profiles').select('preferences').eq('id', user.id).single();
      updates.preferences = { ...(cur?.preferences || {}), ...req.body.preferences };
    }
    const { data, error } = await client.from('profiles').update(updates).eq('id', user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const plan = effectivePlan(data);
    return res.json({ user: { ...data, effective_plan: plan, accessible_models: accessibleModels(plan) } });
  }

  // ── CHANGE PASSWORD ──────────────────────────────────────
  if (req.method === 'PUT' && action === 'change-password') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { newpass } = req.body || {};
    if (!newpass || newpass.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
    const { error } = await client.auth.admin.updateUserById(user.id, { password: newpass });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: 'Password berhasil diubah' });
  }

  // ── CHAT SESSIONS ────────────────────────────────────────
  if (req.method === 'GET' && action === 'sessions') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data } = await client.from('chat_sessions')
      .select('id,title,model_id,message_count,last_message,created_at,updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(50);
    return res.json({ sessions: data || [] });
  }

  if (req.method === 'POST' && action === 'sessions') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { title, model_id } = req.body || {};
    const { data, error } = await client.from('chat_sessions').insert({
      user_id: user.id,
      title:   title || 'New Chat',
      model_id: model_id || 'llama-8b',
      message_count: 0,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ session: data });
  }

  if (req.method === 'DELETE' && action === 'sessions') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { session_id } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'session_id wajib' });
    await client.from('chat_messages').delete().eq('session_id', session_id).eq('user_id', user.id);
    await client.from('chat_sessions').delete().eq('id', session_id).eq('user_id', user.id);
    return res.json({ message: 'Deleted' });
  }

  if (req.method === 'GET' && action === 'messages') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id wajib' });
    const { data } = await client.from('chat_messages')
      .select('id,role,content,model_id,created_at')
      .eq('session_id', session_id)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(200);
    return res.json({ messages: data || [] });
  }

  // ── NOTIFICATIONS ─────────────────────────────────────────
  if (req.method === 'GET' && action === 'notifications') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data } = await client.from('notifications')
      .select('*').eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(20);
    return res.json({ notifications: data || [] });
  }

  if (req.method === 'PUT' && action === 'read-notifications') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id);
    return res.json({ message: 'ok' });
  }

  // ── ORDERS ────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'my-orders') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data } = await client.from('orders')
      .select('order_id,plan,duration,price,status,payment_method,created_at,activated_at,expires_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    return res.json({ orders: data || [] });
  }

  // ── BOOKMARKS ─────────────────────────────────────────────
  if (req.method === 'GET' && action === 'bookmarks') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data } = await client.from('bookmarks').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    return res.json({ bookmarks: data || [] });
  }

  if (req.method === 'POST' && action === 'bookmark') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { type, item_id, item_name, item_emoji, note } = req.body || {};
    const { data, error } = await client.from('bookmarks')
      .upsert({ user_id: user.id, type, item_id, item_name, item_emoji, note }, { onConflict: 'user_id,type,item_id' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ bookmark: data });
  }

  if (req.method === 'DELETE' && action === 'bookmark') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { type, item_id } = req.body || {};
    await client.from('bookmarks').delete().eq('user_id', user.id).eq('type', type).eq('item_id', item_id);
    return res.json({ message: 'Deleted' });
  }


  // ── LEADERBOARD ───────────────────────────────────────
  if (req.method === 'GET' && action === 'leaderboard') {
    const { data } = await client
      .from('profiles')
      .select('username,avatar_color,avatar_emoji,plan,xp,level,streak,games_played,chat_messages,coins,tools_used')
      .eq('role','user')
      .order('xp', { ascending: false })
      .limit(50);
    return res.json({ leaderboard: data || [] });
  }

  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
};
// (injected at bottom - handled inside module.exports above)

