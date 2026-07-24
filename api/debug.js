import pg from 'pg';
const { Pool } = pg;

// GET /api/debug — самодиагностика окружения.
// Ничего не роняет: каждая проверка в своём try/catch.
// После починки этот файл можно удалить.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const out = {
    node: process.version,
    region: process.env.VERCEL_REGION || null,
    checks: {},
  };

  // 1. Переменные окружения
  const url = process.env.DATABASE_URL;
  out.checks.env = {
    DATABASE_URL_задан: !!url,
    DATABASE_URL_длина: url ? url.length : 0,
    // Пароль не показываем — только хост, чтобы понять, та ли это база
    хост: url ? (url.match(/@([^/]+)/) || [])[1] || 'не разобрал' : null,
    JWT_SECRET_задан: !!process.env.JWT_SECRET,
    NODE_ENV: process.env.NODE_ENV || null,
  };

  // 2. Модуль pg импортирован статически выше — если бы его не было,
  //    функция не запустилась бы вовсе
  out.checks.pg = { загружен: true };

  if (!url) {
    out.вывод = 'DATABASE_URL не задан в переменных окружения проекта goodcarkz на Vercel.';
    return res.status(200).end(JSON.stringify(out, null, 2));
  }

  // 3. Реальное подключение к базе
  let pool;
  try {
    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 1,
      connectionTimeoutMillis: 8000,
    });
    // Без этого обработчика ошибка простаивающего клиента роняет весь процесс
    pool.on('error', e => console.error('pool error:', e.message));

    const r = await pool.query('SELECT now() AS время, current_database() AS база');
    out.checks.подключение = { успешно: true, ...r.rows[0] };

    // 4. Таблицы и колонки, от которых зависит API
    const t = await pool.query(`
      SELECT table_name, COUNT(*)::int AS колонок
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('cars','leads','deals','branches','app_users')
      GROUP BY table_name ORDER BY table_name`);
    out.checks.таблицы = Object.fromEntries(t.rows.map(r => [r.table_name, r.колонок]));

    const c = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM cars)     AS авто,
        (SELECT COUNT(*)::int FROM leads)    AS лиды,
        (SELECT COUNT(*)::int FROM deals)    AS сделки,
        (SELECT COUNT(*)::int FROM branches) AS филиалы`);
    out.checks.записей = c.rows[0];

    const city = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='city'
        AND table_name IN ('cars','leads','deals')`);
    out.checks.колонка_city_в_таблицах = city.rowCount;

    out.вывод = city.rowCount === 3
      ? 'Всё в порядке: база доступна, миграция на месте. Причина падения не здесь.'
      : 'База доступна, но колонка city есть не во всех таблицах — миграция прошла частично.';
  } catch (e) {
    out.checks.подключение = { успешно: false, ошибка: e.message, code: e.code };
    out.вывод = 'Модуль pg загрузился, но подключение к базе не удалось. Смотреть текст ошибки выше.';
  } finally {
    try { if (pool) await pool.end(); } catch (_) {}
  }

  return res.status(200).end(JSON.stringify(out, null, 2));
}
