# Gemini Lounge

A monochrome single-page AI knowledge system that integrates Gemini File Search with Supabase-backed authentication.

## Environment variables

Create an `.env` file (or configure Vercel project variables) with the following keys:

- `GEMINI_API_KEY` – Gemini API key (falls back to `GOOGLE_API_KEY` if omitted).
- `GOOGLE_API_KEY` – Legacy alias for the Gemini key.
- `SUPABASE_URL` – Supabase project URL (https://<project-ref>.supabase.co).
- `SUPABASE_ANON_KEY` – Supabase anon/public API key (server-side fallback).
- `SUPABASE_SERVICE_ROLE_KEY` – Supabase service-role key (used only on the server/API layer).
- `SUPABASE_GOOGLE_REDIRECT_URL` – OAuth redirect destination (e.g. `https://your-domain.com/` or local `http://localhost:3000/`).
- `NEXT_PUBLIC_SUPABASE_URL` – Same URL as above, but exposed to the browser for the static frontend.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` – Browser-facing anon key used by the Gemini Lounge UI.

> **Note:** Because the frontend is a static `public/` bundle, browser code cannot read `process.env.*`. The `/api/public-env` endpoint surfaces the public Supabase credentials at runtime, so both `SUPABASE_*` (server) and `NEXT_PUBLIC_SUPABASE_*` (browser) variables should be configured in Vercel.

## Demo login

The local fallback (when Supabase credentials are omitted) ships with a demo account:

- **Email:** `30.sc350@gmail.com`
- **Password:** `12341234`

When running against Supabase, create an auth user with the same credentials and execute `supabase/seed.sql` so the corresponding staff profile is provisioned automatically.

## Supabase Google OAuth setup

1. **Enable Google provider** – In Supabase Console go to **Authentication → Providers**, enable Google, and set the OAuth consent screen credentials in Google Cloud. Configure the Google redirect URI to `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Configure redirect URLs** – In **Authentication → URL Configuration**, add your production domain, preview URLs, and `http://localhost:3000` to the `Site URL` and `Redirect URLs` lists.
3. **Expose the anon key to the client** – Configure both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel. The app reads them via `/api/public-env` so the static HTML/JS bundle can initialise Supabase at runtime.
4. **Server credentials** – Keep `SUPABASE_SERVICE_ROLE_KEY` restricted to server-side execution only (API routes / local server) and never expose it in the browser.

After deploying, confirm that clicking **Google でログイン** navigates to `/auth/v1/authorize`, and that returning to the app yields a valid `supabase.auth.getUser()` response.

## API verification

Use the following `curl` commands (adjusting domain, bearer token, and IDs) to verify the serverless functions respond with JSON during deployments:

```bash
curl -sS https://<your-domain>/api/state
curl -sS \
  -H "Authorization: Bearer <access_token>" \
  "https://<your-domain>/api/file-stores"
curl -sS \
  -H "Authorization: Bearer <access_token>" \
  -X POST "https://<your-domain>/api/file-stores" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Example Store","description":"demo"}'
curl -sS \
  -H "Authorization: Bearer <access_token>" \
  "https://<your-domain>/api/documents?fileStoreId=<uuid>"
curl -sS \
  -H "Authorization: Bearer <access_token>" \
  -X POST "https://<your-domain>/api/documents" \
  -F "fileStoreId=<uuid>" \
  -F "memo=demo upload" \
  -F "file=@./sample.pdf"
curl -i -X POST "https://<your-domain>/api/auth/login-email" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret"}'
```

Each endpoint should return `application/json` responses for both success and error cases (e.g., 4xx/5xx). To validate row-level security, issue the same `GET /api/file-stores` request with two different user access tokens and confirm that each user only sees stores for their office. Repeat the check for `GET /api/documents?fileStoreId=...` to ensure cross-office access is rejected with `403`.
