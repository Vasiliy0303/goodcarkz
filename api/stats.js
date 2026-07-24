// GET /api/stats?city=Астана|Кокшетау|all
// Все цифры дашборда одним запросом. Колонки — по реальной схеме:
// deals.stage (enum) + deals.amount + deals.closed_at, cars.price, leads.*
const { Pool } = require('pg');

let pool;
function db() {
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return pool;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const city = req.query.city && req.query.city !== 'all' ? req.query.city : null;
  const p    = city ? [city] : [];
  const W    = city ? 'WHERE city = $1' : '';
  const AND  = city ? 'AND city = $1'   : '';

  try {
    const c = db();
    const q = (sql, params = p) => c.query(sql, params).then(r => r.rows);

    const [dealKpi, funnel, carsByStatus, leadsByChannel, leadsBySegment,
           byManager, recentDeals, salesSeries, leadCounts] = await Promise.all([

      // Закрытость сделки определяем по closed_at, а не по названию этапа —
      // код не зависит от значений enum и переживёт их переименование.
      q(`SELECT
           COALESCE(SUM(amount) FILTER (
             WHERE closed_at >= date_trunc('month', now())), 0)   AS revenue_month,
           COUNT(*) FILTER (
             WHERE closed_at >= date_trunc('month', now()))::int  AS sales_month,
           COUNT(*) FILTER (WHERE closed_at IS NULL)::int         AS in_progress,
           COUNT(*) FILTER (WHERE closed_at IS NOT NULL)::int     AS closed_total,
           COALESCE(AVG(amount) FILTER (WHERE closed_at IS NOT NULL), 0) AS avg_check,
           COALESCE(SUM(amount) FILTER (WHERE closed_at IS NULL), 0)     AS pipeline
         FROM deals ${W}`),

      q(`SELECT stage::text AS stage, COUNT(*)::int AS cnt,
                COALESCE(SUM(amount),0) AS sum_amount
         FROM deals ${W} GROUP BY 1 ORDER BY 1`),

      q(`SELECT COALESCE(status,'—') AS status, COUNT(*)::int AS cnt,
                COALESCE(SUM(price),0) AS sum_price
         FROM cars ${W} GROUP BY 1`),

      q(`SELECT COALESCE(channel,'—') AS channel, COUNT(*)::int AS cnt
         FROM leads WHERE COALESCE(status,'') <> 'База' ${AND}
         GROUP BY 1 ORDER BY cnt DESC`),

      q(`SELECT COALESCE(segment,'—') AS segment, COUNT(*)::int AS cnt
         FROM leads WHERE status = 'База' ${AND} GROUP BY 1 ORDER BY 1`),

      // Таблицы managers в базе нет — группируем по manager_id,
      // имена подставляет фронт из справочника сотрудников.
      q(`SELECT manager_id,
                COUNT(*)::int AS deals,
                COUNT(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed,
                COALESCE(SUM(amount) FILTER (WHERE closed_at IS NOT NULL),0) AS revenue
         FROM deals ${W}
         GROUP BY 1 ORDER BY revenue DESC, deals DESC LIMIT 8`),

      q(`SELECT id, title, client_name, amount, stage::text AS stage,
                created_at, closed_at
         FROM deals ${W} ORDER BY created_at DESC LIMIT 5`),

      q(`SELECT date_trunc('day', created_at)::date AS day,
                COUNT(*)::int AS cnt,
                COALESCE(SUM(amount),0) AS sum_amount
         FROM deals
         WHERE created_at >= now() - interval '30 days' ${AND}
         GROUP BY 1 ORDER BY 1`),

      q(`SELECT
           COUNT(*) FILTER (WHERE created_at::date = current_date)::int      AS today,
           COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS month,
           COUNT(*) FILTER (WHERE status = 'Новый')::int                     AS new_total,
           COUNT(*) FILTER (WHERE status = 'База')::int                      AS base_total,
           COUNT(*)::int                                                     AS all_total
         FROM leads ${W}`),
    ]);

    const k = dealKpi[0] || {};
    const l = leadCounts[0] || {};
    const num = v => Number(v || 0);

    res.status(200).json({
      city: city || 'all',
      generated_at: new Date().toISOString(),
      kpi: {
        revenue_month:   num(k.revenue_month),
        sales_month:     num(k.sales_month),
        pipeline:        num(k.pipeline),
        new_leads_today: l.today,
        new_leads_month: l.month,
        in_progress:     num(k.in_progress),
        closed_deals:    num(k.closed_total),
        avg_check:       Math.round(num(k.avg_check)),
      },
      leads: {
        new: l.new_total, base: l.base_total, total: l.all_total,
        by_channel: leadsByChannel, by_segment: leadsBySegment,
      },
      funnel,
      cars: {
        by_status: carsByStatus,
        total: carsByStatus.reduce((s, r) => s + r.cnt, 0),
        stock_value: carsByStatus.reduce((s, r) => s + Number(r.sum_price), 0),
      },
      managers: byManager,
      recent_deals: recentDeals,
      sales_series: salesSeries,
    });
  } catch (e) {
    console.error('stats error:', e);
    res.status(500).json({ error: e.message });
  }
};
