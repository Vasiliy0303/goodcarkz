// GET /api/ping2 - ta zhe proverka, no v sintaksise ES-modules.
// Esli ping padaet, a ping2 rabotaet - znachit proekt na ESM,
// i vse ostalnye fayly nado perepisat pod etot format.

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).end(JSON.stringify({
    ok: true,
    format: 'ESM (export default)',
    node: process.version,
    has_database_url: !!process.env.DATABASE_URL,
    time: new Date().toISOString()
  }, null, 2));
}
