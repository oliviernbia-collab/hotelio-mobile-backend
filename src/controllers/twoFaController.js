const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { pool } = require('../config/database');
const { generateToken, withAvatarUrl, sanitizeUser } = require('./authController');

async function setup(req, res) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const user = rows[0];
  let secret = user.two_fa_secret;

  if (!secret) {
    const generated = speakeasy.generateSecret({ name: `Hôtelio (${user.email})` });
    secret = generated.base32;
    await pool.query('UPDATE users SET two_fa_secret = ? WHERE id = ?', [secret, user.id]);
  }

  const otpauthUrl = speakeasy.otpauthURL({
    secret,
    label: `Hôtelio (${user.email})`,
    encoding: 'base32',
  });
  const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

  res.json({ secret, qrCodeDataUrl });
}

async function enable(req, res) {
  const { otp } = req.body;
  if (!otp) return res.status(422).json({ message: 'Code requis' });

  const [rows] = await pool.query('SELECT two_fa_secret FROM users WHERE id = ?', [req.user.id]);
  const secret = rows[0]?.two_fa_secret;
  if (!secret) return res.status(422).json({ message: "Lancez d'abord la configuration de la 2FA" });

  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: otp, window: 1 });
  if (!valid) return res.status(422).json({ message: 'Code invalide' });

  await pool.query('UPDATE users SET two_fa_enabled = 1 WHERE id = ?', [req.user.id]);
  res.json({ message: 'Authentification à deux facteurs activée' });
}

async function disable(req, res) {
  const { password } = req.body;
  if (!password) return res.status(422).json({ message: 'Mot de passe requis' });

  const [rows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
  const valid = await bcrypt.compare(password, rows[0].password);
  if (!valid) return res.status(422).json({ message: 'Mot de passe incorrect' });

  await pool.query('UPDATE users SET two_fa_enabled = 0, two_fa_secret = NULL WHERE id = ?', [req.user.id]);
  res.json({ message: 'Authentification à deux facteurs désactivée' });
}

async function verifyLogin(req, res) {
  const { user_id, otp } = req.body;
  if (!user_id || !otp) return res.status(422).json({ message: 'Code requis' });

  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [user_id]);
  if (!rows.length) return res.status(401).json({ message: 'Utilisateur introuvable' });
  const user = rows[0];

  if (!user.two_fa_enabled || !user.two_fa_secret) {
    return res.status(422).json({ message: "La 2FA n'est pas activée pour ce compte" });
  }

  const valid = speakeasy.totp.verify({ secret: user.two_fa_secret, encoding: 'base32', token: otp, window: 1 });
  if (!valid) return res.status(422).json({ message: 'Code invalide' });

  await pool.query(
    "INSERT INTO activity_logs (user_id, user_name, user_role, action, description) VALUES (?, ?, ?, 'login', ?)",
    [user.id, user.name, user.role, `Connexion de ${user.name} (2FA)`]
  ).catch(() => {});

  const token = generateToken(user);
  res.json({ token, user: withAvatarUrl(sanitizeUser(user)) });
}

module.exports = { setup, enable, disable, verifyLogin };
