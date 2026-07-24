// GET /api/ping - proverka bez zavisimostey.
// Nikakih require, tolko ASCII. Esli i eto padaet - delo ne v kode.

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).end(JSON.stringify({
    ok: true,
    node: process.version,
    has_database_url: !!process.env.DATABASE_URL,
    has_jwt_secret: !!process.env.JWT_SECRET,
    node_env: process.env.NODE_ENV || null,
    region: process.env.VERCEL_REGION || null,
    time: new Date().toISOString()
  }, null, 2));
};
