// /api/staff — GET (список сотрудников) | POST (вход по логину и паролю)
// Пароли пока хранятся открыто, как в текущей демо-схеме входа.
// Перед реальной эксплуатацией заменить на хеш — см. пометку внизу файла.
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

// Пароль наружу не отдаём никогда
const SAFE = 'id, login, name, role::text AS role, city, phone, avatar, color, is_active, last_login';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ── Список сотрудников ─────────────────────────────────────────────
    if (req.method === 'GET') {
      const { city, role } = req.query;
      const where = ['is_active'], params = [];
      if (city && city !== 'all') {
        params.push(city);
        // Руководитель без города виден всегда
        where.push(`(city = $${params.length} OR city IS NULL)`);
      }
      if (role) { params.push(role); where.push(`role = $${params.length}::user_role`); }

      const r = await c.query(
        `SELECT ${SAFE} FROM staff WHERE ${where.join(' AND ')}
         ORDER BY role, name`, params);
      return res.status(200).json({ data: r.rows, total: r.rowCount });
    }

    // ── Вход ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { login, password } = req.body || {};
      if (!login || !password)
        return res.status(400).json({ error: 'Введите логин и пароль' });

      const r = await c.query(
        `SELECT ${SAFE}, password FROM staff
         WHERE lower(login) = lower($1) AND is_active`, [login]);

      if (!r.rowCount || r.rows[0].password !== password)
        return res.status(401).json({ error: 'Неверный логин или пароль' });

      const { password: _, ...user } = r.rows[0];
      await c.query(`UPDATE staff SET last_login = now() WHERE id = $1`, [user.id]);
      return res.status(200).json({ data: user });
    }

    // ── Изменение сотрудника ───────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });

      const allowed = ['name','city','phone','avatar','color','is_active','password','login'];
      const b = req.body || {}, sets = [], params = [];
      for (const k of allowed) {
        if (b[k] === undefined) continue;
        params.push(b[k]); sets.push(`${k} = $${params.length}`);
      }
      if (b.role) { params.push(b.role); sets.push(`role = $${params.length}::user_role`); }
      if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });

      params.push(id);
      const r = await c.query(
        `UPDATE staff SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING ${SAFE}`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Сотрудник не найден' });
      return res.status(200).json({ data: r.rows[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('staff error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// ЗАМЕТКА НА БУДУЩЕЕ
// Пароли в открытом виде — временное решение, повторяющее нынешний demo-вход.
// Когда дойдут руки: хешировать через встроенный crypto.scrypt (без доп. пакетов),
// хранить hash и salt, сравнивать через timingSafeEqual.
