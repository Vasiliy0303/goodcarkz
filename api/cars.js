// api/cars.js
// GET  /api/cars        — список авто
// POST /api/cars        — добавить авто
// PATCH /api/cars?id=  — обновить авто

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { status, make, published, limit = 20, offset = 0, search } = req.query;

      let where = [];
      let params = [];
      let p = 1;

      if (status)    { where.push(`status = $${p++}`);       params.push(status); }
      if (make)      { where.push(`make ILIKE $${p++}`);     params.push(`%${make}%`); }
      if (published === 'true') { where.push(`is_published = true`); }
      if (search)    {
        where.push(`(make ILIKE $${p} OR model ILIKE $${p} OR vin ILIKE $${p})`);
        params.push(`%${search}%`); p++;
      }

      const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const { rows } = await pool.query(`
        SELECT *,
          EXTRACT(DAY FROM NOW() - created_at)::INT AS days_in_stock
        FROM cars
        ${whereStr}
        ORDER BY created_at DESC
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, parseInt(limit), parseInt(offset)]);

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) FROM cars ${whereStr}`, params
      );

      return res.status(200).json({
        data: rows,
        total: parseInt(countRows[0].count),
      });
    }

    if (req.method === 'POST') {
      const {
        make, model, year, vin, color, mileage, price, status = 'Новый',
        engine, transmission, body_type, fuel_type, drive_type,
        description, photos = [], videos = [], manager_id, owner_id,
        seller_name, seller_phone
      } = req.body;

      if (!make || !model || !year) {
        return res.status(400).json({ error: 'make, model, year are required' });
      }

      const { rows } = await pool.query(`
        INSERT INTO cars (
          make, model, year, vin, color, mileage, price, status,
          engine, transmission, body_type, fuel_type, drive_type,
          description, photos, videos, manager_id, owner_id,
          seller_name, seller_phone
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        RETURNING *
      `, [
        make, model, parseInt(year), vin || null, color || null,
        parseInt(mileage) || 0, parseFloat(price) || 0, status,
        engine || null, transmission || null, body_type || null,
        fuel_type || null, drive_type || null, description || null,
        JSON.stringify(photos), JSON.stringify(videos),
        manager_id || null, owner_id || null,
        seller_name || null, seller_phone || null
      ]);

      // История статусов (не критично, если таблицы ещё нет)
      try {
        await pool.query(
          `INSERT INTO car_status_history (car_id, status, changed_by) VALUES ($1, $2, $3)`,
          [rows[0].id, status, seller_name || 'app']
        );
      } catch (e) { console.warn('history skip:', e.message); }

      await pool.query(`
        INSERT INTO analytics_events (event_type, entity_type, entity_id, meta)
        VALUES ('car_added', 'car', $1, $2)
      `, [rows[0].id, JSON.stringify({ make, model, year, status })]);

      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PATCH') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const allowed = ['make','model','year','vin','color','mileage','price','status',
        'engine','transmission','body_type','fuel_type','drive_type',
        'description','photos','videos','is_published','manager_id',
        'seller_name','seller_phone'];

      // Пустой VIN храним как NULL — иначе конфликт уникальности cars_vin_key
      if (req.body.vin !== undefined && String(req.body.vin).trim() === '') {
        req.body.vin = null;
      }

      const updates = [];
      const params = [id];
      let p = 2;

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          const val = ['photos','videos'].includes(key)
            ? JSON.stringify(req.body[key])
            : req.body[key];
          updates.push(`${key} = $${p++}`);
          params.push(val);
        }
      }

      // Если публикуем — ставим дату
      if (req.body.is_published === true) {
        updates.push(`published_at = NOW()`);
      }

      // Жизненный цикл: автоматические даты по смене статуса
      if (req.body.status === 'В продаже') {
        updates.push(`listed_at = COALESCE(listed_at, NOW())`);
      }
      if (req.body.status === 'Продан') {
        updates.push(`sold_at = NOW()`);
      }

      if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

      const { rows } = await pool.query(`
        UPDATE cars SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING *
      `, params);

      if (req.body.status) {
        try {
          await pool.query(
            `INSERT INTO car_status_history (car_id, status, changed_by) VALUES ($1, $2, $3)`,
            [id, req.body.status, req.body.changed_by || null]
          );
        } catch (e) { console.warn('history skip:', e.message); }
      }

      if (!rows.length) return res.status(404).json({ error: 'Car not found' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const { id, hard } = req.query;
      if (!id) return res.status(400).json({ error: 'id is required' });

      if (hard === '1') {
        // Полное удаление из базы (безвозвратно)
        await pool.query(`DELETE FROM cars WHERE id = $1`, [id]);
        return res.status(200).json({ message: 'Car deleted permanently' });
      }

      await pool.query(`UPDATE cars SET status = 'Архив' WHERE id = $1`, [id]);
      return res.status(200).json({ message: 'Car archived' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('cars API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
