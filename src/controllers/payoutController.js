const { pool } = require('../config/database');
const refundService = require('../services/refundService');
const { triggerOwnerPayout } = require('./reservationController');

const COMMISSIONABLE_CHANNELS = ['Site web', 'App mobile'];

// Exclut les réservations déjà reversées automatiquement avec succès (virement Jèko,
// déclenché côté web au moment du paiement — voir DashboardController::triggerOwnerPayout()).
// Ce montant est donc le solde restant à régler manuellement (fallback), pas le total historique.
async function computeOwedReservations(userId) {
  const placeholders = COMMISSIONABLE_CHANNELS.map(() => '?').join(',');
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(res.total - COALESCE(res.commission_amount, 0)), 0) as owed
     FROM reservations res
     JOIN hotels h ON res.hotel_id = h.id
     WHERE h.user_id = ? AND res.paid = 1 AND res.status != 'annulée' AND res.channel IN (${placeholders})
       AND (res.payout_status IS NULL OR res.payout_status != 'success')`,
    [userId, ...COMMISSIONABLE_CHANNELS]
  );
  return Number(row.owed);
}

// Même logique pour les achats boutique (lignes de commande des produits dont ce
// prestataire est propriétaire) — reversement déclenché côté web, voir
// CommandeController::triggerOwnerPayouts().
async function computeOwedCommandes(userId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM((lc.quantite * lc.prix) - COALESCE(lc.commission_amount, 0)), 0) as owed
     FROM ligne_commandes lc
     JOIN products p ON lc.product_id = p.id
     JOIN commandes c ON lc.commande_id = c.id
     WHERE p.user_id = ? AND c.statut = 'payé'
       AND (lc.payout_status IS NULL OR lc.payout_status != 'success')`,
    [userId]
  );
  return Number(row.owed);
}

/** Un virement automatique Jèko a-t-il échoué (réservation ou achat) ? */
async function hasFailedAutomaticPayout(userId) {
  const [[resRow]] = await pool.query(
    `SELECT COUNT(*) as cnt FROM reservations res JOIN hotels h ON res.hotel_id = h.id
     WHERE h.user_id = ? AND res.payout_status = 'error'`,
    [userId]
  );
  if (Number(resRow.cnt) > 0) return true;

  const [[cmdRow]] = await pool.query(
    `SELECT COUNT(*) as cnt FROM ligne_commandes lc JOIN products p ON lc.product_id = p.id
     WHERE p.user_id = ? AND lc.payout_status = 'error'`,
    [userId]
  );
  return Number(cmdRow.cnt) > 0;
}

async function adminList(req, res) {
  const type = ['reservations', 'achats'].includes(req.query.type) ? req.query.type : 'tous';
  const [owners] = await pool.query("SELECT id, name, email FROM users WHERE role = 'prestataire' ORDER BY name");

  const result = [];
  for (const owner of owners) {
    const owedReservations = await computeOwedReservations(owner.id);
    const owedCommandes = await computeOwedCommandes(owner.id);
    const owed = type === 'reservations' ? owedReservations : type === 'achats' ? owedCommandes : owedReservations + owedCommandes;

    const [[paidRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) as paid FROM payouts WHERE user_id = ?', [owner.id]);
    const [lastRows] = await pool.query('SELECT paid_at FROM payouts WHERE user_id = ? ORDER BY paid_at DESC LIMIT 1', [owner.id]);
    const alreadyPaid = Number(paidRow.paid);
    result.push({
      id: owner.id,
      name: owner.name,
      email: owner.email,
      owed,
      owed_reservations: owedReservations,
      owed_commandes: owedCommandes,
      already_paid: alreadyPaid,
      balance: owed - alreadyPaid,
      last_payout_at: lastRows[0]?.paid_at ?? null,
      has_failed_payout: await hasFailedAutomaticPayout(owner.id),
    });
  }

  result.sort((a, b) => b.balance - a.balance);
  res.json(result);
}

/**
 * Versement manuel — réservé aux cas où le virement automatique Jèko a échoué
 * (has_failed_payout). Les reversements se font sinon automatiquement au moment du
 * paiement (voir boutiqueController.js / le webhook Jèko côté web), ce point d'entrée
 * n'est qu'un filet de secours.
 */
async function recordPayout(req, res) {
  const { amount, notes } = req.body;
  const userId = req.params.userId;
  if (!amount || Number(amount) <= 0) return res.status(422).json({ message: 'Montant invalide' });

  if (!(await hasFailedAutomaticPayout(userId))) {
    return res.status(422).json({ message: 'Le versement manuel est réservé aux virements automatiques en échec.' });
  }

  const owed = (await computeOwedReservations(userId)) + (await computeOwedCommandes(userId));
  const [[paidRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) as paid FROM payouts WHERE user_id = ?', [userId]);
  const balance = owed - Number(paidRow.paid);
  if (Number(amount) > balance) {
    return res.status(422).json({ message: `Le montant dépasse le solde dû (${balance} FCFA).` });
  }

  await pool.query(
    'INSERT INTO payouts (user_id, amount, notes, paid_at, recorded_by, created_at, updated_at) VALUES (?, ?, ?, NOW(), ?, NOW(), NOW())',
    [userId, amount, notes || null, req.user.id]
  );

  res.json({ message: 'Versement enregistré' });
}

/* Virements automatiques Jèko en échec (section « Virements échoués » de la page admin web). */
async function failed(req, res) {
  const [reservations] = await pool.query(
    `SELECT res.id, res.code, res.total, res.commission_amount, res.payout_failure_reason,
            h.name AS hotel_name, h.short_name AS hotel_short_name, u.name AS owner_name
     FROM reservations res
     JOIN hotels h ON res.hotel_id = h.id
     LEFT JOIN users u ON h.user_id = u.id
     WHERE res.payout_status = 'error'
     ORDER BY res.updated_at DESC`
  );
  const [lignes] = await pool.query(
    `SELECT lc.id, lc.commande_id, lc.quantite, lc.prix, lc.commission_amount, lc.payout_failure_reason,
            p.name AS product_name, u.name AS owner_name
     FROM ligne_commandes lc
     JOIN products p ON lc.product_id = p.id
     LEFT JOIN users u ON p.user_id = u.id
     WHERE lc.payout_status = 'error'
     ORDER BY lc.updated_at DESC`
  );

  res.json({
    reservations: reservations.map((r) => ({
      id: r.id,
      code: r.code,
      owner_name: r.owner_name,
      hotel_name: r.hotel_short_name || r.hotel_name,
      net_amount: Number(r.total) - Number(r.commission_amount || 0),
      reason: r.payout_failure_reason,
    })),
    lignes: lignes.map((l) => ({
      id: l.id,
      commande_id: l.commande_id,
      owner_name: l.owner_name,
      product_name: l.product_name,
      net_amount: l.quantite * l.prix - Number(l.commission_amount || 0),
      reason: l.payout_failure_reason,
    })),
  });
}

// Comme DashboardController::retryPayout côté web : remise à zéro puis nouveau virement.
async function retryReservation(req, res) {
  const [[reservation]] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!reservation) return res.status(404).json({ message: 'Réservation introuvable' });

  await pool.query(
    'UPDATE reservations SET payout_transfer_id = NULL, payout_status = NULL, payout_failure_reason = NULL WHERE id = ?',
    [reservation.id]
  );
  await triggerOwnerPayout({ ...reservation, payout_transfer_id: null });

  const [[after]] = await pool.query('SELECT payout_status, payout_failure_reason FROM reservations WHERE id = ?', [reservation.id]);
  if (after.payout_status === 'error') {
    return res.status(422).json({ message: `Le virement a de nouveau échoué : ${after.payout_failure_reason || 'raison inconnue'}` });
  }
  res.json({ message: 'Virement relancé.', payout_status: after.payout_status });
}

/* Reversement des achats boutique, un virement par vendeur — miroir de
   CommandeController::triggerOwnerPayouts côté web. */
async function triggerCommandeOwnerPayouts(commandeId) {
  const [lignes] = await pool.query(
    `SELECT lc.id, lc.quantite, lc.prix, lc.commission_amount, p.user_id AS owner_id
     FROM ligne_commandes lc JOIN products p ON lc.product_id = p.id
     WHERE lc.commande_id = ? AND lc.payout_transfer_id IS NULL AND p.user_id IS NOT NULL`,
    [commandeId]
  );

  const byOwner = {};
  for (const l of lignes) (byOwner[l.owner_id] ||= []).push(l);

  for (const [ownerId, ownerLignes] of Object.entries(byOwner)) {
    const netAmount = ownerLignes.reduce((sum, l) => sum + l.quantite * l.prix - Number(l.commission_amount || 0), 0);
    const result = await refundService.transferToUser(
      Number(ownerId), netAmount, `PAYOUT-CMD-${commandeId}-${ownerId}`, `Reversement commande #${commandeId}`
    );
    if (result.status === null) continue; // pas de contact de paiement ou montant sous le minimum

    await pool.query(
      'UPDATE ligne_commandes SET payout_transfer_id = ?, payout_status = ?, payout_failure_reason = ? WHERE id IN (?)',
      [result.transfer_id, result.status, result.failure_reason, ownerLignes.map((l) => l.id)]
    );
  }
}

// Comme CommandeController::retryLignePayout côté web : relance les lignes du même vendeur.
async function retryLigne(req, res) {
  const [[ligne]] = await pool.query(
    `SELECT lc.id, lc.commande_id, p.user_id AS owner_id
     FROM ligne_commandes lc LEFT JOIN products p ON lc.product_id = p.id WHERE lc.id = ?`,
    [req.params.id]
  );
  if (!ligne) return res.status(404).json({ message: 'Ligne de commande introuvable' });

  await pool.query(
    `UPDATE ligne_commandes lc JOIN products p ON lc.product_id = p.id
     SET lc.payout_transfer_id = NULL, lc.payout_status = NULL, lc.payout_failure_reason = NULL
     WHERE lc.commande_id = ? AND p.user_id <=> ?`,
    [ligne.commande_id, ligne.owner_id]
  );
  await triggerCommandeOwnerPayouts(ligne.commande_id);

  const [[after]] = await pool.query('SELECT payout_status, payout_failure_reason FROM ligne_commandes WHERE id = ?', [ligne.id]);
  if (after.payout_status === 'error') {
    return res.status(422).json({ message: `Le virement a de nouveau échoué : ${after.payout_failure_reason || 'raison inconnue'}` });
  }
  res.json({ message: 'Virement relancé.', payout_status: after.payout_status });
}

module.exports = { adminList, recordPayout, failed, retryReservation, retryLigne };
