const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, sendError } = require("./_lib/common");
module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    await enforceRateLimit(req, user.uid, "hold-offer", 20, 60_000);
    const offerId = String(req.body?.offerId || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(offerId)) return res.status(400).json({ error: "معرّف العرض غير صالح." });
    const { db, Timestamp } = getAdmin();
    const offerRef = db.collection("offers").doc(offerId);
    const lockRef = db.collection("offerLocks").doc(offerId);
    const heldUntilMs = await db.runTransaction(async tx => {
      const [offerSnap, lockSnap] = await Promise.all([tx.get(offerRef), tx.get(lockRef)]);
      if (!offerSnap.exists) throw Object.assign(new Error("العرض غير موجود."), { status: 404 });
      const offer = offerSnap.data(), lock = lockSnap.exists ? lockSnap.data() : {};
      const now = Date.now(), expiry = offer.expiresAt?.toMillis?.() || 0;
      const lockUntil = lock.paymentLockUntil?.toMillis?.() || 0;
      const holdUntil = lock.heldUntil?.toMillis?.() || 0;
      if (offer.status !== "available" || expiry <= now) throw Object.assign(new Error("انتهت صلاحية العرض أو لم يعد متاحاً."), { status: 409 });
      if (lockUntil > now) throw Object.assign(new Error("هناك عملية دفع قيد التنفيذ لهذا العرض."), { status: 409 });
      if (holdUntil > now && lock.userId !== user.uid) throw Object.assign(new Error("العرض محجوز مؤقتاً لمستخدم آخر."), { status: 409 });
      const until = Math.min(now + 3 * 60_000, expiry);
      tx.set(lockRef, { userId: user.uid, heldUntil: Timestamp.fromMillis(until), paymentId: null, paymentLockUntil: null, expiresAt: Timestamp.fromMillis(until + 24 * 60 * 60_000), updatedAt: Timestamp.now() }, { merge: true });
      return until;
    });
    return res.status(200).json({ heldUntilMs });
  } catch (error) { return sendError(res, error); }
};
