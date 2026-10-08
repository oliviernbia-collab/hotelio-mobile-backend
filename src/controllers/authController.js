const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(422).json({ message: 'Email et mot de passe requis' });
  }
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  if (!rows.length) {
    return res.status(401).json({ message: 'Identifiants incorrects' });
  }
  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ message: 'Identifiants incorrects' });
  }
  if (user.status !== 'actif') {
    return res.status(403).json({ message: 'Compte inactif' });
  }
  await pool.query(
    "INSERT INTO activity_logs (user_id, user_name, user_role, action, description, ip_address) VALUES (?, ?, ?, 'login', ?, ?)",
    [user.id, user.name, user.role, `Connexion de ${user.name}`, req.ip]
  );
  const token = generateToken(user);
  const { password: _, ...userSafe } = user;
  res.json({ token, user: withAvatarUrl(userSafe) });
}

async function register(req, res) {
  const { name, email, password, role = 'client' } = req.body;

  if (!name || !email || !password) {
    return res.status(422).json({ message: 'Nom, email et mot de passe requis' });
  }

  const validRoles = ['client', 'prestataire'];
  const finalRole  = validRoles.includes(role) ? role : 'client';

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) {
    return res.status(422).json({ message: 'Email déjà utilisé' });
  }

  // Pour un propriétaire (prestataire), un document de preuve est obligatoire
  if (finalRole === 'prestataire' && !req.file) {
    return res.status(422).json({ message: 'Un justificatif de propriété est requis.' });
  }

  const hashed = await bcrypt.hash(password, 12);

  // Statut : prestataire → en_attente (doit être validé par admin), client → actif
  const status = finalRole === 'prestataire' ? 'en_attente' : 'actif';

  // Stocker le chemin du document dans permissions JSON
  const permissions = req.file
    ? JSON.stringify({ proof_document: req.file.path, proof_status: 'pending' })
    : null;

  const [result] = await pool.query(
    'INSERT INTO users (name, email, password, role, status, permissions) VALUES (?, ?, ?, ?, ?, ?)',
    [name, email, hashed, finalRole, status, permissions]
  );

  const [newUser] = await pool.query(
    'SELECT id, name, email, role, status FROM users WHERE id = ?',
    [result.insertId]
  );

  if (finalRole === 'prestataire') {
    // Notifier les admins (log d'activité)
    await pool.query(
      "INSERT INTO activity_logs (user_name, user_role, action, description) VALUES (?, ?, 'created', ?)",
      [name, 'prestataire', `Nouvelle demande propriétaire de ${name} (${email}) — validation requise`]
    ).catch(() => {});

    return res.status(201).json({
      status:  'en_attente',
      message: 'Votre demande a été soumise. Un administrateur validera votre compte sous 24–48 h.',
    });
  }

  const token = generateToken(newUser[0]);
  res.status(201).json({ token, user: newUser[0] });
}

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function withAvatarUrl(user) {
  if (!user?.avatar) return user;
  if (user.avatar.startsWith('http')) return user;
  return { ...user, avatar: `${APP_URL}/uploads/avatars/${user.avatar}` };
}

async function me(req, res) {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, status, hotels, permissions, two_fa_enabled, avatar, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  res.json(withAvatarUrl(rows[0]));
}

async function logout(req, res) {
  await pool.query(
    "INSERT INTO activity_logs (user_id, user_name, user_role, action, description, ip_address) VALUES (?, ?, ?, 'logout', ?, ?)",
    [req.user.id, req.user.name, req.user.role, `Déconnexion de ${req.user.name}`, req.ip]
  );
  res.json({ message: 'Déconnecté avec succès' });
}

async function forgotPassword(req, res) {
  const { email } = req.body;
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
}

module.exports = { login, register, me, logout, forgotPassword };
