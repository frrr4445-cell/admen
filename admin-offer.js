const { getAdmin, requireUser, method, assertSameOrigin, sendError, httpError } = require("./_lib/common");
module.exports = async function handler(req, res) {
  try {
    method(req); assertSameOrigin(req);
    const user = await requireUser(req);
    const { db, FieldValue, Timestamp } = getAdmin();
    if (!(await db.collection("admins").doc(user.uid).get()).exists) throw httpError(403, "هذه العملية متاحة للمشرف فقط.");
    const action = String(req.body?.action || "update");
    if (action === "create") {
      const data = req.body?.offer || {};
      const provider = String(data.provider || "").trim(), room = String(data.room || "").trim();
      const originalPrice = Number(data.originalPrice), discountedPrice = Number(data.discountedPrice);
      const expiresAtMs = Number(data.expiresAtMs);
      if (!provider || provider.length > 160 || !room || room.length > 160 ||
          !(originalPrice > discountedPrice && discountedPrice > 0) ||
          !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw httpError(400, "بيانات العرض أو السعر أو تاريخ الانتهاء غير صالحة.");
      }
      const allowed = ["name", "type", "location", "region", "image", "stars"];
      if (originalPrice > 10000000 || discountedPrice > 10000000) throw httpError(400, "السعر يتجاوز الحد المسموح.");
      if (data.image && !(String(data.image).startsWith("https://") || String(data.image).startsWith("gs://"))) throw httpError(400, "رابط الصورة يجب أن يكون HTTPS أو Firebase Storage.");
      const offer = { provider, name: String(data.name || provider).slice(0,160), room,
        originalPrice, discountedPrice, status: "available",
        expiresAt: Timestamp.fromMillis(expiresAtMs), expiresAtMs,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
      for (const key of allowed) if (data[key] !== undefined) {
        if (key === "stars") offer[key] = Math.max(0, Math.min(5, Number(data[key]) || 0));
        else offer[key] = String(data[key]).trim().slice(0, key === "image" ? 2000 : 160);
      }
      const ref = await db.collection("offers").add(offer);
      await db.collection("auditLogs").add({ action: "offer_created", offerId: ref.id, adminUid: user.uid, createdAt: FieldValue.serverTimestamp() });
      return res.status(201).json({ ok: true, offerId: ref.id });
    }
    const id = String(req.body?.offerId || "");
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw httpError(400, "معرّف العرض غير صالح.");
    const ref = db.collection("offers").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw httpError(404, "العرض غير موجود.");
    if (action === "delete") {
      const batch = db.batch();
      batch.delete(ref);
      batch.set(db.collection("auditLogs").doc(), { action: "offer_deleted", offerId: id, adminUid: user.uid, createdAt: FieldValue.serverTimestamp() });
      await batch.commit();
      return res.status(200).json({ ok: true, deleted: true });
    }
    if (action !== "update") throw httpError(400, "العملية غير مدعومة.");
    const patch = req.body?.patch || {};
    const allowed = ["provider", "name", "room", "location", "type", "region", "originalPrice", "discountedPrice", "expiresAtMs"];
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.includes(key)) || !Object.keys(patch).length) throw httpError(400, "بيانات التعديل غير صالحة.");
    const current = snap.data();
    const next = { ...current, ...patch };
    for (const key of ["provider", "name", "room", "location", "type", "region"]) if (patch[key] !== undefined && (typeof patch[key] !== "string" || patch[key].trim().length > 160)) throw httpError(400, `قيمة ${key} غير صالحة.`);
    if (patch.originalPrice !== undefined && !(Number(patch.originalPrice) > 0)) throw httpError(400, "السعر الأصلي غير صالح.");
    if (patch.discountedPrice !== undefined && !(Number(patch.discountedPrice) > 0)) throw httpError(400, "السعر المخفض غير صالح.");
    if (!(Number(next.originalPrice) > Number(next.discountedPrice))) throw httpError(400, "يجب أن يكون السعر الأصلي أعلى من السعر المخفض.");
    const update = { updatedAt: FieldValue.serverTimestamp() };
    for (const key of allowed) if (patch[key] !== undefined && key !== "expiresAtMs") update[key] = typeof patch[key] === "string" ? patch[key].trim() : Number(patch[key]);
    if (patch.expiresAtMs !== undefined) {
      const ms = Number(patch.expiresAtMs);
      if (!Number.isFinite(ms) || ms <= Date.now()) throw httpError(400, "تاريخ انتهاء العرض يجب أن يكون في المستقبل.");
      update.expiresAt = Timestamp.fromMillis(ms); update.expiresAtMs = ms;
    }
    await ref.update(update);
    await db.collection("auditLogs").add({ action: "offer_updated", offerId: id, adminUid: user.uid, changedFields: Object.keys(patch), createdAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ ok: true });
  } catch (error) { return sendError(res, error); }
};
