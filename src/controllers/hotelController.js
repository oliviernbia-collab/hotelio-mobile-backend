const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

function parseHotel(h) {
  let services = [];
  try {
    if (Array.isArray(h.services)) {
      services = h.services;
    } else if (typeof h.services === 'string' && h.services) {
      const parsed = JSON.parse(h.services);
      if (Array.isArray(parsed)) services = parsed;
    }
  } catch {}

  let image_url = null;
  if (h.image) {
    if (h.image.startsWith('http')) {
      image_url = h.image;
    } else {
      // Toutes les images sont dans le storage public de Laravel,
      // servi par le backend mobile via la route statique /storage
      image_url = `${APP_URL}/storage/${h.image}`;
    }
  }

  return { ...h, services, image_url };
}

function parseServices(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch { return []; }
  }
  return [];
}

async function index(req, res) {
  const { city, commune, quartier, stars, status, search } = req.query;
  let sql = 'SELECT * FROM hotels WHERE 1=1';
  const params = [];
  if (city)     { sql += ' AND city = ?';                         params.push(city); }
  if (commune)  { sql += ' AND commune = ?';                      params.push(commune); }
  if (quartier) { sql += ' AND quartier = ?';                     params.push(quartier); }
  if (stars)    { sql += ' AND stars = ?';                        params.push(parseInt(stars)); }
  if (status)   { sql += ' AND status = ?';                       params.push(status); }
  if (search)   { sql += ' AND (name LIKE ? OR city LIKE ? OR commune LIKE ? OR quartier LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY name ASC';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(parseHotel));
}

async function show(req, res) {
  const [rows] = await pool.query('SELECT * FROM hotels WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Hôtel introuvable' });
  const hotel = parseHotel(rows[0]);
  const [rooms]   = await pool.query('SELECT * FROM rooms WHERE hotel_id = ? ORDER BY number', [hotel.id]);
  const [reviews] = await pool.query(
    'SELECT r.*, u.name as user_name FROM reviews r JOIN users u ON r.user_id = u.id WHERE r.hotel_id = ? AND r.status = ? ORDER BY r.created_at DESC LIMIT 10',
    [hotel.id, 'approved']
  );
  res.json({ ...hotel, rooms, reviews });
}

async function store(req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'prestataire') {
    return res.status(403).json({ message: "Vous n'avez pas le droit de créer un hôtel." });
  }
  const { name, short_name, city, commune, quartier, stars, rooms, category, price, description, services, manager, phone, email } = req.body;
  if (!name || !city) return res.status(422).json({ message: 'Nom et ville requis' });

  const servicesArr = parseServices(services);
  const imagePath   = req.file ? `uploads/hotels/${req.file.filename}` : null;

  const [result] = await pool.query(
    'INSERT INTO hotels (user_id, name, short_name, city, commune, quartier, stars, rooms, category, price, description, services, manager, phone, email, image, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, name, short_name, city, commune, quartier, stars || 3, rooms || 12, category, price || 210000, description, JSON.stringify(servicesArr), manager, phone, email, imagePath, 'Ouvert']
  );
  const [newHotel] = await pool.query('SELECT * FROM hotels WHERE id = ?', [result.insertId]);
  await logActivity(req.user, 'created', 'Hotel', result.insertId, `Hôtel "${name}" créé`, req.ip);
  res.status(201).json(parseHotel(newHotel[0]));
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT * FROM hotels WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Hôtel introuvable' });
  if (!(await canManageHotel(req.user, rows[0].id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }

  const scalarFields = ['name', 'short_name', 'city', 'commune', 'quartier', 'stars', 'rooms', 'category', 'price', 'description', 'manager', 'phone', 'email', 'status', 'rating', 'emoji', 'color'];
  const updates = [];
  const params  = [];

  scalarFields.forEach(f => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  });

  if (req.body.services !== undefined) {
    updates.push('services = ?');
    params.push(JSON.stringify(parseServices(req.body.services)));
  }

  if (req.file) {
    updates.push('image = ?');
    params.push(`uploads/hotels/${req.file.filename}`);
  }

  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée à mettre à jour' });
  params.push(req.params.id);

  await pool.query(`UPDATE hotels SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM hotels WHERE id = ?', [req.params.id]);
  res.json(parseHotel(updated[0]));
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, name FROM hotels WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Hôtel introuvable' });
  if (!(await canManageHotel(req.user, rows[0].id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  await pool.query('DELETE FROM hotels WHERE id = ?', [req.params.id]);
  res.json({ message: 'Hôtel supprimé' });
}

async function addReview(req, res) {
  const { rating, comment, title } = req.body;
  if (!rating || !comment) return res.status(422).json({ message: 'Note et commentaire requis' });
  const [existing] = await pool.query('SELECT id FROM reviews WHERE hotel_id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (existing.length) {
    await pool.query('UPDATE reviews SET rating = ?, comment = ?, title = ?, status = ?, updated_at = NOW() WHERE hotel_id = ? AND user_id = ?',
      [rating, comment, title, 'pending', req.params.id, req.user.id]);
  } else {
    await pool.query('INSERT INTO reviews (hotel_id, user_id, rating, comment, title, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, req.user.id, rating, comment, title, 'pending']);
  }
  res.json({ message: 'Avis soumis, en attente de validation' });
}

async function toggleFavorite(req, res) {
  const [existing] = await pool.query('SELECT id FROM favorites WHERE user_id = ? AND hotel_id = ?', [req.user.id, req.params.id]);
  if (existing.length) {
    await pool.query('DELETE FROM favorites WHERE user_id = ? AND hotel_id = ?', [req.user.id, req.params.id]);
    return res.json({ favorited: false });
  }
  await pool.query('INSERT INTO favorites (user_id, hotel_id) VALUES (?, ?)', [req.user.id, req.params.id]);
  res.json({ favorited: true });
}

async function mine(req, res) {
  const [rows] = await pool.query('SELECT * FROM hotels WHERE user_id = ? ORDER BY name ASC', [req.user.id]);
  res.json(rows.map(parseHotel));
}

async function logActivity(user, action, model, modelId, description, ip) {
  await pool.query(
    'INSERT INTO activity_logs (user_id, user_name, user_role, action, model_type, model_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [user.id, user.name, user.role, action, model, modelId, description, ip]
  ).catch(() => {});
}

module.exports = { index, mine, show, store, update, destroy, addReview, toggleFavorite };
