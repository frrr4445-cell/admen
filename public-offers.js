const { getAdmin } = require("./_lib/common");

const PUBLIC_FIELDS = [
  "provider", "name", "location", "room", "type", "image",
  "discountedPrice", "originalPrice", "status", "expiresAt", "expiresAtMs"
];

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // CDN may serve the same public offer list to many visitors. Never cache user-specific data here.
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
  res.setHeader("Vary", "Accept-Encoding");
  try {
    const { db, Timestamp } = getAdmin();
    const now = Timestamp.now();
    const snapshot = await db.collection("offers")
      .where("status", "==", "available")
      .where("expiresAt", ">", now)
      .orderBy("expiresAt")
      .limit(100)
      .get();
    const offers = snapshot.docs.map(doc => {
      const data = doc.data();
      const safe = { id: doc.id };
      for (const field of PUBLIC_FIELDS) {
        const value = data[field];
        if (value === undefined || value === null) continue;
        safe[field] = field === "expiresAt" && typeof value.toMillis === "function"
          ? value.toMillis() : value;
      }
      return safe;
    });
    return res.status(200).json({ offers, generatedAt: Date.now() });
  } catch (error) {
    console.error("Public offers API failed:", error?.message || "unknown");
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "تعذر تحميل العروض حالياً." });
  }
};
