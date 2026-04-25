# KoiMoonTrades — Admin Panel Setup

This guide walks you through standing up the admin panel + email pipeline.
**You only do this once.** After that, Shamoon just opens `/admin.html`,
signs in, and edits content.

> Project: `koi-moon`
> Admin URL after deploy: `https://<your-domain>/admin.html`

---

## 1. Prerequisites

- [x] Firebase Blaze (pay-as-you-go) plan enabled — required for Cloud
      Functions. You said this is already on.
- [x] Firebase CLI installed and logged in:
      ```bash
      npm install -g firebase-tools
      firebase login
      ```
- [x] Node.js 20+ installed locally (for the functions install step).

---

## 2. Create Shamoon's admin login

In the Firebase Console:

1. Open **Authentication → Sign-in method**.
2. Enable **Email/Password** (if it isn't already).
3. Open **Authentication → Users → Add user**.
4. Enter Shamoon's email and a strong temporary password. Hand him the
   credentials securely — he can change his password from inside Firebase
   Auth later (or you can wire a password-reset flow if needed).

> The email you set here must match the `ADMIN_EMAIL` secret you'll set
> below — that's how the app knows which account is allowed to administer.

---

## 3. Set up Resend (transactional email)

1. Sign up at <https://resend.com>. Free tier: 3,000 emails/month, 100/day.
2. Create an API key under **API Keys**. Copy it (starts with `re_…`).
3. **For now, keep using `onboarding@resend.dev`** as the sender — works
   immediately with no DNS setup. Emails will look slightly less polished
   but they'll deliver.
4. **Later (recommended):** verify a custom domain inside Resend
   (**Domains → Add Domain**). Resend gives you a few DNS records to add
   to whoever hosts `koimoontrades.com` (Cloudflare, Namecheap, etc.).
   Once verified, paste a fancier from-address into the admin panel:
   ```
   Koi Moon Trades <hello@koimoontrades.com>
   ```

---

## 4. Install function dependencies

```bash
cd functions
npm install
cd ..
```

---

## 5. Set the secrets

Two secrets are needed by the Cloud Functions:

```bash
firebase functions:secrets:set RESEND_API_KEY
# Paste the Resend API key when prompted, press Enter.

firebase functions:secrets:set ADMIN_EMAIL
# Paste Shamoon's exact email (the same one you created in Firebase Auth).
```

You can update either secret at any time by running the same command — it
just overwrites the value. Re-deploy after changing.

---

## 6. Deploy everything

From the project root:

```bash
firebase deploy
```

This deploys:

- **Hosting** — the static site (index.html, financial-literacy.html, admin.html)
- **Functions** — `submitForm` and `claimAdminIfMatch`
- **Firestore rules + indexes**
- **Storage rules**

If you only want to deploy a subset:

```bash
firebase deploy --only hosting
firebase deploy --only functions
firebase deploy --only firestore:rules
firebase deploy --only storage
```

---

## 7. First login & smoke test

1. Visit `https://<your-domain>/admin.html`.
2. Sign in with Shamoon's email + password.
3. The first sign-in triggers `claimAdminIfMatch` — this grants the
   `admin: true` custom claim to his account (because his email matches
   `ADMIN_EMAIL`). The page reloads / refreshes the auth token automatically.
4. Go to **Settings** and:
   - Set the **Recipient Email** (where form submissions are emailed —
     can be the same as the login email or a different inbox).
   - Optionally update the **From Address** if you've verified a custom
     domain in Resend.
5. Go to **Lead Magnet** and upload the PDF when Shamoon has it ready.
6. Edit hero / fundamentals / articles / CTA copy as desired. Click each
   section's **Save** button.
7. Open `/financial-literacy.html` in a separate tab and refresh — you
   should see the new content.
8. Submit the lead-magnet form with a test email — you should get:
   - A notification email at the recipient address.
   - An auto-reply at the test email with the PDF download link.
9. Submit the contact form on the homepage — same expected behavior.

---

## 8. Where everything lives

| File | What it does |
|---|---|
| `index.html` | Public homepage. Contact form posts to `submitForm` callable. |
| `financial-literacy.html` | Public library page. Reads content from Firestore on load (with hardcoded fallback). Lead-magnet form posts to `submitForm`. |
| `admin.html` | Admin panel. Firebase Auth gated. |
| `firestore.rules` | Public read on `/content`, admin-only writes. Leads admin-only. |
| `storage.rules` | Public read on `/lead-magnet/*` and `/public/*`. Admin-only writes. |
| `firestore.indexes.json` | Composite index for `leads` query. |
| `firebase.json` | Hosting + Functions + Firestore + Storage config. |
| `functions/index.js` | The two Cloud Functions. |
| `functions/package.json` | Function dependencies. |

---

## 9. Firestore data shapes

After Shamoon's first save, these documents exist:

- `settings/site`
  - `recipientEmail` (string)
  - `fromAddress` (string)
  - `pdfUrl` (string, set automatically when PDF uploaded)
  - `pdfFilename` (string)

- `content/hero` (single doc)
- `content/leadMagnet` (single doc, includes `bullets` array)
- `content/cta` (single doc)
- `content/fundamentals/items/{autoId}` — subcollection of cards
- `content/articles/items/{autoId}` — subcollection of articles

- `leads/{autoId}` — every form submission, written by the function.

---

## 10. Common operations

**Update Resend API key:**
```bash
firebase functions:secrets:set RESEND_API_KEY
firebase deploy --only functions
```

**Change which email is the admin:**
1. Create a new Auth user in Firebase Console.
2. `firebase functions:secrets:set ADMIN_EMAIL`
3. `firebase deploy --only functions`
4. The new account signs into `/admin.html` — the claim auto-applies.
5. Delete the old Auth user when ready.

**View function logs:**
```bash
firebase functions:log
```

**Test functions locally (optional):**
```bash
cd functions
npm run serve
```
This starts the emulator. Good for poking at submitForm without burning
real Resend credit.

---

## 11. Troubleshooting

**"This account isn't the configured admin"** on login.
Means the email Shamoon signed in with doesn't match `ADMIN_EMAIL`.
Reset the secret with the correct email and re-deploy functions.

**Lead magnet form says "Send Failed."**
Check `firebase functions:log`. Most likely:
- `RESEND_API_KEY` is unset or wrong.
- The from-address in settings uses an unverified domain.
- Recipient email in settings is empty.

**Public page is blank / shows defaults forever.**
Open browser devtools → Network tab. If `/__/firebase/init.json` 404s,
the site isn't being served by Firebase Hosting. Either deploy, or run
`firebase serve` locally to test.

**Storage upload fails for the PDF.**
Confirm the user is signed in as admin and that `storage.rules` were
deployed (`firebase deploy --only storage`). Files >25 MB are rejected.

---

## 12. Going live with a custom domain

1. Buy/own `koimoontrades.com`.
2. In Firebase Console → **Hosting → Add custom domain**, follow the
   verification + DNS steps.
3. In Resend, add the same domain and add their DNS records too (these
   are different records — they coexist with the Firebase ones).
4. Once Resend says "Verified," update **From Address** in the admin
   panel to something like `Koi Moon Trades <hello@koimoontrades.com>`.

Done. The same code is now sending fully-branded mail.
