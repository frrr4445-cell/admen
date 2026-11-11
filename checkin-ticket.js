const crypto = require("crypto");
const { getAdmin, requireUser, method, assertSameOrigin, sendError, httpError } = require("./_lib/common");
module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    const { db, FieldValue } = getAdmin();
    const adminDoc = await db.collection("admins").doc(user.uid).get();
    if (!adminDoc.exists) throw httpError(403, "تسجيل الوصول متاح لموظفي المنصة المخولين فقط.");
    const token = String(req.body?.token || "");
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some(p => p.length > 2048)) throw httpError(400, "رمز التذكرة غير صالح.");
    const secret = process.env.TICKET_SIGNING_SECRET;
    if (!secret || secret.length < 32) throw httpError(503, "خدمة التحقق من التذاكر غير مهيأة.");
    const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
    let actual; try { actual = Buffer.from(parts[1], "base64url"); } catch { throw httpError(400, "رمز التذكرة غير صالح."); }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw httpError(400, "رمز التذكرة غير صالح أو تم العبث به.");
    let payload; try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { throw httpError(400, "رمز التذكرة غير صالح."); }
    if (payload.v !== 1 || !payload.bookingId || !Number.isFinite(payload.exp) || payload.exp < Date.now()/1000) throw httpError(410, "انتهت صلاحية رمز التذكرة.");
    const ref = db.collection("bookings").doc(String(payload.bookingId));
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, "الحجز غير موجود.");
      const data = snap.data();
      if (!["confirmed", "paid"].includes(String(data.status || "").toLowerCase())) throw httpError(409, data.status === "checked_in" ? "تم تسجيل وصول هذه التذكرة مسبقاً." : "الحجز غير مؤكد أو غير صالح لتسجيل الوصول.");
      tx.update(ref, { status: "checked_in", checkedInAt: FieldValue.serverTimestamp(), checkedInBy: user.uid, updatedAt: FieldValue.serverTimestamp() });
      tx.set(db.collection("auditLogs").doc(), { action: "ticket_checkin", bookingId: ref.id, adminUid: user.uid, createdAt: FieldValue.serverTimestamp() });
      return { bookingId: ref.id, provider: String(data.offerSnapshot?.provider || data.provider || "Travel Touch") };
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) { return sendError(res, error); }
};
