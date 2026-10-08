const { pool } = require('../config/database');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function parseHotel(h) {
  return {
    ...h,
    services: Array.isArray(h.services)
      ? h.services
      : (typeof h.services === 'string' ? JSON.parse(h.services || '[]') : []),
    image_url: h.image ? `${APP_URL}/storage/${h.image}` : null,
  };
}

async function list(req, res) {
  const [rows] = await pool.query(
    `SELECT h.* FROM hotels h
     INNER JOIN favorites f ON f.hotel_id = h.id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC`,
    [req.user.id]
  );
  res.json(rows.map(parseHotel));
}

module.exports = { list };
