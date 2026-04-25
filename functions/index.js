/**
 * KoiMoonTrades — Cloud Functions
 *
 * Two callables:
 *   submitForm         — public; handles contact + lead-magnet form posts
 *   claimAdminIfMatch  — auth-required; grants admin custom claim if the
 *                        signed-in user's email matches ADMIN_EMAIL secret
 *
 * Required secrets (set with `firebase functions:secrets:set NAME`):
 *   RESEND_API_KEY  — Resend API key (https://resend.com)
 *   ADMIN_EMAIL     — the email address of the single admin (Shamoon's login)
 *
 * Optional Firestore document at `settings/site`:
 *   recipientEmail (string)  — where notification emails go
 *   fromAddress    (string)  — "Koi Moon <hello@yourdomain.com>" once verified
 *   pdfUrl         (string)  — set automatically when admin uploads the PDF
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const ADMIN_EMAIL = defineSecret("ADMIN_EMAIL");

const DEFAULT_FROM = "Koi Moon Trades <onboarding@resend.dev>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

// ---------- email helper ----------
async function sendEmail({ to, subject, html, replyTo, from }) {
  const apiKey = RESEND_API_KEY.value();
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from || DEFAULT_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: replyTo,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------- input sanitisers ----------
function clean(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}
function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---------- exports ----------

/**
 * submitForm — public form submission handler.
 * Accepts: { source, name, email, message?, service? }
 * source ∈ { "contact", "lead_magnet" }
 */
exports.submitForm = onCall(
  { secrets: [RESEND_API_KEY], cors: true },
  async (request) => {
    const data = request.data || {};
    const source = clean(data.source, 32);
    const name = clean(data.name, 200);
    const email = clean(data.email, 200).toLowerCase();
    const message = clean(data.message, 5000);
    const service = clean(data.service, 200);

    if (!isEmail(email)) {
      throw new HttpsError("invalid-argument", "A valid email is required.");
    }
    if (source !== "contact" && source !== "lead_magnet") {
      throw new HttpsError("invalid-argument", "Unknown source.");
    }

    const db = getFirestore();
    const settingsSnap = await db.doc("settings/site").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const recipientEmail = settings.recipientEmail || null;
    const fromAddress = settings.fromAddress || DEFAULT_FROM;
    const pdfUrl = settings.pdfUrl || null;

    if (!recipientEmail || !isEmail(recipientEmail)) {
      console.warn("submitForm: recipientEmail not configured");
      // Still save the lead so it isn't lost; surface a soft error.
    }

    // 1. Save the lead.
    const leadRef = await db.collection("leads").add({
      source,
      name: name || null,
      email,
      message: message || null,
      service: service || null,
      userAgent: request.rawRequest?.headers?.["user-agent"] || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    // 2. Build the notification + auto-reply.
    const adminSubject =
      source === "lead_magnet"
        ? `New lead magnet signup — ${name || email}`
        : `New contact message — ${name || email}`;
    const userSubject =
      source === "lead_magnet"
        ? "Your Trader's Field Guide is here."
        : "Got it — Koi Moon Trades";

    const sendResults = await Promise.allSettled([
      recipientEmail
        ? sendEmail({
            to: recipientEmail,
            subject: adminSubject,
            html: renderAdminEmail({ source, name, email, message, service }),
            replyTo: email,
            from: fromAddress,
          })
        : Promise.resolve({ skipped: true }),
      sendEmail({
        to: email,
        subject: userSubject,
        html: renderUserEmail({ source, name, pdfUrl }),
        from: fromAddress,
      }),
    ]);

    const failures = sendResults
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.status === "rejected");
    if (failures.length) {
      console.error("Email failures:", failures.map((f) => String(f.r.reason)));
    }

    return {
      ok: true,
      leadId: leadRef.id,
      emailDelivered: failures.length === 0,
    };
  }
);

/**
 * claimAdminIfMatch — call this after a fresh login. If the signed-in
 * user's email matches ADMIN_EMAIL, set the {admin: true} custom claim.
 * The client must then refresh the ID token to pick up the claim.
 */
exports.claimAdminIfMatch = onCall(
  { secrets: [ADMIN_EMAIL] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in.");
    }
    const adminEmail = (ADMIN_EMAIL.value() || "").toLowerCase().trim();
    const userEmail = (request.auth.token.email || "").toLowerCase().trim();
    const alreadyAdmin = !!request.auth.token.admin;

    if (!adminEmail) {
      throw new HttpsError(
        "failed-precondition",
        "ADMIN_EMAIL secret is not set."
      );
    }
    if (userEmail !== adminEmail) {
      throw new HttpsError("permission-denied", "Not authorized.");
    }

    if (!alreadyAdmin) {
      await getAuth().setCustomUserClaims(request.auth.uid, { admin: true });
    }
    return { ok: true, admin: true, refreshRequired: !alreadyAdmin };
  }
);

// ---------- email templates ----------
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}

function renderAdminEmail({ source, name, email, message, service }) {
  const sourceLabel =
    source === "lead_magnet" ? "Lead Magnet · Field Guide" : "Contact Form";
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#fff;border:1px solid #e2e4e8;border-radius:8px;padding:32px;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#d4a04a;margin-bottom:16px;font-weight:600;">
        New Submission · ${escapeHtml(sourceLabel)}
      </div>
      <h2 style="font-size:24px;margin:0 0 20px;color:#040810;font-weight:700;">
        ${escapeHtml(name || email)}
      </h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#6a7a8a;width:96px;">Name</td><td style="padding:8px 0;color:#040810;">${escapeHtml(name || "—")}</td></tr>
        <tr><td style="padding:8px 0;color:#6a7a8a;">Email</td><td style="padding:8px 0;"><a href="mailto:${escapeHtml(email)}" style="color:#d4a04a;text-decoration:none;">${escapeHtml(email)}</a></td></tr>
        ${service ? `<tr><td style="padding:8px 0;color:#6a7a8a;">Interested</td><td style="padding:8px 0;color:#040810;">${escapeHtml(service)}</td></tr>` : ""}
        ${message ? `<tr><td style="padding:8px 0;color:#6a7a8a;vertical-align:top;">Message</td><td style="padding:8px 0;color:#040810;white-space:pre-wrap;">${escapeHtml(message)}</td></tr>` : ""}
      </table>
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e4e8;font-size:12px;color:#6a7a8a;">
        Reply directly to this email — the visitor will receive your response.
      </div>
    </div>
  </div>
</body></html>`;
}

function renderUserEmail({ source, name, pdfUrl }) {
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  if (source === "lead_magnet") {
    const linkBlock = pdfUrl
      ? `<div style="text-align:center;margin:32px 0;">
          <a href="${escapeHtml(pdfUrl)}" style="display:inline-block;background:#d4a04a;color:#040810;padding:14px 28px;border-radius:2px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;font-size:13px;text-decoration:none;">
            Download The PDF
          </a>
        </div>`
      : `<div style="background:#111a30;border-left:3px solid #d4a04a;padding:16px;font-size:14px;color:#c0d0e0;margin:24px 0;border-radius:2px;">
          The download link is being prepared — you'll receive a follow-up email shortly.
        </div>`;
    return `<!doctype html>
<html><body style="margin:0;padding:0;background:#040810;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#0a1020;border:1px solid #1a2a3a;border-radius:8px;padding:40px 32px;color:#e8e4df;">
      <div style="font-size:22px;letter-spacing:0.04em;font-weight:700;margin-bottom:24px;">
        Koi<span style="color:#d4a04a;">Moon</span>Trades
      </div>
      <h1 style="font-size:30px;line-height:1.1;margin:0 0 16px;color:#e8e4df;font-weight:700;">
        Your Field Guide is here.
      </h1>
      <p style="font-size:16px;line-height:1.7;color:#e8e4df;margin:0 0 20px;">${greeting}</p>
      <p style="font-size:16px;line-height:1.7;color:#e8e4df;margin:0 0 20px;">
        Thanks for grabbing The Trader's Field Guide. The download is below — bookmark it and read it before your next trade.
      </p>
      ${linkBlock}
      <p style="font-size:16px;line-height:1.7;color:#e8e4df;margin:0 0 12px;">
        If a question comes up while you're reading, hit reply. Every email gets a real response.
      </p>
      <p style="font-size:16px;line-height:1.7;color:#e8e4df;margin:0;">— Koi Moon</p>
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1a2a3a;font-size:12px;color:#6a7a8a;line-height:1.6;">
        Trading involves risk. Past performance does not guarantee future results. This is not financial advice.
      </div>
    </div>
  </div>
</body></html>`;
  }
  // contact auto-reply
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#040810;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#0a1020;border:1px solid #1a2a3a;border-radius:8px;padding:40px 32px;color:#e8e4df;">
      <div style="font-size:22px;letter-spacing:0.04em;font-weight:700;margin-bottom:24px;">
        Koi<span style="color:#d4a04a;">Moon</span>Trades
      </div>
      <h1 style="font-size:28px;line-height:1.1;margin:0 0 16px;font-weight:700;">Got it — talk soon.</h1>
      <p style="font-size:16px;line-height:1.7;margin:0 0 16px;">${greeting}</p>
      <p style="font-size:16px;line-height:1.7;margin:0 0 16px;">
        Your message is in the inbox. You'll hear back personally — usually within 24 hours, often sooner.
      </p>
      <p style="font-size:16px;line-height:1.7;margin:0;">— Koi Moon</p>
      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #1a2a3a;font-size:12px;color:#6a7a8a;line-height:1.6;">
        Trading involves risk. Past performance does not guarantee future results. This is not financial advice.
      </div>
    </div>
  </div>
</body></html>`;
}
