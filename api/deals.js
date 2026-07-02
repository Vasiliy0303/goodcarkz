// api/deals.js
// GET  /api/deals       — список сделок
// POST /api/deals       — создать сделку
// PATCH /api/deals?id= — обновить / сменить этап

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const STAGES = ['new','consultation','showing','proposal','deposit','closed','lost'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { stage, manager_id, client_id, limit = 50, offset = 0 } = req.query;

      let where = [];
      let params = [];
      let p = 1;

      if (stage)      { where.push(`d.stage = $${p++}`);      params.push(stage); }
      if (manager_id) { where.push(`d.manager_id = $${p++}`); params.push(manager_id); }
      if (client_id)  { where.push(`d.client_id = $${p++}`);  params.push(client_id); }

      const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const { rows } = await pool.query(`
        SELECT
          d.*,
          c.company_name AS client_name,
          u.name AS manager_name
        FROM deals d
        LEFT JOIN clients c ON c.id = d.client_id
        LEFT JOIN users u ON u.id = d.manager_id
        ${whereStr}
        ORDER BY d.created_at DESC
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, parseInt(limit), parseInt(offset)]);

      // Статистика по этапам
      const { rows: stats } = await pool.query(`
        SELECT stage, COUNT(*) as count, SUM(amount) as total
        FROM deals GROUP BY stage
      `);

      return res.status(200).json({
        data: rows,
        stats,
        total: rows.length,
      });
    }

    if (req.method === 'POST') {
      const { title, client_id, manager_id, stage = 'new', amount = 0, deadline, notes } = req.body;

      if (!title) return res.status(400).json({ error: 'title is required' });

      const { rows } = await pool.query(`
        INSERT INTO deals (title, client_id, manager_id, stage, amount, deadline, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [title, client_id || null, manager_id || null, stage,
          parseFloat(amount) || 0, deadline || null, notes || null]);

      await pool.query(`
        INSERT INTO analytics_events (event_type, entity_type, entity_id, amount, meta)
        VALUES ('deal_created', 'deal', $1, $2, $3)
      `, [rows[0].id, amount, JSON.stringify({ title, stage })]);

      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PATCH') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id is required' });

      // Получаем текущий этап для истории
      const { rows: current } = await pool.query(
        'SELECT stage FROM deals WHERE id = $1', [id]
      );
      if (!current.length) return res.status(404).json({ error: 'Deal not found' });

      const allowed = ['title','stage','amount','deadline','notes','manager_id','client_id'];
      const updates = [];
      const params = [id];
      let p = 2;

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = $${p++}`);
          params.push(req.body[key]);
        }
      }

      // Если сделка закрыта — фиксируем дату
      if (req.body.stage === 'closed' || req.body.stage === 'lost') {
        updates.push(`closed_at = NOW()`);
      }

      if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

      const { rows } = await pool.query(`
        UPDATE deals SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING *
      `, params);

      // Пишем историю смены этапа
      if (req.body.stage && req.body.stage !== current[0].stage) {
        await pool.query(`
          INSERT INTO deal_history (deal_id, from_stage, to_stage)
          VALUES ($1, $2, $3)
        `, [id, current[0].stage, req.body.stage]);

        // Событие аналитики для закрытых сделок
        if (req.body.stage === 'closed') {
          await pool.query(`
            INSERT INTO analytics_events (event_type, entity_type, entity_id, amount)
            VALUES ('deal_closed', 'deal', $1, $2)
          `, [id, rows[0].amount]);
        }
      }

      return res.status(200).json(rows[0]);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('deals API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
