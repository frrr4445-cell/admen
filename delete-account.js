const crypto = require("crypto");
const { getAdmin, requireUser, method, assertSameOrigin, enforceRateLimit, sendError, httpError } = require("./_lib/common");

async function batchDeleteQuery(db, collectionName, uid, documentIdField) {
  let cursor = null, removed = 0;
  while (true) {
    let q = db.collection(collectionName).where("userId", "==", uid).orderBy(documentIdField).limit(400);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    removed += snap.size;
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }
  return removed;
}

async function anonymizeQuery(db, collectionName, uid, FieldValue, documentIdField) {
  let cursor = null, changed = 0;
  while (true) {
    let q = db.collection(collectionName).where("userId", "==", uid).orderBy(documentIdField).limit(400);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, {
      userId: FieldValue.delete(), passenger: FieldValue.delete(),
      accountDeleted: true, accountDeletedAt: FieldValue.serverTimestamp()
    }));
    await batch.commit();
    changed += snap.size;
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }
  return changed;
}

module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!user.auth_time || nowSeconds - user.auth_time > 300) throw httpError(401, "لأمان حسابك، سجّل الدخول مجدداً ثم أعد طلب حذف الحساب.");
    await enforceRateLimit(req, user.uid, "delete-account", 3, 60 * 60_000);
    const { admin, db, FieldValue } = getAdmin();
    const adminRole = await db.collection("admins").doc(user.uid).get();
    if (adminRole.exists) throw httpError(409, "هذا حساب مشرف. انقل صلاحيات الإدارة إلى مشرف آخر قبل حذف الحساب.");

    const documentIdField = admin.firestore.FieldPath.documentId();
    let paymentCursor = null;
    while (true) {
      let q = db.collection("payments").where("userId", "==", user.uid).orderBy(documentIdField).limit(400);
      if (paymentCursor) q = q.startAfter(paymentCursor);
      const page = await q.get();
      const blocking = page.docs.filter(d => ["creating", "pending", "processing", "refund_required", "review_required", "refund_pending", "refunding"].includes(d.data().status));
      if (blocking.length) throw httpError(409, "لديك عملية دفع أو استرداد معلقة. تواصل مع الدعم حتى تُحسم قبل حذف الحساب.");
      if (page.empty || page.size < 400) break;
      paymentCursor = page.docs[page.docs.length - 1];
    }

    // Preserve financial/audit records but permanently remove account identifiers and passenger PII.
    await Promise.all([
      anonymizeQuery(db, "bookings", user.uid, FieldValue, documentIdField),
      anonymizeQuery(db, "payments", user.uid, FieldValue, documentIdField)
    ]);
    const privateCollections = ["supportTickets", "consents", "sosRequests"];
    for (const name of privateCollections) await batchDeleteQuery(db, name, user.uid, documentIdField);
    await batchDeleteQuery(db, "offerLocks", user.uid, documentIdField);
    await db.collection("users").doc(user.uid).delete().catch(() => {});
    await db.collection("radarPrefs").doc(user.uid).delete().catch(() => {});

    // chats/{uid}/messages is a subcollection; delete it in bounded batches before its parent.
    const messages = db.collection("chats").doc(user.uid).collection("messages");
    while (true) {
      const page = await messages.orderBy(documentIdField).limit(400).get();
      if (page.empty) break;
      const batch = db.batch(); page.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
      if (page.size < 400) break;
    }
    await db.collection("chats").doc(user.uid).delete().catch(() => {});

    const actorHash = crypto.createHash("sha256").update(user.uid).digest("hex");
    await db.collection("auditLogs").add({ action: "account_deleted", subjectHash: actorHash, createdAt: FieldValue.serverTimestamp() });
    await admin.auth().deleteUser(user.uid);
    return res.status(200).json({ deleted: true, financialRecords: "anonymized_and_retained" });
  } catch (error) { return sendError(res, error); }
};
