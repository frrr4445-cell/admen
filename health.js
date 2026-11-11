module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ status: "method_not_allowed" });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({ status: "ok", service: "travel-touch-api", version: "1.2.2", timestamp: new Date().toISOString() });
};
