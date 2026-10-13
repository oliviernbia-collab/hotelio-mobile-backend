const { pool } = require('../config/database');

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

module.exports = { adminList, recordPayout };
