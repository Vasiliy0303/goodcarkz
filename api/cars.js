// /api/cars — GET | POST | PATCH (?id=X) | DELETE (?id=X)
// Это тот самый файл, из-за отсутствия которого /api/cars отдавал 404.
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

// Только реально существующие в схеме колонки — защита от инъекций
// и от 500-х на опечатках в теле запроса.
const FIELDS = ['make','model','year','price','photos','videos','documents',
                'engine','transmission','drive_type','body_type','fuel_type',
                'color','mileage','description','status','city','vin',
                'seller_name','seller_phone','is_published','manager_id'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ── GET одной машины со всеми фото ─────────────────────────────────
    if (req.method === 'GET' && req.query.id) {
      const r = await c.query(`SELECT * FROM cars WHERE id = $1`, [req.query.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Авто не найдено' });
      return res.status(200).json({ data: r.rows[0] });
    }

    // ── GET ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { city, status, q } = req.query;
      const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);
      const offset = parseInt(req.query.offset, 10) || 0;

      const where = [], params = [];
      if (city && city !== 'all')     { params.push(city);   where.push(`city = $${params.length}`); }
      if (status && status !== 'all') { params.push(status); where.push(`status = $${params.length}`); }
      if (q) {
        params.push('%' + q + '%');
        where.push(`(make ILIKE $${params.length} OR model ILIKE $${params.length}
                     OR vin ILIKE $${params.length})`);
      }
      const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [{ count }] = (await c.query(`SELECT COUNT(*)::int AS count FROM cars ${W}`, params)).rows;

      // full=1 или запрос конкретной машины — отдаём всё, включая фото.
      // Иначе список: только первое фото и число остальных, чтобы
      // не гонять мегабайты base64 при каждом открытии каталога.
      const full = req.query.full === '1' || req.query.id;

      const cols = full ? '*' : `
        id, make, model, year, price, mileage, color, status, city,
        is_published, vin, created_at,
        CASE WHEN jsonb_typeof(photos) = 'array' AND jsonb_array_length(photos) > 0
             THEN jsonb_build_array(photos->0) ELSE '[]'::jsonb END AS photos,
        CASE WHEN jsonb_typeof(photos) = 'array'
             THEN jsonb_array_length(photos) ELSE 0 END AS photo_count`;

      const rows = (await c.query(
        `SELECT ${cols} FROM cars ${W} ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )).rows;

      return res.status(200).json({ data: rows, total: count, limit, offset });
    }

    // ── POST ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.make || !b.model) return res.status(400).json({ error: 'make и model обязательны' });

      const cols = [], vals = [], ph = [];
      for (const f of FIELDS) {
        if (b[f] === undefined) continue;
        cols.push(f);
        vals.push(Array.isArray(b[f]) ? JSON.stringify(b[f]) : b[f]);
        ph.push('$' + vals.length);
      }
      if (!cols.includes('status')) { cols.push('status'); vals.push('Новый'); ph.push('$' + vals.length); }
      if (!cols.includes('city'))   { cols.push('city');   vals.push('Астана'); ph.push('$' + vals.length); }

      const r = await c.query(
        `INSERT INTO cars (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING *`, vals);
      return res.status(201).json({ data: r.rows[0] });
    }

    // ── PATCH ──────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });

      const b = req.body || {}, sets = [], params = [];
      for (const f of FIELDS) {
        if (b[f] === undefined) continue;
        params.push(Array.isArray(b[f]) ? JSON.stringify(b[f]) : b[f]);
        sets.push(`${f} = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });
      sets.push('updated_at = now()');

      params.push(id);
      const r = await c.query(
        `UPDATE cars SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Авто не найдено' });
      return res.status(200).json({ data: r.rows[0] });
    }

    // ── DELETE — мягкое удаление в Архив ───────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });
      const r = await c.query(
        `UPDATE cars SET status = 'Архив', updated_at = now() WHERE id = $1 RETURNING id`, [id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Авто не найдено' });
      return res.status(200).json({ data: { id, status: 'Архив' } });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('cars error:', e);
    return res.status(500).json({ error: e.message });
  }
}
