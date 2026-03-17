const nodemailer = require("nodemailer");
const webpush    = require("web-push");
const fs         = require("fs");
const path       = require("path");

// ── Environment variables ──────────────────────────────────────────────────
const EMAIL_USER    = process.env.EMAIL_USER;
const EMAIL_PASS    = process.env.EMAIL_PASS;
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_CONTACT = `mailto:${NOTIFY_EMAIL}`;

// ── SMS recipients (iMessage via email) ───────────────────────────────────
const SMS_RECIPIENTS = [
  "9174994082@imessage.apple.com",
  "7187305317@imessage.apple.com"
];

// ── Alert codes ───────────────────────────────────────────────────────────
const ALERT_CODES = {
  CCD: "Documentos procesados por Bombino",
  DLV: "Carga en tránsito a CES por Bombino"
};

// ── Business hours check (Mon–Sat, 9am–7pm ET) ────────────────────────────
function isBusinessHours() {
  const et   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();
  const hour = et.getHours();
  return day >= 1 && day <= 6 && hour >= 9 && hour < 19;
}

if (!isBusinessHours()) {
  console.log("Outside business hours (Mon–Sat 9am–7pm ET). Exiting.");
  process.exit(0);
}

// ── Load watchlist ────────────────────────────────────────────────────────
const watchlistPath = path.join(__dirname, "..", "watchlist.json");
const watchlist     = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));

if (!watchlist.shipments || watchlist.shipments.length === 0) {
  console.log("No shipments in watchlist. Exiting.");
  process.exit(0);
}

console.log(`Checking ${watchlist.shipments.length} shipment(s)...`);

// ── Web push setup ────────────────────────────────────────────────────────
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Email transporter ─────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// ── Fetch MAWB status from AGI ONE API ────────────────────────────────────
async function fetchMAWB(mawb) {
  const digits  = mawb.replace(/-/g, "");
  const setting = encodeURIComponent(JSON.stringify({
    timezone: "America/New_York",
    fromAdmin: true,
    appMode: "iadmin",
    locale: "en"
  }));
  const url = `https://one-prod.allianceground.com/api/cargo/v1/awb-tracking/${digits}?setting=${setting}`;

  try {
    console.log(`  → Fetching ${mawb}`);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://one.allianceground.com",
        "Referer": "https://one.allianceground.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      },
      body: JSON.stringify({ key: digits })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json     = await res.json();
    const segments = json?.data?.segments || [];

    const statuses = segments.map(s => ({
      origin:    s.origin    || "",
      dest:      s.dest      || "",
      flight:    s.flightNum || "",
      status:    s.status    || "",
      code:      s.statusCode || "",
      eventDate: s.eventDate || "",
      eventTime: s.eventTime || "",
      pieces:    s.numPieces  || "",
      weight:    s.weight    || ""
    })).filter(s => s.code);

    console.log(`     Found ${statuses.length} status rows`);
    return { mawb, statuses, error: null };

  } catch (err) {
    console.error(`  ✗ Error fetching ${mawb}: ${err.message}`);
    return { mawb, statuses: [], error: err.message };
  }
}

// ── Send email notification ───────────────────────────────────────────────
async function sendEmail(mawb, code, row) {
  if (!EMAIL_USER || !EMAIL_PASS || !NOTIFY_EMAIL) return;
  const isDelivered = code === "DLV";
  const color   = isDelivered ? "#1a5c28" : "#1a3a8f";
  const subject = `MAWB ${mawb}`;
  const heading = isDelivered
    ? "Carga en tránsito a CES"
    : "Documentos procesados. Carga preparándose para traslado a CES";

  await transporter.sendMail({
    from: `"Cargo Tracker by Koko Cargo Express" <${EMAIL_USER}>`,
    to: NOTIFY_EMAIL,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;">
        <div style="background:${color};color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
          <p style="margin:0;font-size:12px;opacity:.75;letter-spacing:1px;text-transform:uppercase;">Alerta de Carga — Koko Cargo Express</p>
          <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3;">${heading}</h1>
        </div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;">
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;width:140px;">MAWB</td>
              <td style="padding:12px 24px;font-weight:bold;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:16px;">${mawb}</td></tr>
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;">Código</td>
              <td style="padding:12px 24px;border-bottom:1px solid #f0f0f0;"><span style="background:#eef2ff;color:#1a3a8f;padding:2px 10px;border-radius:4px;font-family:monospace;">${code}</span></td></tr>
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;">Fecha / Hora</td>
              <td style="padding:12px 24px;border-bottom:1px solid #f0f0f0;">${row.eventDate} a las ${row.eventTime}</td></tr>
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;">Vuelo</td>
              <td style="padding:12px 24px;border-bottom:1px solid #f0f0f0;">${row.flight}</td></tr>
          <tr><td style="padding:12px 24px;color:#666;">Ruta</td>
              <td style="padding:12px 24px;">${row.origin} → ${row.dest}</td></tr>
        </table>
        <p style="color:#999;font-size:12px;text-align:center;margin-top:16px;">
          Koko Cargo Express · verificación automática cada hora Lun–Sáb 9am–7pm ET
        </p>
      </div>
    `
  });
  console.log(`  ✉  Email sent for ${mawb} (${code})`);
}

// ── Send SMS via AT&T email-to-text ───────────────────────────────────────
async function sendSMS(mawb, code) {
  if (!EMAIL_USER || !EMAIL_PASS) return;
  const text = code === "DLV"
    ? `MAWB ${mawb} — Carga en tránsito a CES por Bombino.`
    : `MAWB ${mawb} — Documentos procesados por Bombino.`;

  for (const number of SMS_RECIPIENTS) {
    try {
      await transporter.sendMail({
        from: EMAIL_USER,
        to: number,
        subject: "",
        text
      });
      console.log(`  📱 SMS sent to ${number}`);
    } catch (err) {
      console.warn(`  SMS failed to ${number}: ${err.message}`);
    }
  }
}

// ── Send browser push notification ────────────────────────────────────────
async function sendPush(mawb, code) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  if (!watchlist.pushSubscriptions?.length) return;

  const payload = JSON.stringify({
    title: `${mawb} — ${ALERT_CODES[code]}`,
    body:  ALERT_CODES[code],
    tag:   `cargo-${mawb}-${code}`
  });

  for (const sub of watchlist.pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      console.log(`  🔔 Push sent for ${mawb} (${code})`);
    } catch (err) {
      console.warn(`  Push failed: ${err.message}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  let changed = false;

  for (const shipment of watchlist.shipments) {
    const { mawb, statuses, error } = await fetchMAWB(shipment.mawb);

    shipment.lastChecked = new Date().toISOString();
    shipment.lastError   = error || null;
    changed = true;

    if (error) continue;

    shipment.lastStatuses = statuses;

    const alreadyNotified = shipment.notifiedCodes || [];

    for (const row of statuses) {
      const code = row.code.trim().toUpperCase();
      if (ALERT_CODES[code] && !alreadyNotified.includes(code)) {
        console.log(`  🚨 Alert: ${mawb} → ${code}`);
        await sendEmail(mawb, code, row);
        await sendSMS(mawb, code);
        await sendPush(mawb, code);
        alreadyNotified.push(code);
      }
    }

    shipment.notifiedCodes = alreadyNotified;

    if (alreadyNotified.includes("DLV")) {
      shipment.completed = true;
      console.log(`  ✓ ${mawb} marked complete`);
    }
  }

  // Remove completed shipments older than 24 hours
  watchlist.shipments = watchlist.shipments.filter(s => {
    if (!s.completed) return true;
    return (Date.now() - new Date(s.lastChecked).getTime()) < 24 * 60 * 60 * 1000;
  });

  if (changed) {
    fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
    console.log("Watchlist saved.");
  }

  console.log("Done.");
})();
