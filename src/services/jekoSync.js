const { pool } = require('../config/database');
const jeko = require('./jeko');

/* Confirmation des paiements Jèko directement auprès de Jèko, sans passer par le webhook ni
   par le backend web : même logique que JekoWebhookController::handlePayment côté web
   (markCommandePaid, activateSubscriptionFromPayment), idempotente pour pouvoir se croiser
   avec le webhook sans double comptage. */

const DEFAULT_COMMISSION_RATE = 10.00;

async function rateForUser(userId) {
  if (!userId) return DEFAULT_COMMISSION_RATE;
  const [[sub]] = await pool.query(
    `SELECT p.commission_rate FROM subscriptions s
     JOIN subscription_plans p ON s.subscription_plan_id = p.id
     WHERE s.user_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`,
    [userId]
  );
  return sub ? Number(sub.commission_rate) : DEFAULT_COMMISSION_RATE;
}

// Commande boutique payée : statut 'payé' (mot utilisé par le web) + commission par ligne.
async function markCommandePaid(commande) {
  const [flip] = await pool.query(
    "UPDATE commandes SET statut = 'payé', transaction_id = COALESCE(transaction_id, ?), updated_at = NOW() WHERE id = ? AND statut = 'en_cours'",
    [`TXN_${Date.now().toString(16)}`, commande.id]
  );
  if (!flip.affectedRows) return false;

  const [lignes] = await pool.query(
    `SELECT lc.id, lc.quantite, lc.prix, p.user_id FROM ligne_commandes lc
     JOIN products p ON lc.product_id = p.id WHERE lc.commande_id = ?`,
    [commande.id]
  );
  for (const l of lignes) {
    const rate = await rateForUser(l.user_id);
    await pool.query(
      'UPDATE ligne_commandes SET commission_rate = ?, commission_amount = ?, updated_at = NOW() WHERE id = ?',
      [rate, Math.round(l.quantite * l.prix * rate / 100), l.id]
    );
  }
  return true;
}

// Abonnement payé : prolonge d'un mois (comme extendSubscriptionPeriod côté web).
async function activateSubscription(subscription) {
  const [flip] = await pool.query(
    "UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = ? AND status <> 'active'",
    [subscription.id]
  );
  if (!flip.affectedRows) return false;

  const [[plan]] = await pool.query('SELECT price_monthly FROM subscription_plans WHERE id = ?', [subscription.subscription_plan_id]);
  const periodStart = subscription.current_period_end && new Date(subscription.current_period_end) > new Date()
    ? new Date(subscription.current_period_end)
    : new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await pool.query(
    'INSERT INTO subscription_payments (subscription_id, amount, period_start, period_end, payment_method, recorded_by, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NOW(), NOW(), NOW())',
    [subscription.id, plan ? plan.price_monthly : 0, periodStart, periodEnd, 'jeko']
  );
  await pool.query(
    'UPDATE subscriptions SET started_at = COALESCE(started_at, ?), current_period_end = ? WHERE id = ?',
    [periodStart, periodEnd, subscription.id]
  );
  return true;
}

async function jekoStatus(requestId) {
  if (!requestId) return null;
  const result = await jeko.getPaymentRequest(requestId);
  return (result && result.status) || null;
}

async function syncCommande(commande) {
  if (commande.statut === 'payé' || commande.statut === 'payée') return 'success';
  const status = await jekoStatus(commande.jeko_payment_request_id);
  if (status === 'success') await markCommandePaid(commande);
  return status;
}

async function syncSubscription(subscription) {
  const status = await jekoStatus(subscription.jeko_payment_request_id);
  if (status === 'success') await activateSubscription(subscription);
  return status;
}

/* Vérifie le paiement identifié par sa référence Jèko, quel que soit son type.
   Retourne le statut Jèko ('success', 'pending', 'error'…) ou null si la référence est inconnue. */
async function syncByReference(reference) {
  // Import différé : le contrôleur des réservations importe lui-même des services.
  const { syncJekoReservation } = require('../controllers/reservationController');

  const [res] = await pool.query('SELECT * FROM reservations WHERE jeko_reference = ?', [reference]);
  if (res.length) return syncJekoReservation(res[0]);

  const [cmd] = await pool.query('SELECT * FROM commandes WHERE jeko_reference = ?', [reference]);
  if (cmd.length) return syncCommande(cmd[0]);

  const [sub] = await pool.query('SELECT * FROM subscriptions WHERE jeko_reference = ?', [reference]);
  if (sub.length) return syncSubscription(sub[0]);

  return null;
}

module.exports = { syncByReference, syncCommande, syncSubscription, markCommandePaid };
