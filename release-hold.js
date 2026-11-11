const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, sendError } = require("./_lib/common");
module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    await enforceRateLimit(req, user.uid, "release-hold", 30, 60_000);
    const offerId = String(req.body?.offerId || "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(offerId)) return res.status(400).json({ error: "معرّف العرض غير صالح." });
    const { db } = getAdmin();
    const ref = db.collection("offerLocks").doc(offerId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const lock = snap.data(), paymentLockUntil = lock.paymentLockUntil?.toMillis?.() || 0;
      if (lock.userId === user.uid && paymentLockUntil <= Date.now()) tx.delete(ref);
    });
    return res.status(200).json({ released: true });
  } catch (error) { return sendError(res, error); }
};
