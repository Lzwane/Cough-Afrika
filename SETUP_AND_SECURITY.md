# Setup (5 steps)
1. **Key:** open `config.js`, paste your FULL publishable key (the one in your old app.js was cut off with `...`). Never use the `service_role`/secret key in the browser.
2. **Database:** Supabase → SQL Editor → run `supabase/schema.sql`.
3. **Owner login:** Authentication → Users → *Add user* (strong password) → run the `insert into public.owners …` line at the bottom of schema.sql. Then Authentication → Providers → Email → turn **off** "Allow new users to sign up" and turn on leaked-password protection / MFA if available.
4. **Host over HTTPS** (needed for the microphone and password hashing). On Netlify/Cloudflare Pages `_headers` applies automatically; on other hosts copy those headers into the server config (`frame-ancestors` and HSTS cannot be set from HTML).
5. **Owner portal:** footer → "Owner portal" (or `yoursite/#owner`).

# What protects the data
- Real protection = Row Level Security in Supabase. The public key in the page is meant to be public. Visitors can only INSERT a row with consent ticked; only owners can read/annotate/delete.
- No inline scripts/handlers + CSP; all patient text is rendered with `textContent` (stored-XSS fixed).
- Owner session lives in sessionStorage (dies with the tab) and auto-signs-out after 15 min idle.
- Patient accounts are device-local convenience logins (now salted PBKDF2). They are not a security boundary.

# Still on you
- Add Subresource Integrity to the Supabase script, or better, download `supabase.js` into the site and load it from `'self'`: `curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js | openssl dgst -sha384 -binary | openssl base64 -A` → `integrity="sha384-…"`.
- Anyone can still *submit* (fake) records with the public key. Turn on Supabase rate limits / CAPTCHA if abuse appears.
- Health data = "special personal information" under POPIA. Have the privacy policy text reviewed, name an Information Officer, and set a retention period.
- The contact form does not send anything yet, and the footer email `medicodecure@gmali.com` looks like a typo for gmail.com.
