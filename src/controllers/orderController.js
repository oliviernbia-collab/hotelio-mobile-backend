const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

async function index(req, res) {
  const { hotel_id, status, client_id, from, to } = req.query;
  let sql = `SELECT o.*, m.name as item_name, m.emoji, c.first_name, c.last_name
             FROM orders o
             JOIN menu_items m ON o.menu_item_id = m.id
             LEFT JOIN clients c ON o.client_id = c.id
             WHERE 1=1`;
  const params = [];

  if (req.user.role === 'employe') {
    if (!req.user.hotel_id) return res.json([]);
    sql += ' AND o.hotel_id = ?'; params.push(req.user.hotel_id);
  } else if (req.user.role === 'prestataire') {
    sql += ' AND o.hotel_id IN (SELECT id FROM hotels WHERE user_id = ?)'; params.push(req.user.id);
    if (hotel_id) { sql += ' AND o.hotel_id = ?'; params.push(hotel_id); }
  } else if (hotel_id) {
    sql += ' AND o.hotel_id = ?'; params.push(hotel_id);
  }

  if (status) { sql += ' AND o.status = ?'; params.push(status); }
  if (client_id) { sql += ' AND o.client_id = ?'; params.push(client_id); }
  if (from) { sql += ' AND o.ordered_at >= ?'; params.push(from); }
  if (to)   { sql += ' AND o.ordered_at <= ?'; params.push(`${to} 23:59:59`); }
  sql += ' ORDER BY o.created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function store(req, res) {
  const { hotel_id, client_id, menu_item_id, quantity, notes } = req.body;
  if (!hotel_id || !menu_item_id) return res.status(422).json({ message: 'hotel_id et menu_item_id requis' });
  if (!(await canManageHotel(req.user, hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  const [item] = await pool.query('SELECT * FROM menu_items WHERE id = ?', [menu_item_id]);
  if (!item.length) return res.status(404).json({ message: 'Article de menu introuvable' });
  if (!item[0].available) return res.status(422).json({ message: 'Article non disponible' });
  const qty = quantity || 1;
  const total = item[0].price * qty;
  const [result] = await pool.query(
    'INSERT INTO orders (hotel_id, client_id, menu_item_id, quantity, total, status, notes, ordered_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
    [hotel_id, client_id || null, menu_item_id, qty, total, 'en préparation', notes]
  );
  if (item[0].stock > 0) {
    await pool.query('UPDATE menu_items SET stock = stock - ? WHERE id = ?', [qty, menu_item_id]);
  }
  const [newOrder] = await pool.query('SELECT * FROM orders WHERE id = ?', [result.insertId]);
  res.status(201).json(newOrder[0]);
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM orders WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Commande introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette commande.' });
  }
  const { status, notes } = req.body;
  const updates = [];
  const params = [];
  if (status) { updates.push('status = ?'); params.push(status); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
  if (status === 'livré') { updates.push('delivered_at = NOW()'); }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE orders SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM orders WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Commande introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette commande.' });
  }
  await pool.query('DELETE FROM orders WHERE id = ?', [req.params.id]);
  res.json({ message: 'Commande supprimée' });
}

module.exports = { index, store, update, destroy };
