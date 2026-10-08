const { pool } = require('../config/database');

async function index(req, res) {
  const { hotel_id, item_type, available } = req.query;
  let sql = 'SELECT mi.* FROM menu_items mi';
  const params = [];

  if (req.user.role === 'prestataire') {
    sql += ' JOIN hotels h ON h.id = mi.hotel_id WHERE h.user_id = ?';
    params.push(req.user.id);
    if (hotel_id)  { sql += ' AND mi.hotel_id = ?'; params.push(hotel_id); }
    if (item_type) { sql += ' AND mi.item_type = ?'; params.push(item_type); }
    if (available !== undefined) { sql += ' AND mi.available = ?'; params.push(available === 'true' ? 1 : 0); }
  } else if (req.user.role === 'employe') {
    if (!req.user.hotel_id) return res.json([]);
    sql += ' WHERE mi.hotel_id = ?';
    params.push(req.user.hotel_id);
    if (item_type) { sql += ' AND mi.item_type = ?'; params.push(item_type); }
    if (available !== undefined) { sql += ' AND mi.available = ?'; params.push(available === 'true' ? 1 : 0); }
  } else {
    sql += ' WHERE 1=1';
    if (hotel_id)  { sql += ' AND mi.hotel_id = ?'; params.push(hotel_id); }
    if (item_type) { sql += ' AND mi.item_type = ?'; params.push(item_type); }
    if (available !== undefined) { sql += ' AND mi.available = ?'; params.push(available === 'true' ? 1 : 0); }
  }

  sql += ' ORDER BY mi.item_type, mi.name';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function store(req, res) {
  const { hotel_id, name, item_type, category, price, stock, emoji, description } = req.body;
  if (!hotel_id || !name) return res.status(422).json({ message: 'hotel_id et nom requis' });

  // Prestataire : vérifier que l'hôtel lui appartient
  if (req.user.role === 'prestataire') {
    const [h] = await pool.query('SELECT id FROM hotels WHERE id = ? AND user_id = ?', [hotel_id, req.user.id]);
    if (!h.length) return res.status(403).json({ message: "Cet hôtel ne vous appartient pas." });
  }

  const [result] = await pool.query(
    'INSERT INTO menu_items (hotel_id, name, item_type, category, price, stock, emoji, description, available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [hotel_id, name, item_type || 'plat', category, price || 0, stock || 0, emoji, description, 1]
  );
  const [newItem] = await pool.query('SELECT * FROM menu_items WHERE id = ?', [result.insertId]);
  res.status(201).json(newItem[0]);
}

async function update(req, res) {
  const ownerCheck = req.user.role === 'prestataire'
    ? 'SELECT mi.id FROM menu_items mi JOIN hotels h ON h.id = mi.hotel_id WHERE mi.id = ? AND h.user_id = ?'
    : 'SELECT id FROM menu_items WHERE id = ?';
  const ownerParams = req.user.role === 'prestataire'
    ? [req.params.id, req.user.id]
    : [req.params.id];

  const [rows] = await pool.query(ownerCheck, ownerParams);
  if (!rows.length) return res.status(404).json({ message: 'Article introuvable ou accès refusé' });

  const fields = ['name', 'item_type', 'category', 'price', 'stock', 'emoji', 'description', 'available'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE menu_items SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM menu_items WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const ownerCheck = req.user.role === 'prestataire'
    ? 'SELECT mi.id FROM menu_items mi JOIN hotels h ON h.id = mi.hotel_id WHERE mi.id = ? AND h.user_id = ?'
    : 'SELECT id FROM menu_items WHERE id = ?';
  const ownerParams = req.user.role === 'prestataire'
    ? [req.params.id, req.user.id]
    : [req.params.id];

  const [rows] = await pool.query(ownerCheck, ownerParams);
  if (!rows.length) return res.status(404).json({ message: 'Article introuvable ou accès refusé' });

  await pool.query('DELETE FROM menu_items WHERE id = ?', [req.params.id]);
  res.json({ message: 'Article supprimé' });
}

module.exports = { index, store, update, destroy };
