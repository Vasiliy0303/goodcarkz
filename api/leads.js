// /api/leads — GET (список с пагинацией) | POST (новый лид) | PATCH (?id=X)
// При 8000+ записей в базе выдача ОБЯЗАТЕЛЬНО постраничная.
import pg from 'pg';
const { Pool } = pg;

let pool;
function db() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан в настройках проекта Vercel');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 8000,
    });
    // Без этого обработчика ошибка простаивающего клиента роняет весь процесс
    // и Vercel отдаёт FUNCTION_INVOCATION_FAILED вместо читаемого ответа.
    pool.on('error', e => console.error('pg pool error:', e.message));
  }
  return pool;
}

const norm = p => p ? '+7' + String(p).replace(/\D/g, '').slice(-10) : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ── GET ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { city, status, segment, channel, q, manager_id, free } = req.query;
      const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);
      const offset = parseInt(req.query.offset, 10) || 0;

      const where = [], params = [];
      // Префикс l. обязателен: в staff тоже есть city, name и phone,
      // без него JOIN падает на неоднозначности колонок.
      const add = (sql, val) => { params.push(val); where.push(sql.replace('?', '$' + params.length)); };

      if (city && city !== 'all')       add('l.city = ?', city);
      if (status && status !== 'all')   add('l.status = ?', status);
      if (segment)                      add('l.segment = ?', segment);
      if (channel)                      add('l.channel = ?', channel);
      if (manager_id)                   add('l.manager_id = ?', manager_id);
      // free=1 — только не разобранные никем номера (общий пул базы обзвона)
      if (free === '1')                 where.push('l.manager_id IS NULL');
      if (q) {
        params.push('%' + q + '%');
        where.push(`(l.name ILIKE $${params.length} OR l.phone ILIKE $${params.length}
                     OR l.interest ILIKE $${params.length})`);
      }
      const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [{ count }] = (await c.query(
        `SELECT COUNT(*)::int AS count FROM leads l ${W}`, params)).rows;

      // База обзвона сортируется по «горячести»: сегмент, затем свежесть контакта
      const order = status === 'База'
        ? 'ORDER BY l.segment ASC NULLS LAST, l.last_contact DESC NULLS LAST'
        : 'ORDER BY l.created_at DESC';

      const rows = (await c.query(
        `SELECT l.*, s.name AS manager_name, s.avatar AS manager_avatar
         FROM leads l LEFT JOIN staff s ON s.id = l.manager_id
         ${W} ${order}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
                       'manager_id','segment','call_result','called_at',
                       'notes','next_call_at'];
      const b = req.body || {};
      const sets = [], params = [];
      for (const k of allowed) {
        if (b[k] !== undefined) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
      }
      // Лид берут в работу: фиксируем момент и переводим из базы в работу
      if (b.manager_id) {
        sets.push('taken_at = COALESCE(taken_at, now())');
        if (b.status === undefined) {
          params.push('В работе'); sets.push(`status = $${params.length}`);
        }
      }
      if (b.manager_id === null) sets.push('taken_at = NULL');

      if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });
      if (b.phone) { params.push(norm(b.phone)); sets.push(`phone_norm = $${params.length}`); }
      sets.push('updated_at = now()');

      params.push(id);
      const r = await c.query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Лид не найден' });
      return res.status(200).json({ data: r.rows[0] });
    }

    // ── DELETE ─────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });
      const r = await c.query(`DELETE FROM leads WHERE id = $1 RETURNING id`, [id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Лид не найден' });
      return res.status(200).json({ data: { id, deleted: true } });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('leads error:', e);
    return res.status(500).json({ error: e.message });
  }
}
