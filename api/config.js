// /api/config — настройки компании и воронка продаж
//   GET   /api/config          — всё разом: настройки, этапы, должности
//   PATCH /api/config          — сохранить настройки {settings:{ключ:значение}}
//   PATCH /api/config?stage=X  — изменить этап {title, color, sort, is_active}
import pg from 'pg';
const { Pool } = pg;

let pool;
function db() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 8000,
    });
    pool.on('error', e => console.error('pg pool error:', e.message));
  }
  return pool;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ══ GET ═══════════════════════════════════════════════════════════════
    if (req.method === 'GET') {
      const [settings, stages, positions] = await Promise.all([
        c.query(`SELECT key, value, title, hint, grp, sort FROM settings ORDER BY sort`),
        c.query(`SELECT code, title, color, sort, is_active, is_final FROM stages ORDER BY sort`),
        c.query(`SELECT code, title, role::text AS role, hint FROM positions
                 WHERE is_active ORDER BY sort`),
      ]);

      // Плоский вид ключ-значение — так удобнее фронту
      const map = Object.fromEntries(settings.rows.map(r => [r.key, r.value]));

      return res.status(200).json({
        settings: map,
        settings_meta: settings.rows,
        stages: stages.rows,
        positions: positions.rows,
      });
    }

    // ══ PATCH ═════════════════════════════════════════════════════════════
    if (req.method === 'PATCH') {
      const b = req.body || {};

      // Изменение этапа воронки
      const stage = req.query.stage;
      if (stage) {
        const sets = [], params = [];
        for (const k of ['title','color','sort','is_active','is_final']) {
          if (b[k] === undefined) continue;
          params.push(b[k]); sets.push(`${k} = $${params.length}`);
        }
        if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });

        params.push(stage);
        const r = await c.query(
          `UPDATE stages SET ${sets.join(', ')} WHERE code = $${params.length}
           RETURNING code, title, color, sort, is_active, is_final`, params);
        if (!r.rowCount) return res.status(404).json({ error: 'Этап не найден' });
        return res.status(200).json({ data: r.rows[0] });
      }

      // Сохранение настроек пачкой
      const s = b.settings;
      if (!s || typeof s !== 'object')
        return res.status(400).json({ error: 'Ожидается объект settings' });

      const keys = Object.keys(s);
      if (!keys.length) return res.status(400).json({ error: 'Пустой список настроек' });

      // Только существующие ключи — чужие в таблицу не попадут
      const known = (await c.query(`SELECT key FROM settings`)).rows.map(r => r.key);
      const saved = [];
      for (const k of keys) {
        if (!known.includes(k)) continue;
        await c.query(
          `UPDATE settings SET value = $1, updated_at = now() WHERE key = $2`,
          [s[k] === null ? null : String(s[k]), k]);
        saved.push(k);
      }
      return res.status(200).json({ data: { saved }, total: saved.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('config error:', e);
    return res.status(500).json({ error: e.message });
  }
}
