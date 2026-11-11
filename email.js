const { fetchWithTimeout } = require("./common");

async function sendBookingConfirmation({ paymentId, payment, bookingId }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.TRANSACTIONAL_EMAIL_FROM;
  if (!apiKey || !from || !payment?.userEmail) return { skipped: true };
  const { db, FieldValue } = require("./common").getAdmin();
  const ref = db.collection("payments").doc(paymentId);
  const claimed = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const current = snap.data();
    if (current.emailStatus === "sent" || current.emailStatus === "sending") return false;
    tx.set(ref, { emailStatus: "sending", emailAttemptedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  if (!claimed) return { skipped: true };
  const passenger = payment.passenger || {};
  const offer = payment.offerSnapshot || {};
  const currency = payment.currency || "USD";
  const total = (Number(payment.amountTotal || 0) / 100).toFixed(2);
  const html = `<!doctype html><html lang="ar" dir="rtl"><body style="font-family:Arial,sans-serif;color:#10243b"><h2>تم تأكيد حجزك في Travel Touch</h2><p>مرحباً ${escapeHtml([passenger.firstName, passenger.lastName].filter(Boolean).join(" "))}</p><p>العرض: ${escapeHtml(offer.provider || "Travel Touch")} — ${escapeHtml(offer.room || "")}</p><p>رقم الحجز: <b>${escapeHtml(bookingId)}</b></p><p>الإجمالي: ${escapeHtml(total)} ${escapeHtml(currency)}</p><p>يمكنك عرض تذكرتك من محفظة التذاكر بعد تسجيل الدخول.</p></body></html>`;
  try {
    const response = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [payment.userEmail], subject: "تأكيد حجزك — Travel Touch", html,
        tags: [{ name: "type", value: "booking-confirmation" }] })
    }, 10000);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
    await ref.set({ emailStatus: "sent", emailId: result.id || null, emailSentAt: FieldValue.serverTimestamp() }, { merge: true });
    return { sent: true };
  } catch (error) {
    console.error("Booking email failed:", error?.message || "unknown");
    await ref.set({ emailStatus: "failed", emailLastError: "provider_error", emailFailedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    return { failed: true };
  }
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
module.exports = { sendBookingConfirmation };
