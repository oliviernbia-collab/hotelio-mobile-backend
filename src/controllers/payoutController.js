const { pool } = require('../config/database');

const COMMISSIONABLE_CHANNELS = ['Site web', 'App mobile'];

// Exclut les réservations déjà reversées automatiquement avec succès (virement Jèko,
// déclenché côté web au moment du paiement — voir DashboardController::triggerOwnerPayout()).
// Ce montant est donc le solde restant à régler manuellement (fallback), pas le total historique.
async function computeOwed(userId) {
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

async function adminList(req, res) {
  const [owners] = await pool.query("SELECT id, name, email FROM users WHERE role = 'prestataire' ORDER BY name");

  const result = [];
  for (const owner of owners) {
    const owed = await computeOwed(owner.id);
    const [[paidRow]] = await pool.query('SELECT COALESCE(SUM(amount), 0) as paid FROM payouts WHERE user_id = ?', [owner.id]);
    const [lastRows] = await pool.query('SELECT paid_at FROM payouts WHERE user_id = ? ORDER BY paid_at DESC LIMIT 1', [owner.id]);
    const alreadyPaid = Number(paidRow.paid);
    result.push({
      id: owner.id,
      name: owner.name,
      email: owner.email,
      owed,
      already_paid: alreadyPaid,
      balance: owed - alreadyPaid,
      last_payout_at: lastRows[0]?.paid_at ?? null,
    });
  }

  result.sort((a, b) => b.balance - a.balance);
  res.json(result);
}

async function recordPayout(req, res) {
  const { amount, notes } = req.body;
  const userId = req.params.userId;
  if (!amount || Number(amount) <= 0) return res.status(422).json({ message: 'Montant invalide' });

  const owed = await computeOwed(userId);
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
