'use strict';

// Tangkap semua error agar server tidak crash
process.on('uncaughtException', (err) => console.error('CRASH PREVENTED:', err.message));
process.on('unhandledRejection', (r) => console.error('REJECTION:', r?.message || r));

const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 8080;

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check — Railway uses this to confirm app is alive
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

// Maintenance mode check middleware (reads from admin config)
app.use((req, res, next) => {
  const isAPI = req.path.startsWith('/api/');
  const isPublicPath = ['/auth','/ping','/health','/manifest.json'].some(p => req.path.startsWith(p));
  if (isAPI && !isPublicPath) {
    try {
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('/tmp/kizai-admin-config.json','utf8'));
      if (cfg.maintenance && !req.path.startsWith('/api/admin')) {
        return res.status(503).json({ error: cfg.announcement || 'Server sedang maintenance. Coba lagi nanti.' });
      }
    } catch {} // no config file = not in maintenance
  }
  next();
});
app.get('/ping',   (_, res) => res.send('pong'));

// API routes — wrapped in try/catch so 1 broken route doesn't kill the server
try {
  app.use('/api/auth',    require('./routes/auth'));
  app.use('/api/chat',    require('./routes/chat'));
  app.use('/api/payment', require('./routes/payment'));
  app.use('/api/admin',   require('./routes/admin'));
  console.log('✅ Routes loaded');
} catch (e) {
  console.error('❌ Route load error:', e.message);
  app.use('/api', (_, res) => res.status(500).json({ error: 'Server sedang dalam maintenance' }));
}

// Static files
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC, {
  maxAge: '1h',
  setHeaders: (res, path) => {
    // shared.js and shared.css change often, shorter cache
    if (path.includes('shared.js') || path.includes('shared.css')) {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
  }
}));

// Pretty URLs
['auth','chat','dashboard','checkout','tools','games','leaderboard','admin','admin-login']
  .forEach(p => app.get(`/${p}`, (_, res) => res.sendFile(path.join(PUBLIC, `${p}.html`))));

app.get('/', (_, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal error' });
});

// 404 → index
app.use((_, res) => {
  try { res.sendFile(path.join(PUBLIC, 'index.html')); }
  catch { res.status(404).send('Not found'); }
});

// Self-ping setiap 4 menit agar Railway tidak sleep
const http = require('http');
const https = require('https');
const SELF_URL = process.env.WEB_URL ? process.env.WEB_URL + '/ping' : null;
const LOCAL_URL = 'http://127.0.0.1:' + (process.env.PORT || 8080) + '/ping';

setInterval(() => {
  // Ping localhost (with timeout)
  const req1 = http.get(LOCAL_URL, () => {});
  req1.setTimeout(5000, () => req1.destroy());
  req1.on('error', () => {});
  // Ping public URL if available
  if (SELF_URL) {
    const mod = SELF_URL.startsWith('https') ? https : http;
    const req2 = mod.get(SELF_URL, () => {});
    req2.setTimeout(10000, () => req2.destroy());
    req2.on('error', () => {});
  }
}, 4 * 60 * 1000); // 4 menit

// START — must bind to 0.0.0.0 on Railway
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚂 KizAi v4 running on PORT ${PORT}`);
  console.log(`   SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅' : '❌ NOT SET'}`);
  console.log(`   SUPABASE_KEY: ${process.env.SUPABASE_SERVICE_KEY ? '✅' : '❌ NOT SET'}`);
  console.log(`   CF_AI:        ${process.env.CF_ACCOUNT_ID ? '✅' : '⚠️ demo'}`);
});
