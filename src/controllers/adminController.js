const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');

async function getUsers(req, res) {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, status, hotels, created_at FROM users ORDER BY created_at DESC'
  );
  res.json(rows);
}

async function createUser(req, res) {
  const { name, email, password, role, hotels, permissions } = req.body;
  if (!name || !email || !password) return res.status(422).json({ message: 'Nom, email et mot de passe requis' });
  const [exist] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (exist.length) return res.status(422).json({ message: 'Email déjà utilisé' });
  const hashed = await bcrypt.hash(password, 12);
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password, role, status, hotels, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, email, hashed, role || 'employe', 'actif', hotels || 'Toutes les propriétés', JSON.stringify(permissions || [])]
  );
  const [newUser] = await pool.query('SELECT id, name, email, role, status FROM users WHERE id = ?', [result.insertId]);
  res.status(201).json(newUser[0]);
}

async function updateUser(req, res) {
  const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Utilisateur introuvable' });
  const fields = ['name', 'email', 'role', 'status', 'hotels'];
  const updates = [];
  const params = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (req.body.permissions !== undefined) { updates.push('permissions = ?'); params.push(JSON.stringify(req.body.permissions)); }
  if (req.body.password) {
    const hashed = await bcrypt.hash(req.body.password, 12);
    updates.push('password = ?'); params.push(hashed);
  }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT id, name, email, role, status FROM users WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

async function deleteUser(req, res) {
  if (parseInt(req.params.id) === req.user.id) return res.status(422).json({ message: 'Vous ne pouvez pas supprimer votre propre compte' });
  const [rows] = await pool.query('SELECT id FROM users WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Utilisateur introuvable' });
  await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'Utilisateur supprimé' });
}

async function getLogs(req, res) {
  const { action, user_id, from, to } = req.query;
  let sql = 'SELECT * FROM activity_logs WHERE 1=1';
  const params = [];
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (user_id) { sql += ' AND user_id = ?'; params.push(user_id); }
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function clearLogs(req, res) {
  await pool.query('DELETE FROM activity_logs');
  res.json({ message: 'Logs effacés' });
}

async function approveReview(req, res) {
  await pool.query("UPDATE reviews SET status = 'approved', updated_at = NOW() WHERE id = ?", [req.params.id]);
  res.json({ message: 'Avis approuvé' });
}

async function rejectReview(req, res) {
  await pool.query("UPDATE reviews SET status = 'rejected', updated_at = NOW() WHERE id = ?", [req.params.id]);
  res.json({ message: 'Avis rejeté' });
}

module.exports = { getUsers, createUser, updateUser, deleteUser, getLogs, clearLogs, approveReview, rejectReview };
