const { pool } = require('../config/database');
const jeko = require('../services/jeko');

async function plans(req, res) {
  const [rows] = await pool.query(
    'SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY sort_order'
  );
  res.json(rows.map((p) => ({ ...p, features: p.features ? JSON.parse(p.features) : [] })));
}

async function mine(req, res) {
  const [rows] = await pool.query(
    `SELECT s.*, p.slug as plan_slug, p.name as plan_name, p.price_monthly, p.commission_rate, p.max_hotels
     FROM subscriptions s
     JOIN subscription_plans p ON s.subscription_plan_id = p.id
     WHERE s.user_id = ?
     ORDER BY s.created_at DESC LIMIT 1`,
    [req.user.id]
  );
  res.json(rows[0] || null);
}

async function adminList(req, res) {
  const { status } = req.query;
  let sql = `SELECT s.*, u.name as user_name, u.email as user_email, p.slug as plan_slug, p.name as plan_name, p.price_monthly
             FROM subscriptions s
             JOIN users u ON s.user_id = u.id
             JOIN subscription_plans p ON s.subscription_plan_id = p.id
             WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  sql += ' ORDER BY s.created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function recordPayment(req, res) {
  const { amount, payment_method } = req.body;
  const [rows] = await pool.query(
    `SELECT s.*, p.price_monthly FROM subscriptions s
     JOIN subscription_plans p ON s.subscription_plan_id = p.id
     WHERE s.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Abonnement introuvable' });
  const subscription = rows[0];

  const amt = amount || subscription.price_monthly;
  const periodStart = subscription.current_period_end && new Date(subscription.current_period_end) > new Date()
    ? subscription.current_period_end
    : new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await pool.query(
    'INSERT INTO subscription_payments (subscription_id, amount, period_start, period_end, payment_method, recorded_by, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())',
    [subscription.id, amt, periodStart, periodEnd, payment_method || null, req.user.id]
  );

  await pool.query(
    "UPDATE subscriptions SET status = 'active', started_at = COALESCE(started_at, ?), current_period_end = ?, updated_at = NOW() WHERE id = ?",
    [periodStart, periodEnd, subscription.id]
  );

  const [updated] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscription.id]);
  res.json(updated[0]);
}

/**
 * Permet à un prestataire sans abonnement (compte créé avant ce système) de choisir un
 * palier a posteriori.
 */
async function choose(req, res) {
  const { plan } = req.body;
  const validPlans = ['starter', 'business', 'premium'];
  if (!validPlans.includes(plan)) return res.status(422).json({ message: 'Palier invalide' });

  const [existing] = await pool.query('SELECT id FROM subscriptions WHERE user_id = ?', [req.user.id]);
  if (existing.length) return res.status(422).json({ message: 'Vous avez déjà un abonnement.' });

  const [planRows] = await pool.query('SELECT id FROM subscription_plans WHERE slug = ?', [plan]);
  if (!planRows.length) return res.status(404).json({ message: 'Palier introuvable' });

  await pool.query(
    "INSERT INTO subscriptions (user_id, subscription_plan_id, status, created_at, updated_at) VALUES (?, ?, 'pending_payment', NOW(), NOW())",
    [req.user.id, planRows[0].id]
  );

  res.status(201).json({ message: 'Palier sélectionné' });
}

/**
 * Le prestataire paie lui-même son abonnement via Jèko (redirection, même principe que le
 * paiement d'une réservation). L'activation est automatique à la confirmation du paiement —
 * le webhook Jèko (géré côté Laravel, point d'entrée unique pour toute la plateforme) met à
 * jour directement la ligne `subscriptions` partagée, quelle que soit l'origine du paiement.
 */
async function pay(req, res) {
  const { payment_method } = req.body;
  const jekoMethod = jeko.mapPaymentMethod(payment_method);
  if (!jekoMethod) return res.status(422).json({ message: 'Moyen de paiement non pris en charge pour le paiement en ligne.' });

  const [rows] = await pool.query(
    `SELECT s.*, p.price_monthly FROM subscriptions s
     JOIN subscription_plans p ON s.subscription_plan_id = p.id
     WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Aucun abonnement trouvé' });
  const subscription = rows[0];

  const reference = `HOTELIO-SUB-${subscription.id}-${Date.now()}`;
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;

  let result;
  try {
    result = await jeko.createPaymentRequest({
      storeId: process.env.JEKO_STORE_ID,
      amountCents: Math.round(Number(subscription.price_monthly) * 100),
      currency: 'XOF',
      reference,
      paymentDetails: {
        type: 'redirect',
        data: {
          paymentMethod: jekoMethod,
          successUrl: `${appUrl}/payment/bridge?result=success&ref=${encodeURIComponent(reference)}`,
          errorUrl: `${appUrl}/payment/bridge?result=error&ref=${encodeURIComponent(reference)}`,
        },
      },
    });
  } catch (e) {
    return res.status(502).json({ message: 'Impossible de contacter Jèko pour le moment.' });
  }

  if (!result || !result.redirectUrl) {
    return res.status(422).json({ message: (result && result.message) || 'Impossible de lancer le paiement. Réessayez ou choisissez un autre moyen de paiement.' });
  }

  await pool.query(
    'UPDATE subscriptions SET jeko_reference = ?, jeko_payment_request_id = ? WHERE id = ?',
    [reference, result.id || null, subscription.id]
  );

  res.json({ redirectUrl: result.redirectUrl, reference });
}

module.exports = { plans, mine, adminList, recordPayment, pay, choose };
