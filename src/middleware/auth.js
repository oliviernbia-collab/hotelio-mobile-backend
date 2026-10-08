const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Token manquant' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const [rows] = await pool.query(
      'SELECT id, name, email, role, status, hotels FROM users WHERE id = ?',
      [decoded.id]
    );
    if (!rows.length) {
      return res.status(401).json({ message: 'Utilisateur introuvable' });
    }
    if (rows[0].status !== 'actif') {
      return res.status(403).json({ message: 'Compte inactif' });
    }
    const user = rows[0];
    if (user.role === 'employe') {
      const [staffRows] = await pool.query(
        'SELECT hotel_id FROM staff WHERE user_id = ? LIMIT 1',
        [user.id]
      );
      user.hotel_id = staffRows.length ? staffRows[0].hotel_id : null;
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalide' });
  }
}

function isAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Accès réservé aux administrateurs' });
  }
  next();
}

function isPrestataire(req, res, next) {
  if (!['admin', 'prestataire'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Accès refusé' });
  }
  next();
}

module.exports = { authenticate, isAdmin, isPrestataire };
