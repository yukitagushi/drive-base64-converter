# Gemini Lounge

A monochrome single-page AI knowledge system that integrates Gemini File Search with Supabase-backed authentication.

## Environment variables

Create an `.env` file (or configure Vercel project variables) with the following keys:

- `GOOGLE_API_KEY` – Gemini API key.
- `SUPABASE_URL` – Supabase project URL (https://<project-ref>.supabase.co).
- `SUPABASE_ANON_KEY` – Supabase anon/public API key.
- `SUPABASE_SERVICE_ROLE_KEY` – Supabase service-role key (used only on the server/API layer).
- `SUPABASE_GOOGLE_REDIRECT_URL` – OAuth redirect destination (e.g. `https://your-domain.com/` or local `http://localhost:3000/`).

## Demo login

The local fallback (when Supabase credentials are omitted) ships with a demo account:

- **Email:** `30.sc350@gmail.com`
- **Password:** `12341234`

When running against Supabase, create an auth user with the same credentials and execute `supabase/seed.sql` so the corresponding staff profile is provisioned automatically.

## Supabase Google OAuth setup

1. **Enable Google provider** – In Supabase Console go to **Authentication → Providers**, enable Google, and set the OAuth consent screen credentials in Google Cloud. Configure the Google redirect URI to `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Configure redirect URLs** – In **Authentication → URL Configuration**, add your production domain, preview URLs, and `http://localhost:3000` to the `Site URL` and `Redirect URLs` lists.
3. **Expose the anon key to the client** – Ensure `SUPABASE_URL` and `SUPABASE_ANON_KEY` are available to the frontend (Vercel project environment variables). The Google login button consumes these values to launch `signInWithOAuth` directly from the browser.
4. **Server credentials** – Keep `SUPABASE_SERVICE_ROLE_KEY` restricted to server-side execution only (API routes / local server) and never expose it in the browser.

After deploying, confirm that clicking **Google でログイン** navigates to `/auth/v1/authorize`, and that returning to the app yields a valid `supabase.auth.getUser()` response.

## API verification

Use the following `curl` commands (adjusting domain and IDs) to verify the serverless functions respond with JSON during deployments:

```bash
curl -sS https://<your-domain>/api/state
curl -sS "https://<your-domain>/api/file-stores?officeId=<uuid>"
curl -sS -X POST "https://<your-domain>/api/file-stores" \
  -H "Content-Type: application/json" \
  -d '{"officeId":"<uuid>","displayName":"Example Store","description":"demo"}'
curl -sS "https://<your-domain>/api/documents?fileStoreId=<uuid>"
curl -sS -X POST "https://<your-domain>/api/documents" \
  -H "Content-Type: application/json" \
  -d '{"fileStoreId":"<uuid>","geminiFileName":"files/demo","displayName":"Spec.pdf","sizeBytes":12345,"mimeType":"application/pdf"}'
```

Each endpoint should return `application/json` responses for both success and error cases (e.g., 4xx/5xx).
