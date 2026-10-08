const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

async function index(req, res) {
  const { hotel_id, expense_type, from, to } = req.query;
  let sql = 'SELECT e.*, h.name as hotel_name FROM expenses e JOIN hotels h ON e.hotel_id = h.id WHERE 1=1';
  const params = [];
  // Prestataires see only their own hotels' expenses
  if (req.user.role === 'prestataire') {
    sql += ' AND h.user_id = ?';
    params.push(req.user.id);
  }
  if (hotel_id) { sql += ' AND e.hotel_id = ?'; params.push(hotel_id); }
  if (expense_type) { sql += ' AND e.expense_type = ?'; params.push(expense_type); }
  if (from) { sql += ' AND e.occurred_at >= ?'; params.push(from); }
  if (to) { sql += ' AND e.occurred_at <= ?'; params.push(to); }
  sql += ' ORDER BY e.occurred_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function store(req, res) {
  const { hotel_id, description, amount, expense_type, occurred_at, notes } = req.body;
  if (!hotel_id || !description || !amount) return res.status(422).json({ message: 'hotel_id, description et montant requis' });
  if (!(await canManageHotel(req.user, hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  const [result] = await pool.query(
    'INSERT INTO expenses (hotel_id, description, amount, expense_type, occurred_at, notes) VALUES (?, ?, ?, ?, ?, ?)',
    [hotel_id, description, amount, expense_type, occurred_at || new Date().toISOString().split('T')[0], notes]
  );
  const [newExp] = await pool.query('SELECT * FROM expenses WHERE id = ?', [result.insertId]);
  res.status(201).json(newExp[0]);
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM expenses WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Dépense introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette dépense.' });
  }
  const fields = ['description', 'amount', 'expense_type', 'occurred_at', 'notes'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE expenses SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM expenses WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM expenses WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Dépense introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette dépense.' });
  }
  await pool.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
  res.json({ message: 'Dépense supprimée' });
}

module.exports = { index, store, update, destroy };
