// pages/api/register-zoho.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const zohoUrl = process.env.ZOHO_URL;
  if (!zohoUrl) return res.status(500).json({ error: "ZOHO_URL is not set" });

  try {
    const r = await fetch(zohoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    const text = await r.text().catch(() => "");
    // Pass through Zoho status for debugging
    return res.status(r.status).send(text || "ok");
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Zoho proxy error" });
  }
}
