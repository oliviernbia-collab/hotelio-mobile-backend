const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

pool.query(`
  CREATE TABLE IF NOT EXISTS hotel_services (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    hotel_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100) DEFAULT 'Général',
    description TEXT,
    price DECIMAL(15,2) DEFAULT 0,
    emoji VARCHAR(20) DEFAULT '✨',
    available TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (hotel_id) REFERENCES hotels(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`).catch(() => {});

async function index(req, res) {
  const { hotel_id } = req.query;
  let sql = `SELECT s.*, h.name as hotel_name, h.short_name as hotel_short_name
             FROM hotel_services s JOIN hotels h ON s.hotel_id = h.id WHERE 1=1`;
  const params = [];
  if (req.user.role === 'prestataire') {
    sql += ' AND h.user_id = ?';
    params.push(req.user.id);
  }
  if (hotel_id) { sql += ' AND s.hotel_id = ?'; params.push(hotel_id); }
  sql += ' ORDER BY s.category, s.name';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function store(req, res) {
  const { hotel_id, name, category, description, price, emoji } = req.body;
  if (!hotel_id || !name) return res.status(422).json({ message: 'hotel_id et nom requis' });
  if (!(await canManageHotel(req.user, hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  const [result] = await pool.query(
    'INSERT INTO hotel_services (hotel_id, name, category, description, price, emoji) VALUES (?, ?, ?, ?, ?, ?)',
    [hotel_id, name.trim(), category || 'Général', description, price || 0, emoji || '✨']
  );
  const [row] = await pool.query('SELECT * FROM hotel_services WHERE id = ?', [result.insertId]);
  res.status(201).json(row[0]);
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM hotel_services WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Service introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à ce service.' });
  }
  const fields = ['name', 'category', 'description', 'price', 'emoji', 'available'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE hotel_services SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM hotel_services WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM hotel_services WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Service introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à ce service.' });
  }
  await pool.query('DELETE FROM hotel_services WHERE id = ?', [req.params.id]);
  res.json({ message: 'Service supprimé' });
}

module.exports = { index, store, update, destroy };
