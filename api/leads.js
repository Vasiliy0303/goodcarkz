// api/leads.js
// POST /api/leads — создать лид
// GET  /api/leads — получить все лиды

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { status, channel, manager_id, limit = 50, offset = 0 } = req.query;

      let where = [];
      let params = [];
      let p = 1;

      if (status)     { where.push(`l.status = $${p++}`);     params.push(status); }
      if (channel)    { where.push(`l.channel = $${p++}`);    params.push(channel); }
      if (manager_id) { where.push(`l.manager_id = $${p++}`); params.push(manager_id); }

      const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const { rows } = await pool.query(`
        SELECT
          l.*,
          u.name AS manager_name
        FROM leads l
        LEFT JOIN users u ON u.id = l.manager_id
        ${whereStr}
        ORDER BY l.created_at DESC
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, parseInt(limit), parseInt(offset)]);

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) FROM leads l ${whereStr}`, params
      );

      return res.status(200).json({
        data: rows,
        total: parseInt(countRows[0].count),
      });
    }

    if (req.method === 'POST') {
      const { name, phone, email, channel = 'manual', interest, source_url, manager_id } = req.body;

      if (!name) return res.status(400).json({ error: 'name is required' });

      const { rows } = await pool.query(`
        INSERT INTO leads (name, phone, email, channel, interest, source_url, manager_id, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')
        RETURNING *
      `, [name, phone || null, email || null, channel, interest || null, source_url || null, manager_id || null]);

      // Создаём уведомление для менеджеров
      if (manager_id) {
        await pool.query(`
          INSERT INTO notifications (user_id, type, title, body, link)
          VALUES ($1, 'new_lead', $2, $3, $4)
        `, [
          manager_id,
          `Новый лид: ${name}`,
          `Канал: ${channel}${interest ? '. Интерес: ' + interest : ''}`,
          `/crm.html#leads`
        ]);
      }

      // Пишем событие аналитики
      await pool.query(`
        INSERT INTO analytics_events (event_type, entity_type, entity_id, meta)
        VALUES ('lead_created', 'lead', $1, $2)
      `, [rows[0].id, JSON.stringify({ channel, name })]);

      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PATCH') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const allowed = ['status', 'manager_id', 'interest', 'phone', 'email'];
      const updates = [];
      const params = [id];
      let p = 2;

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = $${p++}`);
          params.push(req.body[key]);
        }
      }

      if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

      const { rows } = await pool.query(`
        UPDATE leads SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING *
      `, params);

      if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
      return res.status(200).json(rows[0]);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('leads API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
