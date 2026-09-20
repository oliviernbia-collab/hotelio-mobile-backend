const { pool } = require('../config/database');

async function index(req, res) {
  const { role, id: userId, email } = req.user;

  try {
    // ── CLIENT ───────────────────────────────────────────────────────────────
    if (role === 'client') {
      // Lookup by user_id first (most reliable), then fall back to email
      const clientQuery = `
        SELECT c.*,
          COALESCE(SUM(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN r.total ELSE 0 END), 0) AS calc_spend,
          COUNT(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN 1 END) AS calc_stays
        FROM clients c
        LEFT JOIN reservations r ON r.client_id = c.id
        WHERE c.user_id = ?
        GROUP BY c.id`;
      let [clientRows] = await pool.query(clientQuery, [userId]);

      if (!clientRows.length) {
        const clientQueryByEmail = `
          SELECT c.*,
            COALESCE(SUM(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN r.total ELSE 0 END), 0) AS calc_spend,
            COUNT(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN 1 END) AS calc_stays
          FROM clients c
          LEFT JOIN reservations r ON r.client_id = c.id
          WHERE c.email = ?
          GROUP BY c.id`;
        [clientRows] = await pool.query(clientQueryByEmail, [email]);
      }

      const client = clientRows[0];

      if (!client) {
        return res.json({
          stats: { total_stays: 0, total_spend: 0, loyalty_points: 0, reservations: 0 },
          recent_reservations: [],
        });
      }

      const [[resCount]] = await pool.query(
        'SELECT COUNT(*) as count FROM reservations WHERE client_id = ?', [client.id]
      );
      const [recentRes] = await pool.query(
        `SELECT res.id, res.code, res.status, res.checkin, res.checkout, h.short_name
         FROM reservations res
         JOIN hotels h ON res.hotel_id = h.id
         WHERE res.client_id = ?
         ORDER BY res.created_at DESC LIMIT 3`,
        [client.id]
      );

      return res.json({
        stats: {
          total_stays:    Number(client.calc_stays)  || 0,
          total_spend:    Number(client.calc_spend)  || 0,
          loyalty_points: client.points_fidelite     || 0,
          reservations:   resCount.count             || 0,
        },
        recent_reservations: recentRes.map(r => ({
          id: r.id, code: r.code, status: r.status,
          checkin: r.checkin, checkout: r.checkout,
          hotel: { short_name: r.short_name },
        })),
      });
    }

    // ── ADMIN ────────────────────────────────────────────────────────────────
    if (role === 'admin') {
      const [[totalUsers]]        = await pool.query("SELECT COUNT(*) as count FROM users WHERE status = 'actif'");
      const [[totalHotels]]       = await pool.query('SELECT COUNT(*) as count FROM hotels');
      const [[totalReservations]] = await pool.query('SELECT COUNT(*) as count FROM reservations');
      const [[revenue]]           = await pool.query("SELECT COALESCE(SUM(total),0) as total FROM reservations WHERE status IN ('confirmée','terminée')");

      const [recentRes] = await pool.query(
        `SELECT res.id, res.code, res.status, res.checkin, res.checkout,
                c.first_name, c.last_name, h.short_name
         FROM reservations res
         JOIN clients c ON res.client_id = c.id
         JOIN hotels  h ON res.hotel_id  = h.id
         ORDER BY res.created_at DESC LIMIT 5`
      );

      return res.json({
        stats: {
          total_users:        totalUsers.count,
          total_hotels:       totalHotels.count,
          total_reservations: totalReservations.count,
          total_revenue:      revenue.total,
        },
        recent_reservations: recentRes.map(r => ({
          id: r.id, code: r.code, status: r.status,
          checkin: r.checkin, checkout: r.checkout,
          client: { first_name: r.first_name, last_name: r.last_name },
          hotel:  { short_name: r.short_name },
        })),
      });
    }

    // ── PRESTATAIRE ──────────────────────────────────────────────────────────
    if (role === 'prestataire') {
      const [[myHotels]] = await pool.query(
        'SELECT COUNT(*) as count FROM hotels WHERE user_id = ?', [userId]
      );
      const [[availableRooms]] = await pool.query(
        `SELECT COUNT(*) as count FROM rooms r
         JOIN hotels h ON r.hotel_id = h.id
         WHERE h.user_id = ? AND r.status = 'disponible'`, [userId]
      );
      const [[activeRes]] = await pool.query(
        `SELECT COUNT(*) as count FROM reservations res
         JOIN hotels h ON res.hotel_id = h.id
         WHERE h.user_id = ? AND res.status IN ('en_attente','confirmée')`, [userId]
      );
      const [[totalRevenue]] = await pool.query(
        `SELECT COALESCE(SUM(res.total),0) as total FROM reservations res
         JOIN hotels h ON res.hotel_id = h.id
         WHERE h.user_id = ? AND res.status IN ('confirmée','terminée')`, [userId]
      );

      return res.json({
        stats: {
          my_hotels:           myHotels.count,
          available_rooms:     availableRooms.count,
          active_reservations: activeRes.count,
          total_revenue:       totalRevenue.total,
        },
        recent_reservations: [],
      });
    }

    // ── EMPLOYÉ ──────────────────────────────────────────────────────────────
    const hotelId = req.user.hotel_id ?? null;

    if (!hotelId) {
      return res.json({
        stats: { available_rooms: 0, occupied_rooms: 0, today_checkins: 0, today_checkouts: 0 },
        recent_reservations: [],
      });
    }

    const [[availRooms]] = await pool.query(
      "SELECT COUNT(*) as count FROM rooms WHERE status = 'disponible' AND hotel_id = ?", [hotelId]
    );
    const [[occRooms]] = await pool.query(
      "SELECT COUNT(*) as count FROM rooms WHERE status = 'occupée' AND hotel_id = ?", [hotelId]
    );
    const [[todayCI]] = await pool.query(
      "SELECT COUNT(*) as count FROM reservations WHERE DATE(checkin_at) = CURDATE() AND hotel_id = ?", [hotelId]
    );
    const [[todayCO]] = await pool.query(
      "SELECT COUNT(*) as count FROM reservations WHERE DATE(checkout_at) = CURDATE() AND hotel_id = ?", [hotelId]
    );

    res.json({
      stats: {
        available_rooms:  availRooms.count,
        occupied_rooms:   occRooms.count,
        today_checkins:   todayCI.count,
        today_checkouts:  todayCO.count,
      },
      recent_reservations: [],
    });

  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ message: 'Erreur serveur dashboard' });
  }
}

module.exports = { index };
