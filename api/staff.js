// /api/staff — сотрудники и доступ
//   GET  /api/staff                     — список подтверждённых
//   GET  /api/staff?pending=1           — ждут подтверждения
//   GET  /api/staff?positions=1         — справочник должностей
//   POST /api/staff {action:'login'}    — вход
//   POST /api/staff {action:'register'} — регистрация
//   PATCH /api/staff?id=X               — подтвердить, изменить, отключить
//   DELETE /api/staff?id=X              — удалить
import pg from 'pg';
import crypto from 'node:crypto';
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

// Пароль наружу не отдаём ни при каких условиях
const SAFE = `id, email, name, phone, position, role::text AS role, city,
              avatar, color, is_active, created_at, approved_at, last_login`;

// ── Пароли ────────────────────────────────────────────────────────────────
// scrypt из встроенного crypto — дополнительных пакетов не требуется.
// Формат хранения: scrypt$<соль hex>$<хеш hex>
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(plain, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) return stored === plain;  // старые открытые пароли
  const [, saltHex, hashHex] = stored.split('$');
  const hash = Buffer.from(hashHex, 'hex');
  const test = crypto.scryptSync(plain, Buffer.from(saltHex, 'hex'), hash.length);
  return crypto.timingSafeEqual(hash, test);
}

const initials = name => (name || '').trim().split(/\s+/).slice(0, 2)
  .map(w => w[0]).join('').toUpperCase() || '??';

const COLORS = ['#C0392B','#2980B9','#27AE60','#8E44AD','#E67E22','#16A085','#D35400'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const c = db();

  try {
    // ══ GET ═══════════════════════════════════════════════════════════════
    if (req.method === 'GET') {
      if (req.query.positions === '1') {
        const r = await c.query(
          `SELECT code, title, role::text AS role, hint FROM positions
           WHERE is_active ORDER BY sort`);
        return res.status(200).json({ data: r.rows, total: r.rowCount });
      }

      const pending = req.query.pending === '1';
      const where = [pending ? 'NOT is_active' : 'is_active'], params = [];
      if (req.query.city && req.query.city !== 'all') {
        params.push(req.query.city);
        where.push(`(city = $${params.length} OR city IS NULL)`);
      }
      const r = await c.query(
        `SELECT ${SAFE} FROM staff WHERE ${where.join(' AND ')}
         ORDER BY ${pending ? 'created_at DESC' : 'role, name'}`, params);
      return res.status(200).json({ data: r.rows, total: r.rowCount });
    }

    // ══ POST ══════════════════════════════════════════════════════════════
    if (req.method === 'POST') {
      const b = req.body || {};

      // ── Регистрация ──
      if (b.action === 'register') {
        const { email, password, name, position, phone, city } = b;
        if (!email || !password || !name || !position)
          return res.status(400).json({ error: 'Заполните имя, email, пароль и должность' });
        if (String(password).length < 6)
          return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });

        const pos = (await c.query(
          `SELECT title, role::text AS role FROM positions
           WHERE code = $1 AND is_active`, [position])).rows[0];
        if (!pos) return res.status(400).json({ error: 'Выберите должность из списка' });

        const dup = await c.query(`SELECT 1 FROM staff WHERE lower(email) = lower($1)`, [email]);
        if (dup.rowCount)
          return res.status(409).json({ error: 'Такой email уже зарегистрирован' });

        // Первый сотрудник становится руководителем и входит сразу.
        // Остальные ждут подтверждения — иначе базу клиентов смог бы
        // выгрузить любой, кто знает адрес страницы регистрации.
        const { rows: [{ cnt }] } = await c.query(`SELECT COUNT(*)::int AS cnt FROM staff`);
        const first = cnt === 0;

        const r = await c.query(
          `INSERT INTO staff (email, password, name, phone, position, role, city,
                              avatar, color, is_active, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6::user_role,$7,$8,$9,$10,$11)
           RETURNING ${SAFE}`,
          [email.trim(), hashPassword(password), name.trim(), phone || null,
           pos.title, first ? 'admin' : pos.role, city || null,
           initials(name), COLORS[cnt % COLORS.length],
           first, first ? new Date() : null]);

        return res.status(201).json({
          data: r.rows[0],
          first,
          message: first
            ? 'Вы зарегистрированы как руководитель. Можно входить.'
            : 'Заявка принята. Доступ откроет руководитель.',
        });
      }

      // ── Вход ──
      const email = b.email || b.login;
      if (!email || !b.password)
        return res.status(400).json({ error: 'Введите email и пароль' });

      const r = await c.query(
        `SELECT ${SAFE}, password FROM staff WHERE lower(email) = lower($1)`, [email]);

      if (!r.rowCount || !checkPassword(b.password, r.rows[0].password))
        return res.status(401).json({ error: 'Неверный email или пароль' });

      if (!r.rows[0].is_active)
        return res.status(403).json({ error: 'Заявка ещё не подтверждена руководителем' });

      const { password: _drop, ...user } = r.rows[0];
      await c.query(`UPDATE staff SET last_login = now() WHERE id = $1`, [user.id]);
      return res.status(200).json({ data: user });
    }

    // ══ PATCH ═════════════════════════════════════════════════════════════
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });
      const b = req.body || {};
      const sets = [], params = [];

      if (b.approve === true) {
        sets.push('is_active = true', 'approved_at = now()');
        if (b.by) { params.push(b.by); sets.push(`approved_by = $${params.length}`); }
      }
      if (b.approve === false) sets.push('is_active = false');

      for (const k of ['name','phone','position','city','avatar','color']) {
        if (b[k] === undefined) continue;
        params.push(b[k]); sets.push(`${k} = $${params.length}`);
      }
      if (b.role) { params.push(b.role); sets.push(`role = $${params.length}::user_role`); }
      if (b.password) {
        if (String(b.password).length < 6)
          return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
        params.push(hashPassword(b.password)); sets.push(`password = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: 'нет полей для обновления' });

      params.push(id);
      const r = await c.query(
        `UPDATE staff SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING ${SAFE}`, params);
      if (!r.rowCount) return res.status(404).json({ error: 'Сотрудник не найден' });
      return res.status(200).json({ data: r.rows[0] });
    }

    // ══ DELETE ════════════════════════════════════════════════════════════
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id обязателен' });

      // Последнего руководителя удалить нельзя — иначе некому подтверждать
      const target = (await c.query(
        `SELECT role::text AS role FROM staff WHERE id = $1`, [id])).rows[0];
      if (!target) return res.status(404).json({ error: 'Сотрудник не найден' });

      if (target.role === 'admin') {
        const { rows: [{ cnt }] } = await c.query(
          `SELECT COUNT(*)::int AS cnt FROM staff
           WHERE role = 'admin' AND is_active AND id <> $1`, [id]);
        if (cnt === 0)
          return res.status(400).json({ error: 'Это единственный руководитель — удалить нельзя' });
      }

      await c.query(`DELETE FROM staff WHERE id = $1`, [id]);
      return res.status(200).json({ data: { id, deleted: true } });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('staff error:', e);
    return res.status(500).json({ error: e.message });
  }
}
