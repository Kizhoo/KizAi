'use strict';
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

/* ── Middleware ── */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Log requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/* ── Health check (Railway needs this) ── */
app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ── API Routes ── */
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/chat',    require('./routes/chat'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin',   require('./routes/admin'));

/* ── Static Files ── */
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js'))
      res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

/* ── Pretty URLs ── */
const PAGES = ['auth','chat','dashboard','checkout','tools','games','leaderboard','admin','admin-login'];
PAGES.forEach(page => {
  app.get(`/${page}`, (_, res) => res.sendFile(path.join(PUBLIC, `${page}.html`)));
});

app.get('/', (_, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

/* ── Global error handler ── */
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/* ── 404 Fallback ── */
app.use((_, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

/* ── START ── */
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════╗');
  console.log(`║  KizAi v4  — Port ${PORT}           ║`);
  console.log('╠══════════════════════════════════╣');
  console.log(`║  SUPABASE_URL    : ${process.env.SUPABASE_URL ? '✅ Set' : '❌ BELUM DISET'}  ║`);
  console.log(`║  SUPABASE_KEY    : ${process.env.SUPABASE_SERVICE_KEY ? '✅ Set' : '❌ BELUM DISET'}  ║`);
  console.log(`║  CF_ACCOUNT_ID   : ${process.env.CF_ACCOUNT_ID ? '✅ Set' : '⚠️  demo mode'}   ║`);
  console.log(`║  IPAYMU_VA       : ${process.env.IPAYMU_VA ? '✅ Set' : '⚠️  disabled'}   ║`);
  console.log('╚══════════════════════════════════╝');
  console.log('');
});

// Tangkap error yang tidak tertangkap
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
