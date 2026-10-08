const { pool } = require('../config/database');

// Vérifie que l'utilisateur authentifié a le droit de gérer (créer/modifier/supprimer)
// une ressource rattachée à un hôtel donné (chambre, personnel, dépense, ticket...).
async function canManageHotel(user, hotelId) {
  if (user.role === 'admin') return true;
  if (!hotelId) return false;
  if (user.role === 'prestataire') {
    const [rows] = await pool.query('SELECT id FROM hotels WHERE id = ? AND user_id = ?', [hotelId, user.id]);
    return rows.length > 0;
  }
  if (user.role === 'employe') {
    return Number(user.hotel_id) === Number(hotelId);
  }
  return false;
}

module.exports = { canManageHotel };
