const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const jwt  = require('jsonwebtoken');
const fs   = require('fs');
const path = require('path');
const { canManageHotel } = require('../utils/authorize');

// Auto-migration
(async () => {
  try {
    await pool.query('ALTER TABLE facturations ADD COLUMN hotel_id INT NULL DEFAULT NULL');
    console.log('[facturations] Colonne hotel_id ajoutée.');
  } catch {}
  try {
    await pool.query('ALTER TABLE facturations ADD COLUMN client_user_id INT NULL DEFAULT NULL');
    console.log('[facturations] Colonne client_user_id ajoutée.');
  } catch {}
})();

// Logo embarqué en base64 pour la page de téléchargement
let LOGO_B64 = '';
try {
  LOGO_B64 = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'mobile', 'assets', 'logo.png')
  ).toString('base64');
} catch {}
const LOGO_SRC = LOGO_B64 ? `data:image/png;base64,${LOGO_B64}` : '';

// Échappe les valeurs stockées en base (nom d'hôtel, client, notes...) avant de les
// injecter dans le HTML de la facture — évite un XSS stocké si l'une d'elles contient
// des caractères HTML.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function notifyClient(clientUserId, title, body, factureId, numero) {
  if (!clientUserId) return;
  try {
    await pool.query(
      `INSERT INTO notifications (id, notifiable_type, notifiable_id, type, data, created_at)
       VALUES (?, 'App\\\\Models\\\\User', ?, ?, ?, NOW())`,
      [
        uuidv4(),
        clientUserId,
        'facture_emise',
        JSON.stringify({ title, body, facture_id: String(factureId), numero }),
      ]
    );
  } catch (e) {
    console.error('[facturations] Notification error:', e.message);
  }
}

async function syncOverdue() {
  try {
    await pool.query(
      `UPDATE facturations SET statut = 'overdue', updated_at = NOW()
       WHERE statut = 'pending' AND date_echeance IS NOT NULL AND date_echeance < CURDATE()`
    );
  } catch {}
}

// ─── index ────────────────────────────────────────────────────────────────────

async function index(req, res) {
  await syncOverdue();

  const { statut, client, from, to } = req.query;

  let sql    = `SELECT f.*, h.name AS hotel_name FROM facturations f LEFT JOIN hotels h ON f.hotel_id = h.id WHERE 1=1`;
  const params = [];

  if (req.user.role === 'prestataire') {
    sql = `SELECT f.*, h.name AS hotel_name
           FROM facturations f
           LEFT JOIN hotels h ON f.hotel_id = h.id
           WHERE h.user_id = ?`;
    params.push(req.user.id);
  } else if (req.user.role === 'employe') {
    if (!req.user.hotel_id) {
      return res.json({ data: [], stats: { total: 0, total_paye: 0, payees: 0, en_retard: 0, en_attente: 0 } });
    }
    sql = `SELECT f.*, h.name AS hotel_name FROM facturations f LEFT JOIN hotels h ON f.hotel_id = h.id WHERE f.hotel_id = ?`;
    params.push(req.user.hotel_id);
  }

  if (statut) { sql += ' AND f.statut = ?';          params.push(statut); }
  if (client) { sql += ' AND f.client LIKE ?';       params.push(`%${client}%`); }
  if (from)   { sql += ' AND f.date_facture >= ?';   params.push(from); }
  if (to)     { sql += ' AND f.date_facture <= ?';   params.push(to); }
  sql += ' ORDER BY f.date_facture DESC';

  const [rows] = await pool.query(sql, params);

  const total      = rows.reduce((s, r) => s + Number(r.montant      || 0), 0);
  const total_paye = rows.reduce((s, r) => s + Number(r.montant_paye || 0), 0);
  const payees     = rows.filter(r => r.statut === 'paid').length;
  const en_retard  = rows.filter(r => r.statut === 'overdue').length;
  const en_attente = rows.filter(r => r.statut === 'pending').length;

  res.json({ data: rows, stats: { total, total_paye, payees, en_retard, en_attente } });
}

// ─── show ─────────────────────────────────────────────────────────────────────

async function show(req, res) {
  const [rows] = await pool.query(
    `SELECT f.*, h.name AS hotel_name, h.phone AS hotel_phone, h.email AS hotel_email
     FROM facturations f LEFT JOIN hotels h ON f.hotel_id = h.id
     WHERE f.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Facturation introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette facturation.' });
  }
  res.json(rows[0]);
}

// ─── store ────────────────────────────────────────────────────────────────────

async function store(req, res) {
  const {
    client, prestation, date_facture, date_echeance,
    montant, mode_paiement, notes, lignes,
    client_user_id, hotel_id,
  } = req.body;
  if (!client || !montant) return res.status(422).json({ message: 'Client et montant requis' });
  if (req.user.role === 'client') {
    return res.status(403).json({ message: "Vous n'avez pas le droit de créer une facturation." });
  }

  const resolvedHotelId = hotel_id
    ? Number(hotel_id)
    : (req.user.role === 'employe' ? (req.user.hotel_id ?? null) : null);

  // hotel_id obligatoire : sans lui, impossible d'isoler cette facturation par hôtel/prestataire
  // (voir index()/show()/update()/pay()/destroy() qui s'appuient tous dessus).
  if (!resolvedHotelId) {
    return res.status(422).json({ message: 'hotel_id requis' });
  }
  if (!(await canManageHotel(req.user, resolvedHotelId))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }

  const year = new Date().getFullYear();
  const rowValues = [
    null, client, prestation,
    date_facture || new Date().toISOString().split('T')[0],
    date_echeance || null, montant, 0, 'pending',
    mode_paiement || 'Espèces',
    notes || null, JSON.stringify(lignes || []),
    resolvedHotelId, client_user_id || null,
  ];

  let result, numero;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [maxRow] = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(numero, '-', -1) AS UNSIGNED)), 0) + 1 AS next_seq
       FROM facturations WHERE numero LIKE ?`,
      [`FAC-${year}-%`]
    );
    numero = `FAC-${year}-${String(maxRow[0].next_seq).padStart(4, '0')}`;
    rowValues[0] = numero;
    try {
      [result] = await pool.query(
        `INSERT INTO facturations
           (numero, client, prestation, date_facture, date_echeance,
            montant, montant_paye, statut, mode_paiement, notes, lignes, hotel_id, client_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rowValues
      );
      break;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw e;
    }
  }
  const [newFact] = await pool.query('SELECT * FROM facturations WHERE id = ?', [result.insertId]);

  await notifyClient(
    client_user_id,
    'Nouvelle facture reçue',
    `Votre facture ${numero} d'un montant de ${Number(montant).toLocaleString('fr-FR')} FCFA est disponible.`,
    newFact[0].id,
    numero
  );

  res.status(201).json(newFact[0]);
}

// ─── update ───────────────────────────────────────────────────────────────────

async function update(req, res) {
  const [existing] = await pool.query('SELECT * FROM facturations WHERE id = ?', [req.params.id]);
  if (!existing.length) return res.status(404).json({ message: 'Facturation introuvable' });
  const prev = existing[0];
  if (!(await canManageHotel(req.user, prev.hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette facturation.' });
  }
  if (req.body.hotel_id !== undefined && !(await canManageHotel(req.user, req.body.hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cet hôtel.' });
  }

  const allowed = [
    'client', 'prestation', 'date_facture', 'date_echeance',
    'montant', 'montant_paye', 'statut', 'mode_paiement', 'notes', 'hotel_id',
  ];
  const updates = [];
  const params  = [];
  allowed.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (req.body.lignes !== undefined) { updates.push('lignes = ?'); params.push(JSON.stringify(req.body.lignes)); }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée à modifier' });

  params.push(req.params.id);
  await pool.query(`UPDATE facturations SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM facturations WHERE id = ?', [req.params.id]);

  // Notification si passage à "payée"
  if (req.body.statut === 'paid' && prev.statut !== 'paid' && prev.client_user_id) {
    await notifyClient(
      prev.client_user_id,
      'Facture réglée',
      `Votre facture ${prev.numero} d'un montant de ${Number(prev.montant).toLocaleString('fr-FR')} FCFA a été réglée. Merci !`,
      prev.id,
      prev.numero
    );
  }

  res.json(updated[0]);
}

// ─── pay ──────────────────────────────────────────────────────────────────────

async function pay(req, res) {
  const [rows] = await pool.query('SELECT * FROM facturations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Facturation introuvable' });
  const facture = rows[0];
  if (!(await canManageHotel(req.user, facture.hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette facturation.' });
  }

  const { montant_paye, mode_paiement } = req.body;
  if (montant_paye === undefined || isNaN(Number(montant_paye))) {
    return res.status(422).json({ message: 'Montant payé requis' });
  }

  const paye  = Number(montant_paye);
  const total = Number(facture.montant);

  let nouveauStatut = facture.statut;
  if (paye >= total)  nouveauStatut = 'paid';
  else if (paye > 0)  nouveauStatut = 'partial';
  else                nouveauStatut = 'pending';

  const updates = ['montant_paye = ?', 'statut = ?', 'updated_at = NOW()'];
  const params  = [paye, nouveauStatut];
  if (mode_paiement) { updates.push('mode_paiement = ?'); params.push(mode_paiement); }
  params.push(req.params.id);

  await pool.query(`UPDATE facturations SET ${updates.join(', ')} WHERE id = ?`, params);

  if (nouveauStatut === 'paid' && facture.statut !== 'paid' && facture.client_user_id) {
    await notifyClient(
      facture.client_user_id,
      'Facture réglée',
      `Votre facture ${facture.numero} d'un montant de ${total.toLocaleString('fr-FR')} FCFA a été réglée. Merci !`,
      facture.id,
      facture.numero
    );
  }

  const [updated] = await pool.query('SELECT * FROM facturations WHERE id = ?', [req.params.id]);
  res.json(updated[0]);
}

// ─── destroy ──────────────────────────────────────────────────────────────────

async function destroy(req, res) {
  const [rows] = await pool.query('SELECT id, hotel_id FROM facturations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Facturation introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette facturation.' });
  }
  await pool.query('DELETE FROM facturations WHERE id = ?', [req.params.id]);
  res.json({ message: 'Facturation supprimée' });
}

// ─── download ─────────────────────────────────────────────────────────────────

async function download(req, res) {
  const token = req.query.token;
  if (!token) return res.status(401).send('<h1>Non autorisé</h1>');
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).send('<h1>Token invalide</h1>');
  }

  const [userRows] = await pool.query('SELECT id, role, status FROM users WHERE id = ?', [decoded.id]);
  if (!userRows.length || userRows[0].status !== 'actif') {
    return res.status(401).send('<h1>Non autorisé</h1>');
  }
  const user = userRows[0];
  if (user.role === 'employe') {
    const [staffRows] = await pool.query('SELECT hotel_id FROM staff WHERE user_id = ? LIMIT 1', [user.id]);
    user.hotel_id = staffRows.length ? staffRows[0].hotel_id : null;
  }

  const [rows] = await pool.query(
    `SELECT f.*, h.name AS hotel_name, h.short_name AS hotel_short,
            h.phone AS hotel_phone, h.email AS hotel_email
     FROM facturations f
     LEFT JOIN hotels h ON f.hotel_id = h.id
     WHERE f.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).send('<h1>Facture introuvable</h1>');

  const f = rows[0];
  const isOwnInvoice = f.client_user_id && Number(f.client_user_id) === Number(user.id);
  if (!isOwnInvoice && !(await canManageHotel(user, f.hotel_id))) {
    return res.status(403).send('<h1>Accès refusé à cette facture</h1>');
  }
  const STATUS_MAP   = { paid: 'Payée', pending: 'En attente', overdue: 'En retard', partial: 'Partielle', draft: 'Brouillon' };
  const STATUS_STYLE = {
    paid:    'background:#D1FAE5;color:#065F46',
    pending: 'background:#FEF3C7;color:#92400E',
    overdue: 'background:#FEE2E2;color:#991B1B',
    partial: 'background:#DBEAFE;color:#1E40AF',
    draft:   'background:#F3F4F6;color:#6B7280',
  };

  const logoHtml = LOGO_SRC
    ? `<img src="${LOGO_SRC}" style="width:64px;height:64px;object-fit:contain;border-radius:14px;" alt="Logo" />`
    : '<span style="font-size:36px;">🏨</span>';

  const hotelInfo = f.hotel_name
    ? `<div style="font-size:13px;opacity:.75;margin-top:2px;">${escapeHtml(f.hotel_name)}</div>
       ${f.hotel_phone ? `<div style="font-size:12px;opacity:.6;margin-top:1px;">📞 ${escapeHtml(f.hotel_phone)}</div>` : ''}
       ${f.hotel_email ? `<div style="font-size:12px;opacity:.6;margin-top:1px;">✉ ${escapeHtml(f.hotel_email)}</div>` : ''}`
    : '';

  const resteAPayer = Number(f.montant) - Number(f.montant_paye || 0);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Facture ${escapeHtml(f.numero)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;background:#F8F9FA;padding:24px;color:#2C3E50}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
    .header{background:#1E3A5F;color:#fff;padding:28px;display:flex;align-items:center;gap:16px}
    .header-info{flex:1}
    .app-name{font-size:22px;font-weight:700;letter-spacing:.5px}
    .app-sub{font-size:12px;opacity:.65;margin-top:2px}
    .numero{font-size:18px;font-weight:700;color:#F4A261;margin-top:10px}
    .body{padding:24px 28px}
    .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #F0F0F0;font-size:14px}
    .row:last-child{border-bottom:none}
    .label{color:#7F8C8D}
    .value{font-weight:600;text-align:right}
    .badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700}
    .total-box{margin:20px 28px;background:#1E3A5F;color:#fff;border-radius:12px;padding:18px 22px}
    .total-label{font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
    .total-amount{font-size:clamp(18px,5vw,28px);font-weight:800;word-break:break-word;line-height:1.2}
    .progress-wrap{margin:0 28px 20px;background:#F0F0F0;border-radius:8px;height:8px;overflow:hidden}
    .progress-fill{height:100%;background:#2ECC71;border-radius:8px;transition:width .3s}
    .footer{text-align:center;font-size:12px;color:#7F8C8D;padding:0 28px 24px}
    @media print{body{background:#fff;padding:0}.card{box-shadow:none}}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      ${logoHtml}
      <div class="header-info">
        <div class="app-name">Hôtelio</div>
        <div class="app-sub">Système de gestion hôtelière</div>
        ${hotelInfo}
        <div class="numero">${escapeHtml(f.numero)}</div>
      </div>
    </div>

    <div class="body">
      <div class="row"><span class="label">Client</span><span class="value">${escapeHtml(f.client)}</span></div>
      ${f.prestation ? `<div class="row"><span class="label">Prestation</span><span class="value">${escapeHtml(f.prestation)}</span></div>` : ''}
      <div class="row"><span class="label">Date de facturation</span><span class="value">${escapeHtml(f.date_facture) || '-'}</span></div>
      <div class="row"><span class="label">Échéance</span><span class="value">${escapeHtml(f.date_echeance) || '-'}</span></div>
      <div class="row"><span class="label">Mode de paiement</span><span class="value">${escapeHtml(f.mode_paiement) || '-'}</span></div>
      ${f.notes ? `<div class="row"><span class="label">Notes</span><span class="value">${escapeHtml(f.notes)}</span></div>` : ''}
      <div class="row">
        <span class="label">Statut</span>
        <span class="value">
          <span class="badge" style="${STATUS_STYLE[f.statut] || STATUS_STYLE.pending}">
            ${STATUS_MAP[f.statut] || f.statut}
          </span>
        </span>
      </div>
      ${Number(f.montant_paye) > 0 ? `<div class="row"><span class="label">Déjà payé</span><span class="value" style="color:#2ECC71">${Number(f.montant_paye).toLocaleString('fr-FR')} FCFA</span></div>` : ''}
    </div>

    <div class="total-box">
      <div class="total-label">${f.statut === 'partial' ? 'Reste à payer' : 'Montant total'}</div>
      <div class="total-amount">${(f.statut === 'partial' ? resteAPayer : Number(f.montant)).toLocaleString('fr-FR')} FCFA</div>
    </div>

    ${Number(f.montant_paye) > 0 && f.statut !== 'paid' ? `
    <div class="progress-wrap">
      <div class="progress-fill" style="width:${Math.min(100, Math.round(Number(f.montant_paye) / Number(f.montant) * 100))}%"></div>
    </div>` : ''}

    <div class="footer">
      ${f.hotel_name ? `${escapeHtml(f.hotel_name)} &mdash; ` : ''}Hôtelio &mdash; Facture générée le ${new Date().toLocaleDateString('fr-FR')}<br>Merci pour votre confiance.
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { index, show, store, update, pay, destroy, download };
