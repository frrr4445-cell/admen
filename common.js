const admin = require("firebase-admin");
const crypto = require("crypto");
let adminServices;

function getAdmin() {
  if (adminServices) return adminServices;
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
    let serviceAccount;
    try { serviceAccount = JSON.parse(raw); }
    catch { throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must be valid JSON"); }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  const db = admin.firestore();
  adminServices = { auth: admin.auth(), db, FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp };
  return adminServices;
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

async function requireUser(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw httpError(401, "يجب تسجيل الدخول أولاً.");
  const { auth } = getAdmin();
  let decoded;
  try { decoded = await auth.verifyIdToken(match[1], true); }
  catch { throw httpError(401, "جلسة الدخول غير صالحة. سجّل الدخول مجدداً."); }
  if (String(process.env.ENFORCE_APP_CHECK || "").toLowerCase() === "true") {
    const appCheckToken = req.headers["x-firebase-appcheck"];
    if (!appCheckToken) throw httpError(401, "تعذر التحقق من سلامة التطبيق. حدّث الصفحة وحاول مجدداً.");
    try { await admin.appCheck().verifyToken(appCheckToken); }
    catch { throw httpError(401, "رمز التحقق من التطبيق غير صالح."); }
  }
  return decoded;
}

function method(req, allowed = "POST") {
  if (req.method !== allowed) throw httpError(405, "Method not allowed");
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients still require Firebase authentication on user routes
  let parsed;
  try { parsed = new URL(origin); } catch { throw httpError(403, "مصدر الطلب غير مسموح."); }
  const allowed = new Set();
  for (const value of [process.env.PUBLIC_APP_URL, ...(process.env.ALLOWED_ORIGINS || "").split(",")]) {
    if (!value) continue;
    try { allowed.add(new URL(value.trim()).origin); } catch {}
  }
  if (process.env.VERCEL_URL) allowed.add(`https://${process.env.VERCEL_URL}`);
  if (!allowed.has(parsed.origin)) throw httpError(403, "مصدر الطلب غير مسموح.");
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.headers["x-real-ip"] || "unknown");
}

// Firestore-backed fixed-window limits apply across Vercel instances. Configure TTL on expiresAt
// for automatic document cleanup. This is a safety guard, not a substitute for an edge WAF.
async function enforceRateLimit(req, uid, scope, limit, windowMs) {
  const { db, Timestamp } = getAdmin();
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const ip = clientIp(req);
  const makeRef = value => db.collection("apiRateLimits").doc(crypto.createHash("sha256").update(`${scope}|${value}|${windowStart}`).digest("hex"));
  const refs = [makeRef(`ip:${ip}`), makeRef(`user:${uid || "anonymous"}`)];
  await db.runTransaction(async tx => {
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
    const counts = snaps.map(snap => Number(snap.exists ? snap.data().count : 0));
    if (counts.some(count => count >= limit)) throw httpError(429, "تم تجاوز عدد المحاولات المسموح. حاول بعد قليل.");
    refs.forEach((ref, index) => tx.set(ref, { scope, count: counts[index] + 1, expiresAt: Timestamp.fromMillis(windowStart + windowMs * 2), updatedAt: Timestamp.now() }, { merge: true }));
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
  }
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted) throw httpError(504, "انتهت مهلة الاتصال بالخدمة الخارجية. حاول مجدداً.");
    throw error;
  } finally { clearTimeout(timer); }
}

function sendError(res, error) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error("Travel Touch API error:", error?.message || "unknown");
  return res.status(status).json({ error: status >= 500 ? "حدث خطأ في الخادم. حاول مرة أخرى." : error.message });
}
function paypalBase() {
  const env = process.env.PAYPAL_ENV || "sandbox";
  if (env === "sandbox") return "https://api-m.sandbox.paypal.com";
  if (env === "live") return "https://api-m.paypal.com";
  throw new Error("PAYPAL_ENV must be sandbox or live");
}
let cachedPaypalToken = null, paypalTokenExpiresAt = 0;
async function paypalToken() {
  if (cachedPaypalToken && paypalTokenExpiresAt > Date.now() + 60_000) return cachedPaypalToken;
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal credentials are not configured");
  const r = await fetchWithTimeout(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  }, 8000);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw httpError(502, "تعذر الاتصال ببوابة PayPal.");
  cachedPaypalToken = d.access_token;
  paypalTokenExpiresAt = Date.now() + Math.max(60, Number(d.expires_in || 300)) * 1000;
  return cachedPaypalToken;
}
async function paypalRequest(path, options = {}) {
  const token = await paypalToken();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;
  const r = await fetchWithTimeout(`${paypalBase()}${path}`, { method: options.method || "GET", headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }, options.timeoutMs || 12000);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("PayPal API failure", r.status); throw httpError(502, "تعذر إكمال طلب PayPal حالياً."); }
  return d;
}
module.exports = { admin, getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, fetchWithTimeout, sendError, paypalBase, paypalToken, paypalRequest, httpError };
