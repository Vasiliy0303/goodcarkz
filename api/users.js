// api/users.js
// POST /api/users — регистрация/обновление клиента App (upsert по телефону)
// GET  /api/users — список зарегистрированных клиентов (для Platform)

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const { name, phone, city } = req.body;
      if (!name || !phone) {
        return res.status(400).json({ error: 'name и phone обязательны' });
      }
      const cleanPhone = String(phone).replace(/[^\d+]/g, '');

      const { rows } = await pool.query(`
        INSERT INTO app_users (name, phone, city)
        VALUES ($1, $2, $3)
        ON CONFLICT (phone) DO UPDATE SET
          name = EXCLUDED.name,
          city = COALESCE(EXCLUDED.city, app_users.city),
          last_seen_at = NOW()
        RETURNING *
      `, [String(name).trim(), cleanPhone, city || null]);

      return res.status(201).json({ data: rows[0] });
    }

    if (req.method === 'GET') {
      const { rows } = await pool.query(
        `SELECT * FROM app_users ORDER BY created_at DESC LIMIT 500`
      );
      return res.status(200).json({ data: rows, total: rows.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('users API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
