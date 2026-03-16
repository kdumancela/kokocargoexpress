const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
const webpush   = require("web-push");
const fs        = require("fs");
const path      = require("path");

// ── Environment variables (stored as GitHub Secrets) ──────────────────────
const EMAIL_USER    = process.env.EMAIL_USER;
const EMAIL_PASS    = process.env.EMAIL_PASS;
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_CONTACT = `mailto:${NOTIFY_EMAIL}`;

// ── Status codes that trigger a notification ───────────────────────────────
const ALERT_CODES = {
  CCD: "Cleared by Customs",
  DLV: "Delivered"
};

// ── Business hours check (Mon–Sat, 9am–7pm ET) ────────────────────────────
function isBusinessHours() {
  const now = new Date();
  // Convert to Eastern Time
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();   // 0=Sun, 1=Mon ... 6=Sat
  const hour = et.getHours(); // 0–23
  const isWeekday = day >= 1 && day <= 6; // Mon–Sat
  const isHours   = hour >= 9 && hour < 19; // 9am–7pm
  return isWeekday && isHours;
}

if (!isBusinessHours()) {
  console.log("Outside business hours (Mon–Sat 9am–7pm ET). Exiting.");
  process.exit(0);
}

// ── Load watchlist ─────────────────────────────────────────────────────────
const watchlistPath = path.join(__dirname, "..", "watchlist.json");
const watchlist = JSON.parse(fs.readFileSync(watchlistPath, "utf8"));

if (!watchlist.shipments || watchlist.shipments.length === 0) {
  console.log("No shipments being watched. Exiting.");
  process.exit(0);
}

console.log(`Checking ${watchlist.shipments.length} shipment(s)...`);

// ── Web push setup ─────────────────────────────────────────────────────────
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Email transporter ──────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// ── Scrape one MAWB from AGI ONE ───────────────────────────────────────────
async function scrapeMAWB(browser, mawb) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    );

    console.log(`  → Scraping ${mawb}`);
    await page.goto("https://one.allianceground.com/#/cargo/awb-tracking", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Wait for page to fully load the Angular app
    await page.waitForSelector("input", { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1500));

    // Type MAWB into first visible text input (strip dashes)
    const mawbClean = mawb.replace(/-/g, "");
    await page.evaluate((val) => {
      const inputs = Array.from(document.querySelectorAll("input"))
        .filter(el => el.offsetParent !== null && el.type !== "checkbox" && el.type !== "radio");
      if (inputs[0]) {
        inputs[0].focus();
        inputs[0].value = val;
        inputs[0].dispatchEvent(new Event("input",  { bubbles: true }));
        inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, mawbClean);

    await new Promise(r => setTimeout(r, 500));

    // Click the Search button
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const searchBtn = btns.find(b =>
        b.textContent.trim().toUpperCase().includes("SEARCH") || b.type === "submit"
      );
      if (searchBtn) searchBtn.click();
    });

    // Wait for results
    await page.waitForSelector("table tbody tr", { timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    // Extract all status rows
    const statuses = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tbody tr"));
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll("td")).map(c => c.textContent.trim());
        return {
          origin:    cells[0] || "",
          dest:      cells[1] || "",
          flight:    cells[2] || "",
          status:    cells[3] || "",
          code:      cells[4] || "",
          eventDate: cells[5] || "",
          eventTime: cells[6] || "",
          pieces:    cells[7] || "",
          weight:    cells[8] || ""
        };
      }).filter(r => r.code);
    });

    console.log(`     Found ${statuses.length} status rows`);
    return { mawb, statuses, error: null };

  } catch (err) {
    console.error(`  ✗ Error scraping ${mawb}: ${err.message}`);
    return { mawb, statuses: [], error: err.message };
  } finally {
    await page.close();
  }
}

// ── Send email notification ────────────────────────────────────────────────
async function sendEmail(mawb, code, row) {
  if (!EMAIL_USER || !EMAIL_PASS || !NOTIFY_EMAIL) return;
  const label = ALERT_CODES[code];
  const isDelivered = code === "DLV";
  const color = isDelivered ? "#1a6b3a" : "#1a3a8f";
  const emoji = isDelivered ? "🚚" : "✅";

  await transporter.sendMail({
    from: `"Cargo Tracker" <${EMAIL_USER}>`,
    to: NOTIFY_EMAIL,
    subject: `${emoji} ${mawb} — ${label}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;">
        <div style="background:${color};color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
          <p style="margin:0;font-size:13px;opacity:.8;letter-spacing:1px;text-transform:uppercase;">Cargo Status Alert</p>
          <h1 style="margin:6px 0 0;font-size:24px;">${emoji} ${label}</h1>
        </div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;">
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;width:140px;">MAWB</td>
              <td style="padding:12px 24px;font-weight:bold;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:16px;">${mawb}</td></tr>
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;">Status Code</td>
              <td style="padding:12px 24px;border-bottom:1px solid #f0f0f0;"><span style="background:#eef2ff;color:#1a3a8f;padding:2px 10px;border-radius:4px;font-family:monospace;">${code}</span></td></tr>
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;">Date &amp; Time</td>
              <td style="padding:12px 24px;border-bottom:1px solid #f0f0f0;">${row.eventDate} at ${row.eventTime}</td></tr>
          <tr><td style="padding:12px 24px;color:#666;border-bottom:1px solid #f0f0f0;">Flight</td>
              <td style="padding:12px 24px;border-bottom:1px solid #f0f0f0;">${row.flight}</td></tr>
          <tr><td style="padding:12px 24px;color:#666;">Route</td>
              <td style="padding:12px 24px;">${row.origin} → ${row.dest}</td></tr>
        </table>
        <p style="color:#999;font-size:12px;text-align:center;margin-top:16px;">
          Cargo Tracker · checked automatically every hour Mon–Sat 9am–7pm ET
        </p>
      </div>
    `
  });
  console.log(`  ✉  Email sent for ${mawb} (${code})`);
}

// ── Send browser push notification ────────────────────────────────────────
async function sendPush(mawb, code) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  if (!watchlist.pushSubscriptions || watchlist.pushSubscriptions.length === 0) return;

  const label = ALERT_CODES[code];
  const payload = JSON.stringify({
    title: `${code === "DLV" ? "🚚" : "✅"} ${mawb} — ${label}`,
    body:  `Your cargo has reached: ${label}`,
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
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  let watchlistChanged = false;

  for (const shipment of watchlist.shipments) {
    const { mawb, statuses, error } = await scrapeMAWB(browser, shipment.mawb);

    if (error) {
      shipment.lastError = error;
      shipment.lastChecked = new Date().toISOString();
      watchlistChanged = true;
      continue;
    }

    // Update last checked + latest statuses
    shipment.lastChecked = new Date().toISOString();
    shipment.lastStatuses = statuses;
    shipment.lastError = null;
    watchlistChanged = true;

    // Check for alert-worthy status codes we haven't notified about yet
    const alreadyNotified = shipment.notifiedCodes || [];

    for (const row of statuses) {
      const code = row.code.trim().toUpperCase();
      if (ALERT_CODES[code] && !alreadyNotified.includes(code)) {
        console.log(`  🚨 Alert triggered: ${mawb} → ${code} (${ALERT_CODES[code]})`);
        await sendEmail(mawb, code, row);
        await sendPush(mawb, code);
        alreadyNotified.push(code);
      }
    }

    shipment.notifiedCodes = alreadyNotified;

    // Mark complete if DLV found
    if (alreadyNotified.includes("DLV")) {
      shipment.completed = true;
      console.log(`  ✓ ${mawb} marked complete`);
    }
  }

  await browser.close();

  // Remove completed shipments older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  watchlist.shipments = watchlist.shipments.filter(s => {
    if (!s.completed) return true;
    const checkedAt = new Date(s.lastChecked).getTime();
    return checkedAt > cutoff;
  });

  // Save updated watchlist back to file
  if (watchlistChanged) {
    fs.writeFileSync(watchlistPath, JSON.stringify(watchlist, null, 2));
    console.log("Watchlist saved.");
  }

  console.log("Done.");
})();
