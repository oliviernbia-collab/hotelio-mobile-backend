const { pool } = require('../config/database');

function startOfPeriod(period) {
  const now = new Date();
  if (period === 'day') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (period === 'week') {
    const d = new Date(now);
    const diff = (d.getDay() + 6) % 7; // lundi = début de semaine
    d.setDate(d.getDate() - diff);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  if (period === 'year') {
    return new Date(now.getFullYear(), 0, 1);
  }
  return null; // 'all'
}

async function get(req, res) {
  const period = req.query.period || 'month';
  const dateFrom = startOfPeriod(period);
  const dateClause = dateFrom ? ' AND created_at >= ?' : '';
  const dateParam = dateFrom ? [dateFrom] : [];

  const [[revenueRow]] = await pool.query(
    `SELECT COALESCE(SUM(total), 0) as total FROM reservations WHERE paid = 1${dateClause}`,
    dateParam
  );
  const [[totalRow]] = await pool.query(
    `SELECT COUNT(*) as total FROM reservations WHERE 1=1${dateClause}`,
    dateParam
  );
  const [[confirmedRow]] = await pool.query(
    `SELECT COUNT(*) as total FROM reservations WHERE status = 'confirmée'${dateClause}`,
    dateParam
  );
  const [[cancelledRow]] = await pool.query(
    `SELECT COUNT(*) as total FROM reservations WHERE status = 'annulée'${dateClause}`,
    dateParam
  );
  const [byNationality] = await pool.query(
    `SELECT nationality, COUNT(*) as total, SUM(total) as revenue
     FROM reservations
     WHERE nationality IS NOT NULL AND nationality != ''${dateClause}
     GROUP BY nationality ORDER BY total DESC LIMIT 10`,
    dateParam
  );
  const [byRoomType] = await pool.query(
    `SELECT r.type as type, COUNT(*) as total
     FROM reservations res
     JOIN rooms r ON res.room_id = r.id
     WHERE 1=1${dateClause.replace('created_at', 'res.created_at')}
     GROUP BY r.type ORDER BY total DESC`,
    dateParam
  );
  const [hotels] = await pool.query(
    'SELECT id, name, short_name, city, revenue, rating FROM hotels ORDER BY revenue DESC LIMIT 6'
  );
  const [[ratingRow]] = await pool.query('SELECT AVG(rating) as avg_rating FROM hotels');

  res.json({
    period,
    totalRevenue: Number(revenueRow.total) || 0,
    totalReservations: totalRow.total,
    confirmedCount: confirmedRow.total,
    cancelledCount: cancelledRow.total,
    byNationality,
    byRoomType,
    hotels,
    avgRating: ratingRow.avg_rating ? Math.round(Number(ratingRow.avg_rating) * 10) / 10 : 0,
  });
}

module.exports = { get };
