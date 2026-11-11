// One-time migration for older public offers that stored heldBy/heldUntil on the offer document.
// Run locally with FIREBASE_SERVICE_ACCOUNT_JSON set; never commit service-account credentials.
const admin = require("firebase-admin");

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Set FIREBASE_SERVICE_ACCOUNT_JSON in your local shell first.");
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();
  const now = Date.now();
  let cursor = null, migrated = 0, cleaned = 0;
  while (true) {
    let q = db.collection("offers").orderBy(admin.firestore.FieldPath.documentId()).limit(200);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    const batch = db.batch();
    for (const doc of page.docs) {
      const data = doc.data();
      const heldUntil = data.heldUntil?.toMillis?.() || 0;
      const paymentLockUntil = data.paymentLockUntil?.toMillis?.() || 0;
      const userId = data.heldBy;
      const paymentId = data.paymentLockId || null;
      if (userId && (heldUntil > now || paymentLockUntil > now)) {
        const expiresAt = Math.max(heldUntil, paymentLockUntil) + 24 * 60 * 60_000;
        batch.set(db.collection("offerLocks").doc(doc.id), {
          userId,
          heldUntil: admin.firestore.Timestamp.fromMillis(Math.max(heldUntil, paymentLockUntil)),
          paymentId: paymentLockUntil > now ? paymentId : null,
          paymentLockUntil: paymentLockUntil > now ? admin.firestore.Timestamp.fromMillis(paymentLockUntil) : null,
          expiresAt: admin.firestore.Timestamp.fromMillis(expiresAt),
          migratedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        migrated++;
      }
      if (Object.prototype.hasOwnProperty.call(data, "heldBy") || Object.prototype.hasOwnProperty.call(data, "heldUntil") || Object.prototype.hasOwnProperty.call(data, "paymentLockId") || Object.prototype.hasOwnProperty.call(data, "paymentLockUntil")) {
        batch.update(doc.ref, {
          heldBy: admin.firestore.FieldValue.delete(),
          heldUntil: admin.firestore.FieldValue.delete(),
          paymentLockId: admin.firestore.FieldValue.delete(),
          paymentLockUntil: admin.firestore.FieldValue.delete()
        });
        cleaned++;
      }
    }
    await batch.commit();
    cursor = page.docs[page.docs.length - 1];
    if (page.size < 200) break;
  }
  console.log(JSON.stringify({ migratedLocks: migrated, cleanedPublicOfferDocuments: cleaned }));
  await admin.app().delete();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
