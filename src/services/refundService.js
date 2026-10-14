const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const jeko = require('./jeko');

/**
 * Annulation avec remboursement réel d'une réservation ou d'une commande boutique déjà
 * payée. Miroir exact de webPHP/app/Services/RefundService.php — à garder synchronisé
 * avec lui si la politique change. Jèko n'offrant pas de remboursement vers le moyen de
 * paiement d'origine, le client est remboursé via un virement sortant (comme un
 * reversement prestataire) vers son propre contact Jèko enregistré.
 *
 * Répartition fixe sur le montant payé : 5% de frais d'annulation, dont 4% pour
 * l'administrateur de la plateforme (reste simplement sur le compte Jèko de l'app,
 * aucun virement nécessaire) et 1% pour le prestataire concerné ; 95% remboursés au client.
 */
const FEE_RATE = 5;
const ADMIN_SHARE_RATE = 4;
const PROVIDER_SHARE_RATE = 1; // eslint-disable-line no-unused-vars (documentation, dérivé de FEE_RATE - ADMIN_SHARE_RATE)
const COMMANDE_CANCEL_WINDOW_HOURS = 48;

function splitAmounts(total) {
  const fee = Math.round((total * FEE_RATE) / 100);
  const adminAmount = Math.round((total * ADMIN_SHARE_RATE) / 100);
  const providerAmount = fee - adminAmount; // évite les écarts d'arrondi, reste ≈ 1%

  return { fee, adminAmount, providerAmount, refundAmount: total - fee };
}

/** Miroir de PayoutService::transfer (Laravel) : virement vers un User déjà doté d'un jeko_contact_id. */
async function transferToUser(userId, netAmount, reference, description) {
  const [[user]] = await pool.query('SELECT jeko_contact_id FROM users WHERE id = ?', [userId]);
  if (!user || !user.jeko_contact_id || netAmount < 5) {
    return { status: null, transfer_id: null, failure_reason: null };
  }

  let result;
  try {
    result = await jeko.createTransfer({
      storeId: process.env.JEKO_STORE_ID,
      contactId: user.jeko_contact_id,
      amountCents: netAmount * 100,
      currency: 'XOF',
      description,
      reference,
    });
  } catch (e) {
    console.error('Erreur réseau lors du virement Jèko', { reference, error: e.message });
    return { status: 'error', transfer_id: null, failure_reason: 'Erreur réseau Jèko' };
  }

  if (result && result.status) {
    return { status: result.status, transfer_id: result.id || null, failure_reason: null };
  }

  console.error('Échec du virement de reversement Jèko', { reference, result });
  return {
    status: 'error',
    transfer_id: null,
    failure_reason: (result && (result.message || result.id)) || 'Erreur inconnue',
  };
}

async function hasPayoutContact(userId) {
  if (!userId) return false;
  const [[user]] = await pool.query('SELECT jeko_contact_id FROM users WHERE id = ?', [userId]);
  return !!(user && user.jeko_contact_id);
}

async function notifyUser(userId, type, title, message, extra = {}) {
  try {
    const notifId = uuidv4();
    await pool.query(
      `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
       VALUES (?, ?, 'App\\\\Models\\\\User', ?, ?, NOW(), NOW())`,
      [notifId, type, userId, JSON.stringify({ title, message, icon: 'fa-calendar-xmark', color: '#e63946', ...extra })]
    );
  } catch (e) {
    console.error('Notification error:', e);
  }
}

/** Annule les effets comptables de markReservationPaid() : commission remise à zéro, stats décrémentées. */
async function reverseReservationCommissionAndStats(reservation) {
  await pool.query(
    'UPDATE hotels SET revenue = GREATEST(revenue - ?, 0), checkins = GREATEST(checkins - 1, 0) WHERE id = ?',
    [reservation.total, reservation.hotel_id]
  );
  await pool.query(
    'UPDATE clients SET total_spend = GREATEST(total_spend - ?, 0), total_stays = GREATEST(total_stays - 1, 0) WHERE id = ?',
    [reservation.total, reservation.client_id]
  );
  await pool.query('UPDATE reservations SET commission_rate = NULL, commission_amount = NULL WHERE id = ?', [reservation.id]);
}

/** Annulation remboursable tant que le séjour n'a pas commencé. */
function canCancelReservation(reservation) {
  if (!['en_attente', 'confirmée'].includes(reservation.status)) return false;
  if (reservation.checkin_at) return false;

  const checkinDate = new Date(reservation.checkin);
  const today = new Date();
  checkinDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return checkinDate >= today;
}

/**
 * `reservation` doit contenir : id, code, total, status, checkin, checkin_at, paid,
 * jeko_reference, hotel_id, client_id, payout_transfer_id.
 */
async function cancelReservation(reservation) {
  if (!reservation.paid) {
    if (reservation.checkin_at) {
      return { ok: false, error: 'too_late', message: 'Cette réservation ne peut plus être annulée (séjour déjà commencé).' };
    }
    await pool.query("UPDATE reservations SET status = 'annulée', updated_at = NOW() WHERE id = ?", [reservation.id]);
    return { ok: true, error: null, message: 'Réservation annulée.' };
  }

  if (!canCancelReservation(reservation)) {
    return { ok: false, error: 'too_late', message: 'Cette réservation ne peut plus être annulée (séjour commencé ou trop proche).' };
  }

  if (!reservation.jeko_reference) {
    // Payée en espèces/virement : l'argent n'est jamais passé par Jèko, impossible et
    // incorrect d'y puiser un remboursement — reste géré manuellement par l'hôtel.
    await reverseReservationCommissionAndStats(reservation);
    await pool.query(
      "UPDATE reservations SET status = 'annulée', cancelled_at = NOW(), updated_at = NOW() WHERE id = ?",
      [reservation.id]
    );
    return { ok: true, error: null, message: 'Réservation annulée. Remboursement à gérer directement avec le client (paiement espèces/virement).' };
  }

  const [[client]] = await pool.query('SELECT user_id FROM clients WHERE id = ?', [reservation.client_id]);
  const clientUserId = client && client.user_id;
  if (!(await hasPayoutContact(clientUserId))) {
    return {
      ok: false,
      error: 'missing_payout_contact',
      message: "Enregistrez d'abord vos coordonnées de paiement (mobile money ou compte bancaire) pour recevoir votre remboursement.",
    };
  }

  const { fee, adminAmount, providerAmount, refundAmount } = splitAmounts(Number(reservation.total));

  const refundResult = await transferToUser(
    clientUserId,
    refundAmount,
    `REFUND-RES-${reservation.id}`,
    `Remboursement réservation ${reservation.code}`
  );

  const [[hotel]] = await pool.query('SELECT user_id FROM hotels WHERE id = ?', [reservation.hotel_id]);
  if (reservation.payout_transfer_id) {
    // Le prestataire a déjà reçu l'intégralité de son reversement avant l'annulation
    // (ex: check-in pointé juste avant) — Jèko ne permet pas de le récupérer
    // automatiquement, régularisation manuelle nécessaire.
    console.warn('Annulation après reversement prestataire déjà effectué : régularisation manuelle nécessaire.', {
      reservation_id: reservation.id,
      payout_transfer_id: reservation.payout_transfer_id,
      provider_share_due: providerAmount,
    });
  } else if (hotel && hotel.user_id) {
    const ownerResult = await transferToUser(
      hotel.user_id,
      providerAmount,
      `PAYOUT-RES-${reservation.id}-CANCEL`,
      `Indemnité annulation réservation ${reservation.code}`
    );

    if (ownerResult.status !== null) {
      await pool.query(
        'UPDATE reservations SET payout_transfer_id = ?, payout_status = ?, payout_failure_reason = ? WHERE id = ?',
        [ownerResult.transfer_id, ownerResult.status, ownerResult.failure_reason, reservation.id]
      );
    }
  }

  await reverseReservationCommissionAndStats(reservation);

  await pool.query(
    `UPDATE reservations SET
       status = 'annulée', cancelled_at = NOW(), updated_at = NOW(),
       cancellation_fee_amount = ?, admin_fee_amount = ?, refund_amount = ?,
       refund_transfer_id = ?, refund_status = ?, refund_failure_reason = ?
     WHERE id = ?`,
    [fee, adminAmount, refundAmount, refundResult.transfer_id, refundResult.status, refundResult.failure_reason, reservation.id]
  );

  if (clientUserId) {
    await notifyUser(
      clientUserId,
      'reservation_cancelled',
      '❌ Réservation annulée',
      `Réservation ${reservation.code} annulée. Frais retenus : ${fee.toLocaleString()} FCFA (5%). Remboursé : ${refundAmount.toLocaleString()} FCFA.`,
      { amount: refundAmount }
    );
  }

  return {
    ok: true,
    error: null,
    message: 'Réservation annulée, remboursement initié.',
    fee,
    refundAmount,
    refundStatus: refundResult.status,
  };
}

/** Annulation remboursable uniquement pour une commande confirmée payée via Jèko (statut 'payé'), dans la fenêtre fixe. */
function canCancelCommande(commande) {
  if (!['payé', 'payée'].includes(commande.statut)) return false;
  const createdAt = new Date(commande.created_at);
  const windowStart = new Date(Date.now() - COMMANDE_CANCEL_WINDOW_HOURS * 3600 * 1000);
  return createdAt > windowStart;
}

/**
 * `commande` doit contenir : id, user_id, total, statut, created_at.
 * Ne s'applique qu'aux commandes confirmées par le webhook Jèko (statut 'payé') — les
 * commandes payées en espèces/virement ('confirmée') ou en attente de confirmation Jèko
 * ('en_cours') sont annulées simplement par l'appelant (restockage seul, aucun argent n'a
 * encore été collecté côté Jèko dans ces deux cas).
 */
async function cancelCommande(commande) {
  if (!['payé', 'payée'].includes(commande.statut)) {
    return { ok: false, error: 'not_paid', message: 'Cette commande ne peut plus être annulée.' };
  }

  if (!canCancelCommande(commande)) {
    return { ok: false, error: 'too_late', message: "Le délai d'annulation (48h après l'achat) est dépassé." };
  }

  if (!(await hasPayoutContact(commande.user_id))) {
    return {
      ok: false,
      error: 'missing_payout_contact',
      message: "Enregistrez d'abord vos coordonnées de paiement (mobile money ou compte bancaire) pour recevoir votre remboursement.",
    };
  }

  const { fee, adminAmount, providerAmount, refundAmount } = splitAmounts(Number(commande.total));

  const refundResult = await transferToUser(
    commande.user_id,
    refundAmount,
    `REFUND-CMD-${commande.id}`,
    `Remboursement commande #${commande.id}`
  );

  const [lignes] = await pool.query(
    `SELECT lc.id, lc.quantite, lc.prix, lc.payout_transfer_id, p.id AS product_id, p.user_id AS owner_id
     FROM ligne_commandes lc JOIN products p ON lc.product_id = p.id
     WHERE lc.commande_id = ?`,
    [commande.id]
  );

  for (const ligne of lignes) {
    await pool.query('UPDATE products SET stock = stock + ? WHERE id = ?', [ligne.quantite, ligne.product_id]);
  }

  const byOwner = {};
  for (const ligne of lignes) {
    if (!ligne.owner_id || ligne.payout_transfer_id) continue;
    if (!byOwner[ligne.owner_id]) byOwner[ligne.owner_id] = [];
    byOwner[ligne.owner_id].push(ligne);
  }

  const total = Number(commande.total);
  for (const [ownerId, ownerLignes] of Object.entries(byOwner)) {
    const ownerLineTotal = ownerLignes.reduce((sum, l) => sum + l.quantite * l.prix, 0);
    const ownerShare = total > 0 ? Math.round((providerAmount * ownerLineTotal) / total) : 0;

    const ownerResult = await transferToUser(
      Number(ownerId),
      ownerShare,
      `PAYOUT-CMD-${commande.id}-${ownerId}-CANCEL`,
      `Indemnité annulation commande #${commande.id}`
    );

    if (ownerResult.status !== null) {
      await pool.query(
        'UPDATE ligne_commandes SET payout_transfer_id = ?, payout_status = ?, payout_failure_reason = ? WHERE id IN (?)',
        [ownerResult.transfer_id, ownerResult.status, ownerResult.failure_reason, ownerLignes.map((l) => l.id)]
      );
    }
  }

  const alreadyPaidOut = lignes.filter((l) => l.payout_transfer_id);
  if (alreadyPaidOut.length) {
    console.warn('Annulation de commande après reversement prestataire déjà effectué : régularisation manuelle nécessaire.', {
      commande_id: commande.id,
      ligne_ids: alreadyPaidOut.map((l) => l.id),
    });
  }

  await pool.query('UPDATE ligne_commandes SET commission_rate = NULL, commission_amount = NULL WHERE commande_id = ?', [commande.id]);

  await pool.query(
    `UPDATE commandes SET
       statut = 'annulée', cancelled_at = NOW(), updated_at = NOW(),
       cancellation_fee_amount = ?, admin_fee_amount = ?, refund_amount = ?,
       refund_transfer_id = ?, refund_status = ?, refund_failure_reason = ?
     WHERE id = ?`,
    [fee, adminAmount, refundAmount, refundResult.transfer_id, refundResult.status, refundResult.failure_reason, commande.id]
  );

  return {
    ok: true,
    error: null,
    message: 'Commande annulée, remboursement initié, les articles ont été remis en stock.',
    fee,
    refundAmount,
    refundStatus: refundResult.status,
  };
}

module.exports = {
  splitAmounts,
  transferToUser,
  hasPayoutContact,
  canCancelReservation,
  cancelReservation,
  canCancelCommande,
  cancelCommande,
  reverseReservationCommissionAndStats,
};
