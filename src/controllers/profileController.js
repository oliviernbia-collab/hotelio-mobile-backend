const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const jeko = require('../services/jeko');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Ajoute la colonne avatar si elle n'existe pas encore
pool.query("ALTER TABLE users ADD COLUMN avatar VARCHAR(255) NULL").catch(() => {});

function avatarUrl(filename) {
  if (!filename) return null;
  if (filename.startsWith('http')) return filename;
  return `${APP_URL}/uploads/avatars/${filename}`;
}

function mapUser(row) {
  return { ...row, avatar: avatarUrl(row.avatar) };
}

async function show(req, res) {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, status, hotels, permissions, two_fa_enabled, payout_method, payout_identifier, jeko_contact_id, avatar, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  const user = mapUser(rows[0]);

  // Pour les clients : enrichir avec les données de fidélité
  if (req.user.role === 'client') {
    const [clientRows] = await pool.query(
      `SELECT c.points_fidelite, c.code AS client_code,
         COALESCE(SUM(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN r.total ELSE 0 END), 0) AS total_spend,
         COUNT(CASE WHEN r.status IN ('confirmée','terminée','complétée') THEN 1 END) AS total_stays
       FROM clients c
       LEFT JOIN reservations r ON r.client_id = c.id
       WHERE c.user_id = ?
       GROUP BY c.id`,
      [req.user.id]
    );
    if (clientRows.length) {
      Object.assign(user, clientRows[0]);
    }
  }

  res.json(user);
}

async function update(req, res) {
  const { name, email } = req.body;
  if (!name && !email) return res.status(422).json({ message: 'Aucune donnée à mettre à jour' });
  if (email) {
    const [exist] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
    if (exist.length) return res.status(422).json({ message: 'Email déjà utilisé' });
  }
  const updates = [];
  const params  = [];
  if (name)  { updates.push('name = ?');  params.push(name); }
  if (email) { updates.push('email = ?'); params.push(email); }
  params.push(req.user.id);
  await pool.query(`UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query(
    'SELECT id, name, email, role, status, hotels, permissions, two_fa_enabled, payout_method, payout_identifier, jeko_contact_id, avatar FROM users WHERE id = ?',
    [req.user.id]
  );
  res.json({ message: 'Profil mis à jour', user: mapUser(updated[0]) });
}

async function changePassword(req, res) {
  const { current_password, password, password_confirmation } = req.body;
  if (!current_password || !password) return res.status(422).json({ message: 'Mot de passe actuel et nouveau requis' });
  if (password !== password_confirmation) return res.status(422).json({ message: 'Les mots de passe ne correspondent pas' });
  const [rows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
  const valid = await bcrypt.compare(current_password, rows[0].password);
  if (!valid) return res.status(422).json({ message: 'Mot de passe actuel incorrect' });
  const hashed = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?', [hashed, req.user.id]);
  res.json({ message: 'Mot de passe modifié avec succès' });
}

async function uploadAvatar(req, res) {
  if (!req.file) return res.status(422).json({ message: 'Fichier image requis' });
  await pool.query('UPDATE users SET avatar = ?, updated_at = NOW() WHERE id = ?', [req.file.path, req.user.id]);
  const [rows] = await pool.query(
    'SELECT id, name, email, role, status, hotels, permissions, two_fa_enabled, payout_method, payout_identifier, jeko_contact_id, avatar FROM users WHERE id = ?',
    [req.user.id]
  );
  res.json({ message: 'Avatar mis à jour', user: mapUser(rows[0]) });
}

// Enregistre les coordonnées de paiement du prestataire (mobile money ou RIB bancaire)
// pour les reversements automatiques, et crée le contact bénéficiaire correspondant chez Jèko.
async function updatePayout(req, res) {
  const { payout_method, phone_number, bank_name, bank_code, swift_code, agency_code, account_number, rib_key } = req.body;

  const validMethods = ['wave', 'orange_money', 'mtn', 'moov', 'djamo', 'bank'];
  if (!validMethods.includes(payout_method)) {
    return res.status(422).json({ message: 'Méthode de paiement invalide' });
  }

  const isBank = payout_method === 'bank';
  if (isBank && (!bank_name || !bank_code || !swift_code || !agency_code || !account_number || !rib_key)) {
    return res.status(422).json({ message: 'Tous les champs bancaires sont requis' });
  }
  if (!isBank && !phone_number) {
    return res.status(422).json({ message: 'Numéro de téléphone requis' });
  }

  const identifier = isBank
    ? { bankName: bank_name, bankCode: bank_code, swiftCode: swift_code, agencyCode: agency_code, accountNumber: account_number, key: rib_key }
    : { number: phone_number };

  const [userRows] = await pool.query('SELECT name, jeko_contact_id FROM users WHERE id = ?', [req.user.id]);
  const user = userRows[0];

  const result = await jeko.createContact({ name: user.name, paymentMethod: payout_method, identifier });

  if (!result || !result.id) {
    return res.status(422).json({ message: (result && result.message) || "Impossible d'enregistrer ces coordonnées de paiement pour le moment." });
  }

  await pool.query(
    'UPDATE users SET payout_method = ?, payout_identifier = ?, jeko_contact_id = ?, updated_at = NOW() WHERE id = ?',
    [payout_method, JSON.stringify(identifier), result.id, req.user.id]
  );

  if (user.jeko_contact_id) {
    jeko.deleteContact(user.jeko_contact_id).catch(() => {});
  }

  res.json({ message: 'Coordonnées de paiement enregistrées' });
}

/**
 * Désactivation de compte en self-service (status -> inactif), miroir de
 * webPHP/app/Http/Controllers/ProfileController::destroy(). Ne supprime aucune donnée
 * liée (réservations, factures...) — bloque simplement la connexion.
 */
async function deactivate(req, res) {
  const { password } = req.body;
  if (!password) return res.status(422).json({ message: 'Mot de passe requis' });

  const [rows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
  const valid = await bcrypt.compare(password, rows[0].password);
  if (!valid) return res.status(422).json({ message: 'Mot de passe incorrect' });

  await pool.query("UPDATE users SET status = 'inactif', updated_at = NOW() WHERE id = ?", [req.user.id]);

  res.json({ message: 'Compte désactivé.' });
}

module.exports = { show, update, changePassword, uploadAvatar, updatePayout, deactivate };
