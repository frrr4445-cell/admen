const { getAdmin, requireUser, assertSameOrigin, sendError } = require("./_lib/common");
module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
    assertSameOrigin(req);
    const user = await requireUser(req);
    const { db } = getAdmin();
    const snapshot = await db.collection("chats").doc(user.uid).collection("messages")
      .orderBy("createdAt", "desc").limit(40).get();
    const messages = snapshot.docs.reverse().map(doc => ({
      role: doc.data().from === "user" ? "user" : "assistant",
      text: String(doc.data().text || "").slice(0, 4000),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || null
    }));
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ messages });
  } catch (error) { return sendError(res, error); }
};
