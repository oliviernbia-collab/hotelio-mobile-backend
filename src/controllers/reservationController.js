const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const jeko = require('../services/jeko');
const refundService = require('../services/refundService');
const { notifyUser: notifyClient } = require('../services/notify');
const mailer = require('../services/mailer');
const { buildReservationReceipt } = require('../services/receipts');
const jwt = require('jsonwebtoken');
const { canManageHotel } = require('../utils/authorize');

/* Notification in-app (lue aussi bien par le web que par le mobile, même table `notifications`) */
async function notifyUser(userId, type, title, message, extra = {}) {
  try {
    const notifId = uuidv4();
    await pool.query(
      `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
       VALUES (?, ?, 'App\\\\Models\\\\User', ?, ?, NOW(), NOW())`,
      [notifId, type, userId, JSON.stringify({ title, message, icon: 'fa-calendar-plus', color: '#009A44', ...extra })]
    );
  } catch (e) {
    console.error('Notification error:', e);
  }
}

/* Confirme le paiement effectif d'une réservation : statut + stats client/hôtel.
   N'est appelé ici que pour Espèces/Virement (confirmation immédiate, pas de passerelle) ;
   pour un paiement Jèko, c'est le webhook (partagé avec le web, même base) qui s'en charge. */
const COMMISSIONABLE_CHANNELS = ['Site web', 'App mobile'];
const DEFAULT_COMMISSION_RATE = 10.00;

async function computeCommission(reservation) {
  if (!COMMISSIONABLE_CHANNELS.includes(reservation.channel)) return null;

  const [[hotel]] = await pool.query('SELECT user_id FROM hotels WHERE id = ?', [reservation.hotel_id]);
  if (!hotel || !hotel.user_id) return null;

  const [[sub]] = await pool.query(
    `SELECT p.commission_rate FROM subscriptions s
     JOIN subscription_plans p ON s.subscription_plan_id = p.id
     WHERE s.user_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`,
    [hotel.user_id]
  );
  const rate = sub ? Number(sub.commission_rate) : DEFAULT_COMMISSION_RATE;
  const amount = Math.round(Number(reservation.total) * rate / 100);
  return { rate, amount };
}

// Idempotent : le passage paid 0 → 1 est atomique, donc un second appel (webhook web,
// page-relais et vérification depuis l'app peuvent se croiser) ne recompte pas les stats.
async function markReservationPaid(reservation) {
  const [flip] = await pool.query(
    "UPDATE reservations SET paid = 1, status = 'confirmée', updated_at = NOW() WHERE id = ? AND paid = 0",
    [reservation.id]
  );
  if (!flip.affectedRows) return false;

  const commission = await computeCommission(reservation);
  if (commission) {
    await pool.query(
      'UPDATE reservations SET commission_rate = ?, commission_amount = ? WHERE id = ?',
      [commission.rate, commission.amount, reservation.id]
    );
  }

  await pool.query(
    `UPDATE clients SET
       total_spend = total_spend + ?,
       total_stays = total_stays + 1,
       last_visit  = COALESCE(?, last_visit),
       updated_at  = NOW()
     WHERE id = ?`,
    [reservation.total, reservation.checkin, reservation.client_id]
  );
  await pool.query(
    'UPDATE hotels SET revenue = revenue + ?, checkins = checkins + 1 WHERE id = ?',
    [reservation.total, reservation.hotel_id]
  );

  const [[info]] = await pool.query(
    `SELECT res.*, c.user_id, c.first_name, c.last_name, COALESCE(u.email, c.email) AS recipient_email,
            h.name AS hotel_name, h.city AS hotel_city
     FROM reservations res
     JOIN clients c ON res.client_id = c.id
     JOIN hotels h ON res.hotel_id = h.id
     LEFT JOIN users u ON c.user_id = u.id
     WHERE res.id = ?`,
    [reservation.id]
  );

  // E-mail de confirmation avec facture PDF (comme ReservationConfirmed côté web).
  // Un échec SMTP ne doit pas annuler la confirmation du paiement.
  if (info && info.recipient_email) {
    try {
      await mailer.sendReservationConfirmed(info.recipient_email, info);
    } catch (e) {
      console.error('⚠️  E-mail de confirmation non envoyé:', e.message);
    }
  }

  // Notification in-app au client (même contenu que ReservationConfirmedNotification côté web)
  if (info && info.user_id) {
    await notifyUser(
      info.user_id,
      'reservation_confirmed',
      'Paiement confirmé',
      `Votre réservation ${reservation.code} à ${info.hotel_name} est confirmée.`,
      { icon: 'fa-circle-check', amount: reservation.total }
    );
  }
  return true;
}

/* Interroge directement Jèko sur la demande de paiement d'une réservation et la confirme si
   elle a abouti. Ne dépend ni du webhook ni du backend web : c'est ce qui permet à l'app de
   voir son paiement confirmé même quand le webhook n'arrive pas (dev local, serveur web arrêté). */
async function syncJekoReservation(reservation) {
  if (reservation.paid) return 'success';
  if (!reservation.jeko_payment_request_id) return null;

  const result = await jeko.getPaymentRequest(reservation.jeko_payment_request_id);
  const status = result && result.status;
  if (status === 'success') {
    await markReservationPaid(reservation);
  } else if (status === 'error') {
    await pool.query(
      "UPDATE reservations SET status = 'paiement_échoué', updated_at = NOW() WHERE id = ? AND paid = 0",
      [reservation.id]
    );
  }
  return status || null;
}

async function index(req, res) {
  const { hotel_id, status, client_id, from, to } = req.query;
  let sql = `SELECT res.*,
               c.first_name, c.last_name, c.phone AS client_phone,
               h.name AS hotel_name, h.short_name AS hotel_short_name, h.city AS hotel_city,
               r.number AS room_number, r.type AS room_type, r.price AS room_price
             FROM reservations res
             JOIN clients c  ON res.client_id = c.id
             JOIN hotels h   ON res.hotel_id  = h.id
             LEFT JOIN rooms r ON res.room_id = r.id
             WHERE 1=1`;
  const params = [];

  if (req.user.role === 'client') {
    sql += ' AND c.user_id = ?'; params.push(req.user.id);
  } else if (req.user.role === 'employe') {
    if (!req.user.hotel_id) return res.json([]);
    sql += ' AND res.hotel_id = ?'; params.push(req.user.hotel_id);
  } else if (req.user.role === 'prestataire') {
    // Uniquement les réservations des hôtels appartenant à ce prestataire
    sql += ' AND h.user_id = ?'; params.push(req.user.id);
    if (hotel_id)  { sql += ' AND res.hotel_id = ?';  params.push(hotel_id); }
    if (client_id) { sql += ' AND res.client_id = ?'; params.push(client_id); }
  } else {
    if (hotel_id)   { sql += ' AND res.hotel_id = ?';  params.push(hotel_id); }
    if (client_id)  { sql += ' AND res.client_id = ?'; params.push(client_id); }
  }

  if (status) { sql += ' AND res.status = ?';    params.push(status); }
  if (from)   { sql += ' AND res.checkin >= ?';  params.push(from); }
  if (to)     { sql += ' AND res.checkout <= ?'; params.push(to); }
  sql += ' ORDER BY res.created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

async function show(req, res) {
  const [rows] = await pool.query(
    `SELECT res.*,
            c.first_name, c.last_name, c.email AS client_email, c.phone AS client_phone, c.user_id AS client_user_id,
            h.name AS hotel_name, h.short_name AS hotel_short_name, h.city AS hotel_city, h.stars AS hotel_stars,
            h.quartier AS hotel_quartier, h.latitude AS hotel_latitude, h.longitude AS hotel_longitude, h.phone AS hotel_phone,
            r.number AS room_number, r.type AS room_type, r.price AS room_price
     FROM reservations res
     JOIN clients c  ON res.client_id = c.id
     JOIN hotels h   ON res.hotel_id  = h.id
     LEFT JOIN rooms r ON res.room_id = r.id
     WHERE res.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  if (!(await canAccessReservation(req.user, rows[0]))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }
  const [factures] = await pool.query('SELECT * FROM factures WHERE reservation_id = ?', [rows[0].id]);
  res.json({ ...rows[0], factures });
}

async function store(req, res) {
  let { client_id, hotel_id, room_id, room, checkin, checkout, nights, price, total, channel, payment_method, nationality, notes } = req.body;
  if (!hotel_id || !checkin || !checkout) {
    return res.status(422).json({ message: 'hotel_id, checkin et checkout requis' });
  }

  // Mêmes règles que DashboardController::storeReservation côté web : arrivée au plus tôt
  // aujourd'hui, départ après l'arrivée. Le nombre de nuits est toujours recalculé ici (jamais
  // repris de la requête), sinon le montant facturé pourrait être manipulé.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(String(checkin)) || !DATE_RE.test(String(checkout))) {
    return res.status(422).json({ message: 'Dates invalides (format AAAA-MM-JJ attendu).' });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (checkin < today) {
    return res.status(422).json({ message: "La date d'arrivée ne peut pas être dans le passé." });
  }
  if (checkout <= checkin) {
    return res.status(422).json({ message: "La date de départ doit être après la date d'arrivée." });
  }
  nights = Math.max(1, Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86400000));
  nationality = nationality || "Côte d'Ivoire";

  // Résolution automatique du client depuis l'utilisateur connecté
  if (!client_id && req.user) {
    const [clientRows] = await pool.query('SELECT id FROM clients WHERE user_id = ?', [req.user.id]);
    if (clientRows.length) {
      client_id = clientRows[0].id;
    } else {
      // Créer un enregistrement client à partir du compte utilisateur
      const [userRows] = await pool.query('SELECT name, email FROM users WHERE id = ?', [req.user.id]);
      if (userRows.length) {
        const u = userRows[0];
        const nameParts = u.name.trim().split(' ');
        const first_name = nameParts[0];
        const last_name  = nameParts.slice(1).join(' ') || first_name;
        const code = 'CLI-' + Date.now().toString(36).toUpperCase();
        const [ins] = await pool.query(
          'INSERT INTO clients (user_id, code, first_name, last_name, email, status) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.id, code, first_name, last_name, u.email, 'actif']
        );
        client_id = ins.insertId;
      }
    }
  }

  if (!client_id) {
    return res.status(422).json({ message: 'client_id requis' });
  }

  // Chambre et prix proviennent toujours de la base, jamais du client (évite toute manipulation
  // du montant facturé) — même logique que DashboardController::storeReservation côté web.
  if (room_id) {
    const [roomRows] = await pool.query(
      `SELECT r.number AS room_number, r.price AS room_price, h.price AS hotel_price
       FROM rooms r JOIN hotels h ON h.id = r.hotel_id
       WHERE r.id = ? AND r.hotel_id = ?`,
      [room_id, hotel_id]
    );
    if (!roomRows.length) {
      return res.status(422).json({ message: 'Chambre introuvable pour cet hôtel.' });
    }
    room  = roomRows[0].room_number;
    price = Number(roomRows[0].room_price) || Number(roomRows[0].hotel_price) || 0;
    total = price * nights;
  } else {
    const [hotelRows] = await pool.query('SELECT price FROM hotels WHERE id = ?', [hotel_id]);
    if (!hotelRows.length) {
      return res.status(422).json({ message: 'Hôtel introuvable.' });
    }
    price = Number(hotelRows[0].price) || 0;
    total = price * nights;
    room  = room || '';
  }

  // Disponibilité de la chambre sur la période demandée (même hôtel, mêmes dates qui se chevauchent)
  if (room) {
    const [overlap] = await pool.query(
      `SELECT id FROM reservations
       WHERE hotel_id = ? AND room = ? AND status NOT IN ('annulée')
         AND checkin < ? AND checkout > ?
       LIMIT 1`,
      [hotel_id, room, checkout, checkin]
    );
    if (overlap.length) {
      return res.status(422).json({ message: "Cette chambre n'est pas disponible aux dates sélectionnées." });
    }
  }

  const code = 'RES-' + Date.now().toString(36).toUpperCase();
  const [result] = await pool.query(
    'INSERT INTO reservations (code, client_id, hotel_id, room_id, room, checkin, checkout, nights, price, total, status, channel, payment_method, nationality, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [code, client_id, hotel_id, room_id || null, room || '', checkin, checkout, nights, price, total, 'en_attente', channel || 'App mobile', payment_method || null, nationality || null, notes || null]
  );

  if (room_id) {
    // Ne passe "réservée" que si elle était "disponible" — ne réserve pas une chambre déjà occupée/en nettoyage
    await pool.query("UPDATE rooms SET status = 'réservée', updated_at = NOW() WHERE id = ? AND status = 'disponible'", [room_id]);
  }

  // Notifier le propriétaire de l'hôtel (comme côté web) — stats client/hôtel non mises à jour ici :
  // elles le sont uniquement une fois le paiement réellement confirmé (processPayment / webhook Jèko).
  const [hotelRows2] = await pool.query('SELECT user_id, name, short_name FROM hotels WHERE id = ?', [hotel_id]);
  if (hotelRows2.length && hotelRows2[0].user_id) {
    await notifyUser(
      hotelRows2[0].user_id,
      'reservation_created',
      'Nouvelle réservation',
      `Réservation ${code} pour ${hotelRows2[0].short_name || hotelRows2[0].name} — ${checkin}`,
      { amount: total }
    );
  }

  const [newRes] = await pool.query('SELECT * FROM reservations WHERE id = ?', [result.insertId]);
  res.status(201).json(newRes[0]);
}

async function mine(req, res) {
  const { status, from, to, per_page } = req.query;
  let sql = `SELECT res.*,
               c.first_name, c.last_name, c.phone AS client_phone,
               h.name AS hotel_name, h.short_name AS hotel_short_name, h.city AS hotel_city,
               r.number AS room_number, r.type AS room_type, r.price AS room_price
             FROM reservations res
             JOIN clients c  ON res.client_id = c.id
             JOIN hotels h   ON res.hotel_id  = h.id
             LEFT JOIN rooms r ON res.room_id = r.id
             WHERE c.user_id = ?`;
  const params = [req.user.id];
  if (status) { sql += ' AND res.status = ?';    params.push(status); }
  if (from)   { sql += ' AND res.checkin >= ?';  params.push(from); }
  if (to)     { sql += ' AND res.checkout <= ?'; params.push(to); }
  sql += ' ORDER BY res.created_at DESC';
  if (per_page) { sql += ` LIMIT ${parseInt(per_page, 10)}`; }
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}

// Vérifie que l'utilisateur a le droit de CONSULTER ou PAYER cette réservation précise :
// admin, staff de l'hôtel concerné, ou le client qui en est le propriétaire.
async function canAccessReservation(user, reservation) {
  if (user.role === 'admin') return true;
  if (user.role === 'client') return reservation.client_user_id === user.id;
  return canManageHotel(user, reservation.hotel_id);
}

// Vérifie que l'utilisateur a le droit de changer le statut de CETTE réservation précise.
// Un client ne peut qu'annuler sa propre réservation ; le staff est limité à son périmètre d'hôtel.
async function canUpdateReservationStatus(user, reservation, newStatus) {
  if (user.role === 'admin') return true;
  if (user.role === 'prestataire') return canManageHotel(user, reservation.hotel_id);
  if (user.role === 'employe') return Number(user.hotel_id) === Number(reservation.hotel_id);
  if (user.role === 'client') return reservation.client_user_id === user.id && newStatus === 'annulée';
  return false;
}

/**
 * Reverse automatiquement la part du propriétaire (total − commission) vers son contact
 * Jèko, uniquement quand l'argent est réellement passé par le compte Jèko de la plateforme
 * (réservation commissionnable). Déclenché au check-in réel (le séjour commence, plus de
 * risque d'annulation) — jamais à la confirmation du paiement, pour que le remboursement
 * total reste possible tant que le client n'a pas commencé son séjour. Miroir de
 * DashboardController::triggerOwnerPayout côté web ; filet de sécurité partagé via la
 * commande planifiée Laravel `payouts:release-due` (même base) si le check-in n'est jamais
 * pointé dans l'app.
 */
async function triggerOwnerPayout(reservation) {
  if (reservation.payout_transfer_id) return; // déjà déclenché (idempotence)
  if (!COMMISSIONABLE_CHANNELS.includes(reservation.channel)) return;

  const [[hotel]] = await pool.query('SELECT user_id FROM hotels WHERE id = ?', [reservation.hotel_id]);
  if (!hotel || !hotel.user_id) return;

  const netAmount = Number(reservation.total) - Number(reservation.commission_amount || 0);
  const reference = `PAYOUT-RES-${reservation.id}`;

  const result = await refundService.transferToUser(hotel.user_id, netAmount, reference, `Reversement réservation ${reservation.code}`);
  if (result.status === null) return;

  await pool.query(
    'UPDATE reservations SET payout_transfer_id = ?, payout_status = ?, payout_failure_reason = ? WHERE id = ?',
    [result.transfer_id, result.status, result.failure_reason, reservation.id]
  );
}

async function updateStatus(req, res) {
  const { status } = req.body;
  // Mêmes statuts que le web (DashboardController::updateReservationStatus)
  const valid = ['confirmée', 'en_attente', 'annulée', 'arrivée', 'départie'];
  if (!valid.includes(status)) return res.status(422).json({ message: 'Statut invalide' });

  const [rows] = await pool.query(
    `SELECT res.*, c.user_id AS client_user_id
     FROM reservations res JOIN clients c ON res.client_id = c.id
     WHERE res.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  const reservation = rows[0];

  if (!(await canUpdateReservationStatus(req.user, reservation, status))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }

  if (status === 'annulée' && reservation.status !== 'annulée') {
    // Paiement Jèko pas encore confirmé : on vérifie d'abord, sinon une réservation réellement
    // payée serait annulée comme impayée, donc sans remboursement.
    if (!reservation.paid && reservation.jeko_payment_request_id) {
      try {
        if ((await syncJekoReservation(reservation)) === 'success') {
          const [[fresh]] = await pool.query('SELECT * FROM reservations WHERE id = ?', [reservation.id]);
          Object.assign(reservation, fresh);
        }
      } catch (e) {
        return res.status(502).json({ message: 'Impossible de vérifier le paiement auprès de Jèko. Réessayez dans un instant.' });
      }
    }
    const result = await refundService.cancelReservation(reservation, { byHotel: req.user.role !== 'client' });
    if (!result.ok) {
      return res.status(422).json({ error: result.error, message: result.message });
    }
    // Annulation par l'hôtel ou un admin : le client est prévenu (app + e-mail), comme
    // updateReservationStatus côté web. Le remboursement Jèko notifie déjà de son côté.
    if (req.user.role !== 'client' && result.refundAmount == null && reservation.client_user_id) {
      const [[hotel]] = await pool.query('SELECT name, short_name FROM hotels WHERE id = ?', [reservation.hotel_id]);
      await notifyClient(
        reservation.client_user_id,
        'reservation_cancelled',
        'Réservation annulée',
        `La réservation ${reservation.code} pour ${hotel?.short_name || hotel?.name || "l'hôtel"} a été annulée.`,
        { icon: 'fa-calendar-xmark', color: '#e63946' },
        { withEmail: true }
      );
    }
    return res.json({ message: result.message, status: 'annulée', refund: { fee: result.fee, amount: result.refundAmount, status: result.refundStatus } });
  }

  await pool.query('UPDATE reservations SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
  res.json({ message: 'Statut mis à jour', status });
}

async function checkin(req, res) {
  const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }
  if (rows[0].checkin_at) {
    return res.status(422).json({ message: 'Le check-in a déjà été effectué.' });
  }
  // Même statut que le web (DashboardController::checkIn) : la base est partagée. Le compteur
  // de check-ins de l'hôtel n'est pas touché ici : il est incrémenté au paiement.
  await pool.query("UPDATE reservations SET checkin_at = NOW(), status = 'arrivée', updated_at = NOW() WHERE id = ?", [req.params.id]);
  await setRoomStatus(rows[0], 'occupée');

  // Le séjour commence : plus de risque d'annulation, on peut reverser le prestataire.
  if (rows[0].paid) {
    const [fresh] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    await triggerOwnerPayout(fresh[0]);
  }

  res.json({ message: 'Check-in enregistré' });
}

async function checkout(req, res) {
  const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  if (!(await canManageHotel(req.user, rows[0].hotel_id))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }
  if (rows[0].checkout_at) {
    return res.status(422).json({ message: 'Le check-out a déjà été effectué.' });
  }
  if (!rows[0].checkin_at) {
    return res.status(422).json({ message: "Le check-in n'a pas encore été effectué." });
  }
  // Même statut que le web (DashboardController::checkOut). Le chiffre d'affaires de l'hôtel et
  // les dépenses/séjours du client sont déjà comptés au paiement (markReservationPaid) : on ne
  // les recompte pas ici.
  await pool.query("UPDATE reservations SET checkout_at = NOW(), status = 'départie', updated_at = NOW() WHERE id = ?", [req.params.id]);
  await setRoomStatus(rows[0], 'en_nettoyage');
  await pool.query('UPDATE hotels SET checkouts = checkouts + 1 WHERE id = ?', [rows[0].hotel_id]);
  // Fidélité, comme le web : 10 points par nuit, crédités au départ
  await pool.query(
    'UPDATE clients SET points_fidelite = points_fidelite + ?, last_visit = CURDATE(), updated_at = NOW() WHERE id = ?',
    [Number(rows[0].nights || 0) * LOYALTY_POINTS_PER_NIGHT, rows[0].client_id]
  );
  res.json({ message: 'Check-out enregistré. Points fidélité crédités.' });
}

const LOYALTY_POINTS_PER_NIGHT = 10;

// Chambre de la réservation : par id si connu, sinon par numéro (réservations créées sur le web).
async function setRoomStatus(reservation, status) {
  if (reservation.room_id) {
    await pool.query('UPDATE rooms SET status = ?, updated_at = NOW() WHERE id = ?', [status, reservation.room_id]);
  } else if (reservation.room) {
    await pool.query('UPDATE rooms SET status = ?, updated_at = NOW() WHERE hotel_id = ? AND number = ?', [status, reservation.hotel_id, reservation.room]);
  }
}

async function processPayment(req, res) {
  const { payment_method } = req.body;
  const [rows] = await pool.query(
    `SELECT res.*, c.user_id AS client_user_id
     FROM reservations res JOIN clients c ON res.client_id = c.id
     WHERE res.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  const reservation = rows[0];

  if (!(await canAccessReservation(req.user, reservation))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }

  if (reservation.paid) {
    return res.json({ message: 'Paiement déjà confirmé', paid: true });
  }

  const jekoMethod = jeko.mapPaymentMethod(payment_method);

  // Espèces / Virement : aucune passerelle ne les gère, confirmation immédiate (comportement historique)
  if (!jekoMethod) {
    await pool.query('UPDATE reservations SET payment_method = ?, updated_at = NOW() WHERE id = ?', [payment_method, req.params.id]);
    await markReservationPaid(reservation);
    return res.json({ message: 'Paiement enregistré', paid: true });
  }

  const reference = `HOTELIO-RES-${reservation.id}-${Date.now()}`;
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;

  let result;
  try {
    result = await jeko.createPaymentRequest({
      storeId: process.env.JEKO_STORE_ID,
      amountCents: Math.round(Number(reservation.total) * 100),
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
    return res.status(422).json({ message: (result && result.message) || 'Impossible de lancer le paiement. Réessayez ou choisissez un autre moyen.' });
  }

  await pool.query(
    'UPDATE reservations SET payment_method = ?, jeko_reference = ?, jeko_payment_request_id = ? WHERE id = ?',
    [payment_method, reference, result.id || null, req.params.id]
  );

  res.json({ message: 'Redirection vers Jèko', paid: false, redirectUrl: result.redirectUrl, reference });
}

// Appelé par l'app au retour du navigateur de paiement : vérifie auprès de Jèko et confirme.
async function verifyPayment(req, res) {
  const [rows] = await pool.query(`SELECT res.*, c.user_id AS client_user_id FROM reservations res JOIN clients c ON res.client_id = c.id WHERE res.id = ?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  const reservation = rows[0];

  if (!(await canAccessReservation(req.user, reservation))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }

  let status;
  try {
    status = await syncJekoReservation(reservation);
  } catch (e) {
    return res.status(502).json({ message: 'Impossible de contacter Jèko pour le moment.' });
  }
  res.json({ paid: status === 'success', status });
}

/* Reçu PDF : l'app obtient un jeton de 2 minutes (requête authentifiée), puis ouvre le lien
   de téléchargement dans le navigateur, qui ne peut pas envoyer l'en-tête Authorization
   (même mécanisme que le téléchargement des factures). */
async function receiptToken(req, res) {
  const [rows] = await pool.query(`SELECT res.*, c.user_id AS client_user_id FROM reservations res JOIN clients c ON res.client_id = c.id WHERE res.id = ?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  const reservation = rows[0];

  if (!(await canAccessReservation(req.user, reservation))) {
    return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
  }
  if (!reservation.paid) {
    return res.status(422).json({ message: 'Le reçu est disponible une fois la réservation payée.' });
  }

  const token = jwt.sign(
    { purpose: 'reservation-receipt', reservationId: reservation.id },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '2m' }
  );
  res.json({ token });
}

async function receipt(req, res) {
  let decoded;
  try {
    decoded = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).send('Lien de téléchargement invalide ou expiré.');
  }
  if (decoded.purpose !== 'reservation-receipt' || Number(decoded.reservationId) !== Number(req.params.id)) {
    return res.status(401).send('Lien de téléchargement invalide.');
  }

  const [[r]] = await pool.query(
    `SELECT res.*, c.first_name, c.last_name, h.name AS hotel_name, h.city AS hotel_city
     FROM reservations res
     JOIN clients c ON res.client_id = c.id
     JOIN hotels h ON res.hotel_id = h.id
     WHERE res.id = ? AND res.paid = 1`,
    [req.params.id]
  );
  if (!r) return res.status(404).send('Reçu introuvable.');

  const pdf = await buildReservationReceipt(r);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="recu_${r.code}.pdf"`,
    'Content-Length': pdf.length,
  });
  res.send(pdf);
}

module.exports = { index, mine, show, store, updateStatus, checkin, checkout, processPayment, verifyPayment, syncJekoReservation, receiptToken, receipt, triggerOwnerPayout };
