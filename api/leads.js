// /api/leads — GET (список с пагинацией) | POST (новый лид) | PATCH (?id=X)
// При 8000+ записей в базе выдача ОБЯЗАТЕЛЬНО постраничная.
const { Pool } = require('pg');

let pool;
function db() {
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return pool;
}

const norm = p => p ? '+7' + String(p).replace(/\D/g, '').slice(-10) : null;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ── GET ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { city, status, segment, channel, q, manager_id } = req.query;
      const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);
      const offset = parseInt(req.query.offset, 10) || 0;

      const where = [], params = [];
      const add = (sql, val) => { params.push(val); where.push(sql.replace('?', '$' + params.length)); };

      if (city && city !== 'all')       add('city = ?', city);
      if (status && status !== 'all')   add('status = ?', status);
      if (segment)                      add('segment = ?', segment);
      if (channel)                      add('channel = ?', channel);
      if (manager_id)                   add('manager_id = ?', manager_id);
      if (q) {
        params.push('%' + q + '%');
        where.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length}
                     OR interest ILIKE $${params.length})`);
      }
      const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [{ count }] = (await c.query(`SELECT COUNT(*)::int AS count FROM leads ${W}`, params)).rows;

      // База обзвона сортируется по «горячести»: сегмент, затем свежесть контакта
      const order = status === 'База'
        ? 'ORDER BY segment ASC NULLS LAST, last_contact DESC NULLS LAST'
        : 'ORDER BY created_at DESC';

      const rows = (await c.query(
        `SELECT * FROM leads ${W} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )).rows;

      return res.status(200).json({ data: rows, total: count, limit, offset });
    }

    // ── POST ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.phone) return res.status(400).json({ error: 'phone обязателен' });

      const r = await c.query(
        `INSERT INTO leads (name, phone, phone_norm, channel, city, interest, source_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'Новый'))
         ON CONFLICT (phone_norm) WHERE phone_norm IS NOT NULL
         DO UPDATE SET interest   = EXCLUDED.interest,
                       status     = CASE WHEN leads.status = 'База'
                                         THEN 'Новый' ELSE leads.status END,
                       updated_at = now()
         RETURNING *`,
        [b.name || 'Без имени', b.phone, norm(b.phone), b.channel || 'manual',
         b.city || 'Астана', b.interest || null, b.source_url || null, b.status || null]
      );
      return res.status(201).json({ data: r.rows[0] });
    }

    // ── PATCH ──────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });

      const allowed = ['name','phone','channel','city','interest','status',
                       'manager_id','segment','call_result','called_at'];
      const b = req.body || {};
      const sets = [], params = [];
      for (const k of allowed) {
        if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });
      if (b.phone) { params.push(norm(b.phone)); sets.push(`phone_norm = $${params.length}`); }
      sets.push('updated_at = now()');

      params.push(id);
      const r = await c.query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Лид не найден' });
      return res.status(200).json({ data: r.rows[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('leads error:', e);
    return res.status(500).json({ error: e.message });
  }
};
