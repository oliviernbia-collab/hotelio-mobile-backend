const { pool } = require('../config/database');

async function get(req, res) {
  const [[hotelsCount]]       = await pool.query('SELECT COUNT(*) as total FROM hotels');
  const [[reservationsCount]] = await pool.query('SELECT COUNT(*) as total FROM reservations');
  const [[usersCount]]        = await pool.query('SELECT COUNT(*) as total FROM users');
  const [[reviewsCount]]      = await pool.query('SELECT COUNT(*) as total FROM reviews');
  const [[activeHotels]]      = await pool.query("SELECT COUNT(*) as total FROM hotels WHERE status = 'Ouvert'");
  const [[confirmedRes]]      = await pool.query("SELECT COUNT(*) as total FROM reservations WHERE status = 'confirmée'");
  const [[availableRooms]]    = await pool.query("SELECT COUNT(*) as total FROM rooms WHERE status = 'disponible'");
  const [[vipClients]]        = await pool.query("SELECT COUNT(*) as total FROM clients WHERE status = 'VIP'");

  res.json({
    platform: {
      name: 'Hôtelio',
      apiVersion: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
    },
    preferences: {
      defaultLanguage: 'Français (fr)',
      timezone: 'Africa/Abidjan (GMT+0)',
      currency: 'FCFA (XOF)',
      country: "Côte d'Ivoire",
      dateFormat: 'dd/mm/yyyy',
    },
    database: {
      hotels: hotelsCount.total,
      reservations: reservationsCount.total,
      users: usersCount.total,
      reviews: reviewsCount.total,
    },
    security: {
      httpsEncryption: true,
      jwtAuth: true,
      bcryptHashing: true,
    },
    stats: {
      activeHotels: activeHotels.total,
      confirmedReservations: confirmedRes.total,
      availableRooms: availableRooms.total,
      vipClients: vipClients.total,
    },
  });
}

module.exports = { get };
