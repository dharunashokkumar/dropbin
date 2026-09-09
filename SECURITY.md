# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/dharunashokkumar/dropbin/security/advisories/new)
(Security → Advisories → Report a vulnerability on this repository).

Include what you can of: the affected version or commit, whether it is the
Worker or the `dropbin` npm package, a minimal reproduction, and what an
attacker gets out of it. You will get an acknowledgement within a few days, and
a fix or an explanation of why it is out of scope. Please give a reasonable
window before disclosing publicly.

## What is supported

| What | Supported |
|---|---|
| `main` of this repository, redeployed | ✅ |
| The latest `dropbin` release on npm | ✅ |
| Anything older, or a fork you have changed | ❌ |

There are no long-lived release branches. A fix lands on `main`, and the Worker
side of it is live for you only once **you** redeploy your own instance.

## The threat model

dropbin is a single-tenant drop box. **One password gates everything.** There
are no accounts, no roles and no per-file permissions, and there is no attempt
to keep one user's uploads from another's — everyone who has the password is
the same person as far as the tool is concerned.

What the design does defend:

- **Nothing is listable.** There is no browse, search or index path, and no
  endpoint returns more than one pin. A pin is 4 digits by default, so treat a
  pin as a handle, not a secret — the password is what protects the contents.
- **The password is never stored in the clear anywhere.** The `dp` cookie holds
  `sha256("dropbin:" + password)`, and comparison is length-checked constant
  time (`eq()` in `src/util.js`). `db` writes nothing at all: no config file, no
  token cache.
- **Uploaded bytes cannot act on the origin.** Every file-serving path sends
  `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so
  an uploaded `.html` or `.svg` renders inert. Preserve both headers on any new
  file-serving path.
- **Share links are narrow.** `?k=<expiry>.<hmac>` is an HMAC-SHA256 of
  `"dropbin/" + pin + "/" + exp`, keyed on the password. A holder reaches
  `download()` for that one pin and nothing else — no `/up`, no `DELETE`, no
  other pin, no home page — and only with `GET`/`HEAD`. Nothing is stored;
  `shared()` recomputes it.
- **Nothing is indexed.** Every response carries `X-Robots-Tag: noindex,
  nofollow` and `/robots.txt` disallows everything.

What it does **not** defend, by design:

- Anyone with the password can read, replace and delete every pin.
- A pin is guessable. 9000 four-digit pins exist; someone with the password can
  walk them. The password is the only boundary.
- A share link is a bearer URL. Whoever holds it can read that pin until it
  expires, and an individual link cannot be revoked — only changing the
  password invalidates outstanding links (and every browser cookie with them).
- There is no scanning of uploaded content, and no abuse or malware handling.
  You are hosting arbitrary bytes on your own domain.

## Hardening your deployment

- **Set a real password before the URL is anywhere.** With no secret set the
  Worker falls back to `changeme` in code, and a stranger can upload to and
  delete from your bucket. Verify what is actually live — `wrangler secret list`
  only ever shows *names*:

  ```sh
  curl -o /dev/null -w '%{http_code}\n' -H "X-Pass: YOUR_PASSWORD" https://host/?info=1
  ```

  `wrangler secret put` reads stdin when it is not a tty and accepts an empty
  value silently, printing the same "✨ Success!", so set it as
  `printf 'PASS' | npx wrangler secret put ACCESS_PASSWORD` and prove it with
  the curl above. Note also that a secret cannot override a `[vars]` entry of
  the same name — Wrangler refuses to create it — which is why
  `ACCESS_PASSWORD` is deliberately absent from `wrangler.toml`.

- **Prefer the header or the cookie over `?p=`.** The password is accepted four
  ways: `?p=`, `X-Pass:`, HTTP basic auth, and the `dp` cookie. A query string
  ends up in browser history, in `Referer` on any outbound link, and in request
  logs — and `[observability]` is enabled in `wrangler.toml`. Use `?p=` for
  throwaway curl against a test instance, not in anything you paste around.

- **Put a rate limit in front of it.** The Worker does not throttle password
  attempts. A Cloudflare WAF rate-limiting rule on the hostname (say, 20
  requests per minute per IP with a 401 response) turns a single shared password
  from brute-forceable into merely guessable. Choose a long password.

- **Deploy on a subdomain, not the apex.** You are serving files people upload.
  A dedicated `files.example.com` keeps the `dp` cookie and any sandbox escape
  away from the rest of your site.

- **Rotate by changing the password.** That invalidates every `dp` cookie (one
  year, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS) and every outstanding
  `db open` / `db qr` link at once, since both are derived from it.

- **Remember there is no expiry.** Files live until you `DELETE` them, and
  `QUOTA_GB` is a display figure, not a cap — R2 keeps accepting uploads past
  it and starts billing.

## In scope / out of scope

In scope: auth bypass; reaching a pin without the password or a valid `?k=`; a
share link that reads more than its one pin or outlives `SHARE_HOURS`; path
traversal out of a pin prefix; stored XSS or a sandbox escape from an uploaded
file; anything that leaks the password out of the Worker or the clients; a
supply-chain problem in the `dropbin` npm package.

Out of scope: anything that requires the password already; brute-forcing a weak
password you chose; guessing a pin *with* the password; missing rate limiting on
a deployment with no WAF rule (documented above); denial of service by uploading
until the bill hurts; a deployment still running `changeme`.
