# Gemini Lounge

A monochrome single-page AI knowledge system that integrates Gemini File Search with Supabase-backed authentication.

## Environment variables

Create an `.env` file (or configure Vercel project variables) with the following keys:

- `GOOGLE_API_KEY` – Gemini API key.
- `SUPABASE_URL` – Supabase project URL (https://<project-ref>.supabase.co).
- `SUPABASE_ANON_KEY` – Supabase anon/public API key.
- `SUPABASE_SERVICE_ROLE_KEY` – Supabase service-role key (used only on the server/API layer).
- `SUPABASE_GOOGLE_REDIRECT_URL` – OAuth redirect destination (e.g. `https://your-domain.com/` or local `http://localhost:3000/`).

## Supabase Google OAuth setup

1. **Enable Google provider** – In Supabase Console go to **Authentication → Providers**, enable Google, and set the OAuth consent screen credentials in Google Cloud. Configure the Google redirect URI to `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Configure redirect URLs** – In **Authentication → URL Configuration**, add your production domain, preview URLs, and `http://localhost:3000` to the `Site URL` and `Redirect URLs` lists.
3. **Expose the anon key to the client** – Ensure `SUPABASE_URL` and `SUPABASE_ANON_KEY` are available to the frontend (Vercel project environment variables). The Google login button consumes these values to launch `signInWithOAuth` directly from the browser.
4. **Server credentials** – Keep `SUPABASE_SERVICE_ROLE_KEY` restricted to server-side execution only (API routes / local server) and never expose it in the browser.

After deploying, confirm that clicking **Google でログイン** navigates to `/auth/v1/authorize`, and that returning to the app yields a valid `supabase.auth.getUser()` response.

## Image uploads

画像ファイルをストアへアップロードすると、サーバー側で Gemini Vision を使って内容を解析し、解析結果をテキスト化したファイルとして File Search ストアへ保存します。解析の要約は Supabase のメタデータとアプリ上のステータスに反映されるため、後続のチャットからも File Search 経由で参照できます。オリジナルの画像は保存されず、Gemini が生成した説明文のみがストアに登録されます。
