const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const jeko = require('../services/jeko');
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

async function markReservationPaid(reservation) {
  const commission = await computeCommission(reservation);
  if (commission) {
    await pool.query(
      'UPDATE reservations SET commission_rate = ?, commission_amount = ? WHERE id = ?',
      [commission.rate, commission.amount, reservation.id]
    );
  }

  await pool.query(
    "UPDATE reservations SET paid = 1, status = 'confirmée', updated_at = NOW() WHERE id = ?",
    [reservation.id]
  );
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
            c.first_name, c.last_name, c.email AS client_email, c.phone AS client_phone,
            h.name AS hotel_name, h.short_name AS hotel_short_name, h.city AS hotel_city, h.stars AS hotel_stars,
            r.number AS room_number, r.type AS room_type, r.price AS room_price
     FROM reservations res
     JOIN clients c  ON res.client_id = c.id
     JOIN hotels h   ON res.hotel_id  = h.id
     LEFT JOIN rooms r ON res.room_id = r.id
     WHERE res.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  const [factures] = await pool.query('SELECT * FROM factures WHERE reservation_id = ?', [rows[0].id]);
  res.json({ ...rows[0], factures });
}

async function store(req, res) {
  let { client_id, hotel_id, room_id, room, checkin, checkout, nights, price, total, channel, payment_method, nationality, notes } = req.body;
  if (!hotel_id || !checkin || !checkout) {
    return res.status(422).json({ message: 'hotel_id, checkin et checkout requis' });
  }

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

  // Calcul automatique des nuits si non fourni
  if (!nights) {
    const ms = new Date(checkout).getTime() - new Date(checkin).getTime();
    nights = Math.max(1, Math.round(ms / 86400000));
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

// Vérifie que l'utilisateur a le droit de changer le statut de CETTE réservation précise.
// Un client ne peut qu'annuler sa propre réservation ; le staff est limité à son périmètre d'hôtel.
async function canUpdateReservationStatus(user, reservation, newStatus) {
  if (user.role === 'admin') return true;
  if (user.role === 'prestataire') return canManageHotel(user, reservation.hotel_id);
  if (user.role === 'employe') return Number(user.hotel_id) === Number(reservation.hotel_id);
  if (user.role === 'client') return reservation.client_user_id === user.id && newStatus === 'annulée';
  return false;
}

// Annule les effets comptables de markReservationPaid() quand une réservation payée est annulée :
// la commission déjà calculée est remise à zéro et les statistiques (hôtel, client) sont décrémentées.
// Le paiement lui-même (`paid`) n'est pas touché — un éventuel remboursement reste géré manuellement.
async function reverseCommissionAndStats(reservation) {
  await pool.query(
    'UPDATE hotels SET revenue = GREATEST(revenue - ?, 0), checkins = GREATEST(checkins - 1, 0) WHERE id = ?',
    [reservation.total, reservation.hotel_id]
  );
  await pool.query(
    'UPDATE clients SET total_spend = GREATEST(total_spend - ?, 0), total_stays = GREATEST(total_stays - 1, 0) WHERE id = ?',
    [reservation.total, reservation.client_id]
  );
  await pool.query(
    'UPDATE reservations SET commission_rate = NULL, commission_amount = NULL WHERE id = ?',
    [reservation.id]
  );
}

async function updateStatus(req, res) {
  const { status } = req.body;
  const valid = ['confirmée', 'en_attente', 'annulée', 'complétée'];
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

  if (status === 'annulée' && reservation.status !== 'annulée' && reservation.paid) {
    await reverseCommissionAndStats(reservation);
  }

  await pool.query('UPDATE reservations SET status = ?, updated_at = NOW() WHERE id = ?', [status, req.params.id]);
  res.json({ message: 'Statut mis à jour', status });
}

async function checkin(req, res) {
  const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  await pool.query("UPDATE reservations SET checkin_at = NOW(), status = 'confirmée', updated_at = NOW() WHERE id = ?", [req.params.id]);
  if (rows[0].room_id) {
    await pool.query("UPDATE rooms SET status = 'occupée', updated_at = NOW() WHERE id = ?", [rows[0].room_id]);
  }
  await pool.query("UPDATE hotels SET checkins = checkins + 1 WHERE id = ?", [rows[0].hotel_id]);
  res.json({ message: 'Check-in enregistré' });
}

async function checkout(req, res) {
  const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  await pool.query("UPDATE reservations SET checkout_at = NOW(), status = 'complétée', updated_at = NOW() WHERE id = ?", [req.params.id]);
  if (rows[0].room_id) {
    await pool.query("UPDATE rooms SET status = 'en_nettoyage', updated_at = NOW() WHERE id = ?", [rows[0].room_id]);
  }
  await pool.query("UPDATE hotels SET checkouts = checkouts + 1, revenue = revenue + ? WHERE id = ?", [rows[0].total, rows[0].hotel_id]);
  // Mise à jour de la date de dernière visite seulement (total_spend déjà comptabilisé à la création)
  await pool.query("UPDATE clients SET last_visit = CURDATE(), updated_at = NOW() WHERE id = ?", [rows[0].client_id]);
  res.json({ message: 'Check-out enregistré' });
}

async function processPayment(req, res) {
  const { payment_method } = req.body;
  const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
  const reservation = rows[0];

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
          successUrl: `${appUrl}/payment/bridge?result=success`,
          errorUrl: `${appUrl}/payment/bridge?result=error`,
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

module.exports = { index, mine, show, store, updateStatus, checkin, checkout, processPayment };
