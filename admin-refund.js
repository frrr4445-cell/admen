const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, sendError, paypalRequest, httpError } = require("./_lib/common");

// Full refunds are deliberately admin-only. The PayPal request id makes retries idempotent.
module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    const { db, FieldValue } = getAdmin();
    const adminSnap = await db.collection("admins").doc(user.uid).get();
    if (!adminSnap.exists) throw httpError(403, "هذه العملية متاحة للمشرف فقط.");
    await enforceRateLimit(req, user.uid, "admin-refund", 5, 10 * 60_000);

    const paymentId = String(req.body?.paymentId || "");
    const reason = String(req.body?.reason || "admin_review").trim().slice(0, 160);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(paymentId)) throw httpError(400, "معرّف الدفع غير صالح.");
    const paymentRef = db.collection("payments").doc(paymentId);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) throw httpError(404, "سجل الدفع غير موجود.");
    const payment = paymentSnap.data();
    if (payment.status === "refunded") return res.status(200).json({ status: "refunded", alreadyRefunded: true });
    if (!["paid", "refund_required", "review_required", "refund_pending", "refund_failed", "refunding"].includes(payment.status))
      throw httpError(409, "حالة الدفع الحالية لا تسمح بالاسترداد.");
    if (!payment.paypalCaptureId || !payment.amountTotal || !payment.currency)
      throw httpError(409, "بيانات التحصيل ناقصة؛ يلزم التحقق اليدوي من PayPal.");

    const requestId = `tt-refund-${paymentId}`;
    const shouldRefund = await db.runTransaction(async tx => {
      const fresh = await tx.get(paymentRef);
      if (!fresh.exists) throw httpError(404, "سجل الدفع غير موجود.");
      const p = fresh.data();
      if (p.status === "refunded") return false;
      if (!["paid", "refund_required", "review_required", "refund_pending", "refund_failed", "refunding"].includes(p.status))
        throw httpError(409, "تغيرت حالة الدفع ولا يمكن استرداده.");
      tx.set(paymentRef, { status: "refunding", refundRequestedBy: user.uid, refundReason: reason, refundRequestId: requestId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!shouldRefund) return res.status(200).json({ status: "refunded", alreadyRefunded: true });

    let refund;
    try {
      refund = await paypalRequest(`/v2/payments/captures/${encodeURIComponent(payment.paypalCaptureId)}/refund`, {
        method: "POST", requestId, body: {}
      });
    } catch (error) {
      await paymentRef.set({ status: "refund_pending", refundLastError: "paypal_request_uncertain", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw error;
    }

    const refundStatus = String(refund.status || "").toUpperCase();
    const finalStatus = refundStatus === "COMPLETED" ? "refunded" : "refund_pending";
    const batch = db.batch();
    batch.set(paymentRef, { status: finalStatus, paypalRefundId: refund.id || null, refundStatus, refundedAt: finalStatus === "refunded" ? FieldValue.serverTimestamp() : null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (finalStatus === "refunded" && payment.bookingId) {
      batch.set(db.collection("bookings").doc(payment.bookingId), { status: "refunded", refundedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    const auditRef = db.collection("auditLogs").doc();
    batch.set(auditRef, { action: "paypal_full_refund", actorUid: user.uid, paymentId, bookingId: payment.bookingId || null, paypalRefundId: refund.id || null, status: finalStatus, reason, createdAt: FieldValue.serverTimestamp() });
    await batch.commit();
    return res.status(200).json({ status: finalStatus, refundId: refund.id || null });
  } catch (error) { return sendError(res, error); }
};
