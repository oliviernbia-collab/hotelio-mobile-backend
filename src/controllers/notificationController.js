const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

async function index(req, res) {
  const [rows] = await pool.query(
    "SELECT * FROM notifications WHERE notifiable_type = 'App\\\\Models\\\\User' AND notifiable_id = ? ORDER BY created_at DESC LIMIT 50",
    [req.user.id]
  );
  const notifications = rows.map(n => ({ ...n, data: JSON.parse(n.data || '{}') }));
  const unread_count  = notifications.filter(n => !n.read_at).length;
  res.json({ data: notifications, unread_count });
}

async function markRead(req, res) {
  await pool.query(
    "UPDATE notifications SET read_at = NOW() WHERE id = ? AND notifiable_id = ?",
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Notification marquée comme lue' });
}

async function markAllRead(req, res) {
  await pool.query(
    "UPDATE notifications SET read_at = NOW() WHERE notifiable_id = ? AND read_at IS NULL",
    [req.user.id]
  );
  res.json({ message: 'Toutes les notifications marquées comme lues' });
}

async function destroy(req, res) {
  await pool.query(
    "DELETE FROM notifications WHERE id = ? AND notifiable_id = ?",
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Notification supprimée' });
}

module.exports = { index, markRead, markAllRead, destroy };
