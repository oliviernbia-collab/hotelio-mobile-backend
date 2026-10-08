const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { canManageHotel } = require('../utils/authorize');

pool.query("ALTER TABLE staff ADD COLUMN tasks TEXT NULL").catch(() => {});
pool.query("ALTER TABLE staff ADD COLUMN user_id INT NULL").catch(() => {});

function parseTasks(row) {
  if (!row) return row;
  return {
    ...row,
    tasks: row.tasks ? (typeof row.tasks === 'string' ? JSON.parse(row.tasks) : row.tasks) : [],
  };
}

async function me(req, res) {
  const [rows] = await pool.query(
    `SELECT s.*, h.name AS hotel_name, h.short_name AS hotel_short_name, h.city AS hotel_city
     FROM staff s
     JOIN hotels h ON s.hotel_id = h.id
     WHERE s.user_id = ?`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Fiche employé introuvable' });
  res.json(parseTasks(rows[0]));
}

async function index(req, res) {
  const { hotel_id, status, role } = req.query;
  let sql = 'SELECT s.*, h.name as hotel_name, h.short_name as hotel_short_name FROM staff s JOIN hotels h ON s.hotel_id = h.id WHERE 1=1';
  const params = [];
  if (req.user.role === 'prestataire') {
    sql += ' AND h.user_id = ?';
    params.push(req.user.id);
  }
  if (hotel_id) { sql += ' AND s.hotel_id = ?'; params.push(hotel_id); }
  if (status)   { sql += ' AND s.status = ?';   params.push(status); }
  if (role)     { sql += ' AND s.role = ?';      params.push(role); }
  sql += ' ORDER BY s.last_name, s.first_name';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(parseTasks));
}

async function show(req, res) {
  const [rows] = await pool.query(
    'SELECT s.*, h.name as hotel_name FROM staff s JOIN hotels h ON s.hotel_id = h.id WHERE s.id = ?',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Employé introuvable' });
  const [schedules] = await pool.query(
    'SELECT * FROM staff_schedules WHERE staff_id = ? ORDER BY date DESC LIMIT 30',
    [req.params.id]
  );
  res.json({ ...parseTasks(rows[0]), schedules });
}

async function store(req, res) {
  const { hotel_id, first_name, last_name, role, phone, email, hired_at, salary, tasks, password } = req.body;
  if (!hotel_id || !first_name || !last_name) {
    return res.status(422).json({ message: 'hotel_id, prénom et nom requis' });
  }
  if (!(await canManageHotel(req.user, hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }
  const tasksJson = tasks ? JSON.stringify(Array.isArray(tasks) ? tasks : []) : null;

  let userId = null;
  if (password && email) {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(422).json({ message: 'Cet email est déjà utilisé par un compte existant.' });
    }
    const hashed = await bcrypt.hash(password, 12);
    const fullName = `${first_name} ${last_name}`.trim();
    const [userResult] = await pool.query(
      'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
      [fullName, email, hashed, 'employe', 'actif']
    );
    userId = userResult.insertId;
  }

  const [result] = await pool.query(
    'INSERT INTO staff (hotel_id, first_name, last_name, role, phone, email, hired_at, salary, status, tasks, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [hotel_id, first_name, last_name, role || 'Employé', phone, email, hired_at, salary || 0, 'actif', tasksJson, userId]
  );

  // Lien bidirectionnel (le compte web s'appuie sur users.staff_id).
  if (userId) {
    await pool.query('UPDATE users SET staff_id = ? WHERE id = ?', [result.insertId, userId]);
  }
  const [newStaff] = await pool.query('SELECT * FROM staff WHERE id = ?', [result.insertId]);
  res.status(201).json(parseTasks(newStaff[0]));
}

async function update(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM staff WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Employé introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet employé.' });
  }
  const fields = ['first_name', 'last_name', 'role', 'phone', 'email', 'hired_at', 'salary', 'status'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (req.body.tasks !== undefined) {
    updates.push('tasks = ?');
    params.push(JSON.stringify(Array.isArray(req.body.tasks) ? req.body.tasks : []));
  }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE staff SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM staff WHERE id = ?', [req.params.id]);
  res.json(parseTasks(updated[0]));
}

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, user_id, hotel_id FROM staff WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Employé introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet employé.' });
  }
  if (rows[0].user_id) {
    await pool.query('DELETE FROM users WHERE id = ?', [rows[0].user_id]).catch(() => {});
  }
  await pool.query('DELETE FROM staff WHERE id = ?', [req.params.id]);
  res.json({ message: 'Employé supprimé' });
}

async function getSchedules(req, res) {
  const { hotel_id, staff_id, date } = req.query;
  let sql = `SELECT ss.*, s.first_name, s.last_name, s.role, h.name as hotel_name
             FROM staff_schedules ss
             JOIN staff s ON ss.staff_id = s.id
             JOIN hotels h ON ss.hotel_id = h.id
             WHERE 1=1`;
  const params = [];
  if (hotel_id) { sql += ' AND ss.hotel_id = ?'; params.push(hotel_id); }
  if (staff_id) { sql += ' AND ss.staff_id = ?'; params.push(staff_id); }
  if (date) { sql += ' AND ss.date = ?'; params.push(date); }
  sql += ' ORDER BY ss.date DESC, s.last_name';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function createSchedule(req, res) {
  const { staff_id, hotel_id, date, shift, start_time, end_time, poste, notes } = req.body;
  if (!staff_id || !hotel_id || !date || !shift) {
    return res.status(422).json({ message: 'staff_id, hotel_id, date et shift requis' });
  }
  const [result] = await pool.query(
    'INSERT INTO staff_schedules (staff_id, hotel_id, date, shift, start_time, end_time, poste, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [staff_id, hotel_id, date, shift, start_time, end_time, poste, notes]
  );
  const [newSched] = await pool.query('SELECT * FROM staff_schedules WHERE id = ?', [result.insertId]);
  res.status(201).json(newSched[0]);
}

module.exports = { me, index, show, store, update, destroy, getSchedules, createSchedule };
