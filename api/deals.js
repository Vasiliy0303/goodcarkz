// /api/deals — GET | POST | PATCH (?id=X) | DELETE (?id=X)
// stage — enum deal_stage (латиница), amount — numeric, closed_at — метка закрытия.
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

// Единственный источник правды по этапам — совпадает с enum в БД
const STAGES = ['new','consultation','showing','inspection','history_check',
                'test_drive','proposal','financing','deposit','contract',
                'handover','closed','lost'];
const FINAL = ['closed','lost'];

const FIELDS = ['title','client_id','lead_id','car_id','manager_id','amount',
                'deadline','notes','city','client_name','client_phone'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ── GET ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { city, stage, manager_id } = req.query;
      const limit  = Math.min(parseInt(req.query.limit, 10) || 300, 500);
      const offset = parseInt(req.query.offset, 10) || 0;

      const where = [], params = [];
      if (city && city !== 'all')   { params.push(city);  where.push(`d.city = $${params.length}`); }
      if (stage && stage !== 'all') { params.push(stage); where.push(`d.stage = $${params.length}`); }
      if (manager_id)               { params.push(manager_id); where.push(`d.manager_id = $${params.length}`); }
      const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [{ count }] = (await c.query(`SELECT COUNT(*)::int AS count FROM deals d ${W}`, params)).rows;

      // Название авто подтягиваем из cars, если сделка связана
      const rows = (await c.query(
        `SELECT d.*, d.stage::text AS stage,
                COALESCE(d.client_name, l.name)  AS client_display,
                COALESCE(d.client_phone, l.phone) AS client_phone_display,
                CASE WHEN car.id IS NOT NULL
                     THEN car.make || ' ' || car.model || ' ' || COALESCE(car.year::text,'')
                     ELSE d.title END AS car_display
         FROM deals d
         LEFT JOIN leads l  ON l.id  = d.lead_id
         LEFT JOIN cars car ON car.id = d.car_id
         ${W} ORDER BY d.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )).rows;

      return res.status(200).json({ data: rows, total: count, stages: STAGES, limit, offset });
    }

    // ── POST ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.title) return res.status(400).json({ error: 'title обязателен' });

      const stage = STAGES.includes(b.stage) ? b.stage : 'new';
      const cols = ['title','stage','city'], vals = [b.title, stage, b.city || 'Астана'];
      for (const f of FIELDS) {
        if (f === 'title' || f === 'city' || b[f] === undefined || b[f] === '') continue;
        cols.push(f); vals.push(b[f]);
      }
      if (FINAL.includes(stage)) { cols.push('closed_at'); vals.push(new Date()); }

      const ph = vals.map((_, i) => '$' + (i + 1));
      const r = await c.query(
        `INSERT INTO deals (${cols.join(',')}) VALUES (${ph.join(',')})
         RETURNING *, stage::text AS stage`, vals);
      return res.status(201).json({ data: r.rows[0] });
    }

    // ── PATCH ──────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });

      const b = req.body || {}, sets = [], params = [];

      if (b.stage !== undefined) {
        if (!STAGES.includes(b.stage))
          return res.status(400).json({ error: 'Неизвестный этап: ' + b.stage });
        params.push(b.stage); sets.push(`stage = $${params.length}::deal_stage`);
        // Закрытие проставляется автоматически — на нём держится вся статистика
        sets.push(FINAL.includes(b.stage)
          ? 'closed_at = COALESCE(closed_at, now())'
          : 'closed_at = NULL');
      }
      for (const f of FIELDS) {
        if (b[f] === undefined) continue;
        params.push(b[f] === '' ? null : b[f]); sets.push(`${f} = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });
      sets.push('updated_at = now()');

      params.push(id);
      const r = await c.query(
        `UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING *, stage::text AS stage`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Сделка не найдена' });
      return res.status(200).json({ data: r.rows[0] });
    }

    // ── DELETE ─────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });
      const r = await c.query(`DELETE FROM deals WHERE id = $1 RETURNING id`, [id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Сделка не найдена' });
      return res.status(200).json({ data: { id, deleted: true } });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('deals error:', e);
    return res.status(500).json({ error: e.message });
  }
};
