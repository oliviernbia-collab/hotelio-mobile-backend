const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

async function index(req, res) {
  const { hotel_id, status, priority, ticket_type } = req.query;
  let sql = `SELECT t.*, h.name as hotel_name, c.first_name, c.last_name
             FROM tickets t
             JOIN hotels h ON t.hotel_id = h.id
             LEFT JOIN clients c ON t.client_id = c.id
             WHERE 1=1`;
  const params = [];

  if (req.user.role === 'prestataire') {
    sql += ' AND h.user_id = ?';
    params.push(req.user.id);
  } else if (req.user.role === 'employe') {
    if (!req.user.hotel_id) return res.json([]);
    sql += ' AND t.hotel_id = ?';
    params.push(req.user.hotel_id);
  }

  if (hotel_id) { sql += ' AND t.hotel_id = ?'; params.push(hotel_id); }
  if (status)   { sql += ' AND t.status = ?'; params.push(status); }
  if (priority) { sql += ' AND t.priority = ?'; params.push(priority); }
  if (ticket_type) { sql += ' AND t.ticket_type = ?'; params.push(ticket_type); }
  sql += ' ORDER BY t.created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function show(req, res) {
  const [rows] = await pool.query(
    `SELECT t.*, h.name as hotel_name, c.first_name, c.last_name, c.phone as client_phone
     FROM tickets t
     JOIN hotels h ON t.hotel_id = h.id
     LEFT JOIN clients c ON t.client_id = c.id
     WHERE t.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Ticket introuvable' });
  res.json(rows[0]);
}

async function store(req, res) {
  const { hotel_id, client_id, title, ticket_type, priority, description, assigned_to } = req.body;
  if (!hotel_id || !title) return res.status(422).json({ message: 'hotel_id et titre requis' });

  if (req.user.role === 'prestataire') {
    const [h] = await pool.query('SELECT id FROM hotels WHERE id = ? AND user_id = ?', [hotel_id, req.user.id]);
    if (!h.length) return res.status(403).json({ message: "Cet hôtel ne vous appartient pas." });
  } else if (req.user.role === 'employe' && req.user.hotel_id && Number(hotel_id) !== req.user.hotel_id) {
    return res.status(403).json({ message: "Accès refusé à cet hôtel." });
  }

  const [result] = await pool.query(
    'INSERT INTO tickets (hotel_id, client_id, title, ticket_type, status, priority, description, assigned_to, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
    [hotel_id, client_id || null, title, ticket_type || 'support', 'ouvert', priority || 'normal', description, assigned_to]
  );
  const [newTicket] = await pool.query('SELECT * FROM tickets WHERE id = ?', [result.insertId]);
  res.status(201).json(newTicket[0]);
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Ticket introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à ce ticket.' });
  }
  const fields = ['title', 'ticket_type', 'status', 'priority', 'description', 'assigned_to'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (req.body.status === 'résolu' || req.body.status === 'fermé') {
    updates.push('closed_at = NOW()');
  }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE tickets SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM tickets WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Ticket introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à ce ticket.' });
  }
  await pool.query('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  res.json({ message: 'Ticket supprimé' });
}

module.exports = { index, show, store, update, destroy };
