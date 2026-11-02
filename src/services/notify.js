const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const mailer = require('./mailer');

/* Notification in-app (table `notifications` partagée avec le web), doublée d'un e-mail quand
   `withEmail` est vrai — comme les notifications Laravel envoyées sur les canaux
   ['database', 'mail']. Une erreur d'envoi ne doit jamais faire échouer l'action en cours. */
async function notifyUser(userId, type, title, message, extra = {}, { withEmail = false } = {}) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
       VALUES (?, ?, 'App\\\\Models\\\\User', ?, ?, NOW(), NOW())`,
      [uuidv4(), type, userId, JSON.stringify({ type, title, message, ...extra })]
    );
  } catch (e) {
    console.error('Notification error:', e.message);
  }

  if (withEmail) {
    try {
      const [[user]] = await pool.query('SELECT email FROM users WHERE id = ?', [userId]);
      if (user && user.email) await mailer.sendNotice(user.email, title, message);
    } catch (e) {
      console.error('⚠️  E-mail de notification non envoyé:', e.message);
    }
  }
}

module.exports = { notifyUser };
