const crypto = require("crypto");
const { getAdmin, requireUser, method, assertSameOrigin, sendError, httpError } = require("./_lib/common");
module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    const bookingId = String(req.body?.bookingId || "");
    if (!/^[A-Za-z0-9_-]{10,150}$/.test(bookingId)) throw httpError(400, "رقم الحجز غير صالح.");
    const secret = process.env.TICKET_SIGNING_SECRET;
    if (!secret || secret.length < 32) throw httpError(503, "خدمة رموز التذاكر غير مهيأة بعد.");
    const { db } = getAdmin();
    const snap = await db.collection("bookings").doc(bookingId).get();
    if (!snap.exists || snap.data().userId !== user.uid) throw httpError(404, "التذكرة غير موجودة.");
    if (!(["confirmed", "paid"].includes(String(snap.data().status || "").toLowerCase()))) throw httpError(409, "هذه التذكرة ليست مؤكدة أو سبق استخدامها.");
    const payload = Buffer.from(JSON.stringify({ v: 1, bookingId, exp: Math.floor(Date.now()/1000) + 365*24*60*60 })).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return res.status(200).json({ token: `${payload}.${signature}` });
  } catch (error) { return sendError(res, error); }
};
