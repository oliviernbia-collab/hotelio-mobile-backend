const { pool } = require('../config/database');

// Un client n'a pas de hotel_id direct : le rattachement se fait via ses réservations
// (même logique que index()/topClients() — un prestataire/employé ne voit que les
// clients ayant séjourné dans l'un de ses hôtels).
async function canAccessClient(user, clientId) {
  if (user.role === 'admin') return true;

  let sql = `SELECT 1 FROM reservations res JOIN hotels h ON h.id = res.hotel_id WHERE res.client_id = ?`;
  const params = [clientId];

  if (user.role === 'prestataire') {
    sql += ' AND h.user_id = ?';
    params.push(user.id);
  } else if (user.role === 'employe') {
    if (!user.hotel_id) return false;
    sql += ' AND h.id = ?';
    params.push(user.hotel_id);
  } else {
    return false;
  }

  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows.length > 0;
}

async function index(req, res) {
  const { search, status, city } = req.query;
  let sql = `
    SELECT c.*,
      COALESCE(SUM(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN r.total ELSE 0 END), 0) AS total_spend,
      COUNT(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN 1 END) AS total_stays,
      MAX(r.checkin) AS last_visit
    FROM clients c
    LEFT JOIN reservations r ON r.client_id = c.id
    WHERE 1=1`;
  const params = [];
  if (search) {
    sql += ' AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.code LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  if (city)   { sql += ' AND c.city = ?';   params.push(city); }
  sql += ' GROUP BY c.id ORDER BY c.last_name, c.first_name';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function show(req, res) {
  const [rows] = await pool.query(`
    SELECT c.*,
      COALESCE(SUM(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN r.total ELSE 0 END), 0) AS total_spend,
      COUNT(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN 1 END) AS total_stays,
      MAX(r.checkin) AS last_visit
    FROM clients c
    LEFT JOIN reservations r ON r.client_id = c.id
    WHERE c.id = ?
    GROUP BY c.id`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Client introuvable' });
  if (!(await canAccessClient(req.user, req.params.id))) {
    return res.status(403).json({ message: 'Accès refusé à ce client.' });
  }
  const [reservations] = await pool.query(
    `SELECT res.*, h.name AS hotel_name, h.short_name AS hotel_short_name,
            r.number AS room_number, r.type AS room_type, r.price AS room_price
     FROM reservations res
     JOIN hotels h ON res.hotel_id = h.id
     LEFT JOIN rooms r ON res.room_id = r.id
     WHERE res.client_id = ?
     ORDER BY res.created_at DESC LIMIT 10`,
    [req.params.id]
  );
  res.json({ ...rows[0], reservations });
}

async function store(req, res) {
  const { first_name, last_name, email, phone, city, quartier, nationality, note } = req.body;
  if (!first_name || !last_name) return res.status(422).json({ message: 'Prénom et nom requis' });
  const code = 'CLI-' + Date.now().toString(36).toUpperCase();
  const [result] = await pool.query(
    'INSERT INTO clients (user_id, code, first_name, last_name, email, phone, city, quartier, nationality, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, code, first_name, last_name, email, phone, city, quartier, nationality, note, 'actif']
  );
  const [newClient] = await pool.query('SELECT * FROM clients WHERE id = ?', [result.insertId]);
  res.status(201).json(newClient[0]);
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT id FROM clients WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Client introuvable' });
  if (!(await canAccessClient(req.user, req.params.id))) {
    return res.status(403).json({ message: 'Accès refusé à ce client.' });
  }
  const fields = ['first_name', 'last_name', 'email', 'phone', 'city', 'quartier', 'nationality', 'note', 'status'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE clients SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id FROM clients WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Client introuvable' });
  if (!(await canAccessClient(req.user, req.params.id))) {
    return res.status(403).json({ message: 'Accès refusé à ce client.' });
  }
  await pool.query('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ message: 'Client supprimé' });
}

// Meilleurs clients d'un prestataire (via ses hôtels)
async function topClients(req, res) {
  const { limit = 20 } = req.query;
  let sql = `
    SELECT c.*,
      COALESCE(SUM(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN r.total ELSE 0 END), 0) AS total_spend,
      COUNT(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN 1 END) AS total_stays,
      MAX(r.checkin) AS last_visit,
      GROUP_CONCAT(DISTINCT h.short_name ORDER BY h.name SEPARATOR ', ') AS hotels_visited
    FROM clients c
    JOIN reservations r ON r.client_id = c.id
    JOIN hotels h ON h.id = r.hotel_id`;

  const params = [];
  if (req.user.role === 'prestataire') {
    sql += ' AND h.user_id = ?';
    params.push(req.user.id);
  }

  sql += `
    WHERE r.status IN ('confirmée','terminée','complétée')
    GROUP BY c.id
    ORDER BY total_spend DESC
    LIMIT ?`;
  params.push(Number(limit));

  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

// Attribuer / modifier des points de fidélité
async function addPoints(req, res) {
  const { points, reason } = req.body;
  if (points === undefined) return res.status(422).json({ message: 'points requis' });

  const [rows] = await pool.query('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Client introuvable' });
  if (!(await canAccessClient(req.user, req.params.id))) {
    return res.status(403).json({ message: 'Accès refusé à ce client.' });
  }

  const newTotal = Math.max(0, (rows[0].points_fidelite || 0) + Number(points));
  await pool.query(
    'UPDATE clients SET points_fidelite = ?, updated_at = NOW() WHERE id = ?',
    [newTotal, req.params.id]
  );

  const [updated] = await pool.query('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  res.json({ ...updated[0], message: `Points mis à jour : ${newTotal} pts` });
}

module.exports = { index, show, store, update, destroy, topClients, addPoints };
