// api/stats.js
// GET /api/stats — данные для дашборда руководителя

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [
      revenueResult,
      leadsResult,
      dealsResult,
      carsResult,
      managersResult,
      funnelResult,
    ] = await Promise.all([
      // Выручка за месяц
      pool.query(`
        SELECT
          COALESCE(SUM(amount),0) AS this_month,
          COALESCE(SUM(CASE WHEN closed_at >= NOW() - INTERVAL '2 months'
            AND closed_at < NOW() - INTERVAL '1 month' THEN amount END),0) AS last_month
        FROM deals
        WHERE stage = 'closed'
          AND closed_at >= DATE_TRUNC('month', NOW())
      `),
      // Лиды
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 day' THEN 1 END) AS today,
          COUNT(CASE WHEN status = 'new' THEN 1 END) AS new_count
        FROM leads
        WHERE created_at >= DATE_TRUNC('month', NOW())
      `),
      // Сделки
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN stage NOT IN ('closed','lost') THEN 1 END) AS in_progress,
          COUNT(CASE WHEN stage = 'closed' THEN 1 END) AS closed,
          COUNT(CASE WHEN stage = 'lost' THEN 1 END) AS lost,
          COALESCE(AVG(CASE WHEN stage = 'closed' THEN amount END),0) AS avg_check
        FROM deals
      `),
      // Автомобили
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN status = 'В продаже' THEN 1 END) AS for_sale,
          COUNT(CASE WHEN status = 'В резерве' THEN 1 END) AS reserved,
          COUNT(CASE WHEN status = 'На подготовке' THEN 1 END) AS in_prep,
          COUNT(CASE WHEN status = 'На аукционе' THEN 1 END) AS on_auction,
          COUNT(CASE WHEN EXTRACT(DAY FROM NOW()-created_at) > 60 THEN 1 END) AS over_60_days
        FROM cars
        WHERE status NOT IN ('Продан','Архив')
      `),
      // Топ менеджеров
      pool.query(`
        SELECT
          u.id, u.name,
          COUNT(d.id) AS deals_count,
          COALESCE(SUM(CASE WHEN d.stage='closed' THEN d.amount END),0) AS won_amount,
          COALESCE(SUM(CASE WHEN d.stage NOT IN ('closed','lost') THEN d.amount END),0) AS pipeline
        FROM users u
        LEFT JOIN deals d ON d.manager_id = u.id
          AND d.created_at >= DATE_TRUNC('month', NOW())
        WHERE u.role = 'manager'
        GROUP BY u.id, u.name
        ORDER BY won_amount DESC
        LIMIT 5
      `),
      // Воронка
      pool.query(`
        SELECT stage, COUNT(*) AS count
        FROM deals
        GROUP BY stage
        ORDER BY
          CASE stage
            WHEN 'new' THEN 1 WHEN 'consultation' THEN 2
            WHEN 'showing' THEN 3 WHEN 'proposal' THEN 4
            WHEN 'deposit' THEN 5 WHEN 'closed' THEN 6 ELSE 7
          END
      `),
    ]);

    const rev = revenueResult.rows[0];
    const leads = leadsResult.rows[0];
    const deals = dealsResult.rows[0];
    const cars = carsResult.rows[0];

    // Конверсия
    const convRate = deals.total > 0
      ? Math.round(deals.closed / deals.total * 100)
      : 0;

    // Рост выручки
    const revenueGrowth = rev.last_month > 0
      ? Math.round((rev.this_month - rev.last_month) / rev.last_month * 100)
      : 0;

    return res.status(200).json({
      revenue: {
        this_month: parseFloat(rev.this_month),
        last_month: parseFloat(rev.last_month),
        growth_pct: revenueGrowth,
      },
      leads: {
        total: parseInt(leads.total),
        today: parseInt(leads.today),
        new: parseInt(leads.new_count),
      },
      deals: {
        total: parseInt(deals.total),
        in_progress: parseInt(deals.in_progress),
        closed: parseInt(deals.closed),
        lost: parseInt(deals.lost),
        avg_check: parseFloat(deals.avg_check),
        conversion_pct: convRate,
      },
      cars: {
        total: parseInt(cars.total),
        for_sale: parseInt(cars.for_sale),
        reserved: parseInt(cars.reserved),
        in_prep: parseInt(cars.in_prep),
        on_auction: parseInt(cars.on_auction),
        over_60_days: parseInt(cars.over_60_days),
      },
      top_managers: managersResult.rows.map(m => ({
        id: m.id,
        name: m.name,
        deals_count: parseInt(m.deals_count),
        won_amount: parseFloat(m.won_amount),
        pipeline: parseFloat(m.pipeline),
      })),
      funnel: funnelResult.rows,
    });

  } catch (err) {
    console.error('stats API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
