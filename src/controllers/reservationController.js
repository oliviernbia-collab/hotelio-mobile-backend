const { pool } = require('../config/database');

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

  // Calcul du prix depuis la chambre (ou l'hôtel en fallback) si non fourni
  if ((!price || !total) && room_id) {
    const [roomRows] = await pool.query(
      `SELECT r.price AS room_price, h.price AS hotel_price
       FROM rooms r JOIN hotels h ON h.id = r.hotel_id
       WHERE r.id = ?`,
      [room_id]
    );
    if (roomRows.length) {
      const unitPrice = Number(roomRows[0].room_price) || Number(roomRows[0].hotel_price) || 0;
      price = price || unitPrice;
      total = total || unitPrice * nights;
    }
  } else if ((!price || !total) && hotel_id && !room_id) {
    // Pas de chambre sélectionnée : utiliser le prix de l'hôtel
    const [hotelRows] = await pool.query('SELECT price FROM hotels WHERE id = ?', [hotel_id]);
    if (hotelRows.length) {
      const unitPrice = Number(hotelRows[0].price) || 0;
      price = price || unitPrice;
      total = total || unitPrice * nights;
    }
  }

  const code = 'RES-' + Date.now().toString(36).toUpperCase();
  const [result] = await pool.query(
    'INSERT INTO reservations (code, client_id, hotel_id, room_id, room, checkin, checkout, nights, price, total, status, channel, payment_method, nationality, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [code, client_id, hotel_id, room_id || null, room || '', checkin, checkout, nights, price || 0, total || 0, 'confirmée', channel || null, payment_method || null, nationality || null, notes || null]
  );
  if (room_id) {
    await pool.query("UPDATE rooms SET status = 'réservée', updated_at = NOW() WHERE id = ?", [room_id]);
  }
  // Mettre à jour les dépenses et séjours du client dès la confirmation
  const finalTotal = total || 0;
  await pool.query(
    `UPDATE clients SET
       total_spend = total_spend + ?,
       total_stays = total_stays + 1,
       last_visit  = COALESCE(?, last_visit),
       updated_at  = NOW()
     WHERE id = ?`,
    [finalTotal, checkin || null, client_id]
  );
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

async function updateStatus(req, res) {
  const { status } = req.body;
  const valid = ['confirmée', 'en_attente', 'annulée', 'complétée'];
  if (!valid.includes(status)) return res.status(422).json({ message: 'Statut invalide' });
  const [rows] = await pool.query('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Réservation introuvable' });
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
  await pool.query('UPDATE reservations SET paid = 1, payment_method = ?, updated_at = NOW() WHERE id = ?', [payment_method, req.params.id]);
  res.json({ message: 'Paiement enregistré' });
}

module.exports = { index, mine, show, store, updateStatus, checkin, checkout, processPayment };
