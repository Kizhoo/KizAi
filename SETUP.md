# KizAi v4 — Setup Guide

## 🚀 Deploy ke Vercel

1. Upload zip ini ke GitHub (baru atau existing repo)
2. Import di vercel.com → New Project
3. Set environment variables di Vercel Dashboard → Settings → Environment Variables
4. Deploy!

## ⚙️ Environment Variables Wajib

| Variable | Dari mana |
|---|---|
| `SUPABASE_URL` | supabase.com → Project Settings → API → URL |
| `SUPABASE_SERVICE_KEY` | supabase.com → Project Settings → API → **service_role** key |
| `CF_ACCOUNT_ID` | dash.cloudflare.com → sidebar kanan |
| `CF_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens |
| `IPAYMU_VA` | dashboard.ipaymu.com → Pengaturan |
| `IPAYMU_API_KEY` | dashboard.ipaymu.com → Pengaturan |
| `BOT_TOKEN` | @BotFather di Telegram → /newbot |
| `ADMIN_TELEGRAM_ID` | kirim pesan ke @userinfobot |
| `WEB_URL` | URL Vercel kamu (contoh: https://kizai.vercel.app) |

## 🗄️ Setup Database Supabase

1. Buka supabase.com → Project kamu → SQL Editor
2. Copy seluruh isi file `supabase-schema.sql`
3. Paste di SQL Editor → klik **Run**
4. Database + admin account otomatis dibuat

**Penting:** Di Supabase Dashboard → Authentication → Settings:
- **Disable** "Enable email confirmations" ← wajib agar daftar langsung bisa login

## 👤 Akun Admin Default

```
URL      : https://domainmu.vercel.app/admin-login
Email    : admin@kizai.id
Password : KizAi@Admin2025!
```

**⚠️ Ganti password setelah pertama kali login!**

## 📝 Cara Buat Admin Tambahan

Setelah user daftar, jalankan SQL ini di Supabase:
```sql
UPDATE profiles SET role = 'admin' WHERE username = 'namauser';
```

## 🔧 Tools AI

Tools AI butuh Cloudflare AI. Jika `CF_ACCOUNT_ID` / `CF_API_TOKEN` belum diset, tools AI akan berjalan dalam **demo mode** (respons dummy).

## 💰 Payment (iPaymu)

- Set `IPAYMU_PRODUCTION=false` untuk testing (sandbox)
- Set `IPAYMU_PRODUCTION=true` untuk live
- Set Notify URL di dashboard iPaymu: `https://domainmu.vercel.app/api/payment?action=callback`
