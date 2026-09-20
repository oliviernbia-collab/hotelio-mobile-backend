const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

async function index(req, res) {
  const { hotel_id, status } = req.query;
  let sql = 'SELECT p.*, h.name as hotel_name FROM pools p JOIN hotels h ON p.hotel_id = h.id WHERE 1=1';
  const params = [];
  if (hotel_id) { sql += ' AND p.hotel_id = ?'; params.push(hotel_id); }
  if (status) { sql += ' AND p.status = ?'; params.push(status); }
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function store(req, res) {
  const { hotel_id, name, status, area, depth, temperature, description } = req.body;
  if (!hotel_id) return res.status(422).json({ message: 'hotel_id requis' });
  if (!(await canManageHotel(req.user, hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  const [result] = await pool.query(
    'INSERT INTO pools (hotel_id, name, status, area, depth, temperature, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [hotel_id, name || 'Piscine principale', status || 'ouverte', area, depth, temperature, description]
  );
  const [newPool] = await pool.query('SELECT * FROM pools WHERE id = ?', [result.insertId]);
  res.status(201).json(newPool[0]);
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM pools WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Piscine introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette piscine.' });
  }
  const fields = ['name', 'status', 'area', 'depth', 'temperature', 'description'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE pools SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM pools WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM pools WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Piscine introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette piscine.' });
  }
  await pool.query('DELETE FROM pools WHERE id = ?', [req.params.id]);
  res.json({ message: 'Piscine supprimée' });
}

module.exports = { index, store, update, destroy };
