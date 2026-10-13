const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// Ajout de la colonne vue si elle n'existe pas encore
pool.query("ALTER TABLE rooms ADD COLUMN vue VARCHAR(150) NULL").catch(() => {});

function parseRoom(r) {
  let image_url = null;
  if (r.image) {
    image_url = r.image.startsWith('http') ? r.image : `${APP_URL}/storage/${r.image}`;
  }
  return { ...r, image_url };
}

async function index(req, res) {
  const { hotel_id, status, type, floor } = req.query;
  let sql = 'SELECT r.*, h.name as hotel_name FROM rooms r JOIN hotels h ON r.hotel_id = h.id WHERE 1=1';
  const params = [];
  if (req.user.role === 'employe') {
    if (!req.user.hotel_id) return res.json([]);
    sql += ' AND r.hotel_id = ?'; params.push(req.user.hotel_id);
  } else {
    if (hotel_id) { sql += ' AND r.hotel_id = ?'; params.push(hotel_id); }
  }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (type) { sql += ' AND r.type = ?'; params.push(type); }
  if (floor) { sql += ' AND r.floor = ?'; params.push(parseInt(floor)); }
  sql += ' ORDER BY r.floor, r.number';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(parseRoom));
}

async function show(req, res) {
  const [rows] = await pool.query(
    'SELECT r.*, h.name as hotel_name FROM rooms r JOIN hotels h ON r.hotel_id = h.id WHERE r.id = ?',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Chambre introuvable' });
  res.json(parseRoom(rows[0]));
}

async function store(req, res) {
  const { hotel_id, number, floor, type, price, capacity, superficie_m2, description, vue } = req.body;
  if (!hotel_id || !number) return res.status(422).json({ message: 'hotel_id et numéro requis' });
  if (!(await canManageHotel(req.user, hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  const [exist] = await pool.query('SELECT id FROM rooms WHERE hotel_id = ? AND number = ?', [hotel_id, number]);
  if (exist.length) return res.status(422).json({ message: 'Ce numéro de chambre existe déjà' });
  const imagePath = req.file ? req.file.path : null;
  const [result] = await pool.query(
    'INSERT INTO rooms (hotel_id, number, floor, type, price, capacity, superficie_m2, description, vue, image, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [hotel_id, number, floor || 1, type || 'Standard', price || 0, capacity || 2, superficie_m2, description, vue, imagePath, 'disponible']
  );
  const [newRoom] = await pool.query('SELECT * FROM rooms WHERE id = ?', [result.insertId]);
  res.status(201).json(parseRoom(newRoom[0]));
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Chambre introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette chambre.' });
  }
  const fields = ['number', 'floor', 'type', 'price', 'capacity', 'superficie_m2', 'description', 'vue', 'status'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (req.file) {
    updates.push('image = ?');
    params.push(req.file.path);
  }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE rooms SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  res.json(parseRoom(updated[0]));
}

async function updateStatus(req, res) {
  const { status } = req.body;
  const validStatuses = ['disponible', 'réservée', 'occupée', 'en_nettoyage', 'hors_service'];
  if (!validStatuses.includes(status)) return res.status(422).json({ message: 'Statut invalide' });
  const [rows] = await pool.query('SELECT hotel_id FROM rooms WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Chambre introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette chambre.' });
  }
  await pool.query('UPDATE rooms SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
  res.json({ message: 'Statut mis à jour', status });
}

async function markCleaned(req, res) {
  const [rows] = await pool.query('SELECT hotel_id FROM rooms WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Chambre introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette chambre.' });
  }
  await pool.query("UPDATE rooms SET status = 'disponible', updated_at = NOW() WHERE id = ?", [req.params.id]);
  res.json({ message: 'Chambre marquée propre' });
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM rooms WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Chambre introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette chambre.' });
  }
  await pool.query('DELETE FROM rooms WHERE id = ?', [req.params.id]);
  res.json({ message: 'Chambre supprimée' });
}

async function mine(req, res) {
  const { status } = req.query;
  let sql = `SELECT r.*, h.name as hotel_name, h.short_name as hotel_short_name
             FROM rooms r
             JOIN hotels h ON r.hotel_id = h.id
             WHERE h.user_id = ?`;
  const params = [req.user.id];
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  sql += ' ORDER BY h.name, r.floor, r.number';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(parseRoom));
}

module.exports = { index, mine, show, store, update, updateStatus, markCleaned, destroy };
