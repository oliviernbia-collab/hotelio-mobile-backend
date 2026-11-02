const { pool } = require('../config/database');
const jwt = require('jsonwebtoken');

function dstr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return dstr(new Date());
}

function firstOfMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function findMyStaff(userId) {
  const [rows] = await pool.query('SELECT * FROM staff WHERE user_id = ? LIMIT 1', [userId]);
  return rows.length ? rows[0] : null;
}

function workedMinutes(row) {
  if (!row.check_in || !row.check_out) return null;
  return Math.round((new Date(row.check_out) - new Date(row.check_in)) / 60000);
}

function statusOf(row) {
  if (!row.check_in) return 'absent';
  return row.late_minutes > 0 ? 'retard' : 'present';
}

function withComputed(row) {
  return { ...row, worked_minutes: workedMinutes(row), status: statusOf(row) };
}

async function computeLateMinutes(staffId, hotelId, checkInDate) {
  const dateOnly = dstr(checkInDate);
  const [rows] = await pool.query(
    'SELECT start_time FROM staff_schedules WHERE staff_id = ? AND hotel_id = ? AND date = ? AND start_time IS NOT NULL LIMIT 1',
    [staffId, hotelId, dateOnly]
  );
  if (!rows.length) return 0;
  const expected = new Date(`${dateOnly}T${rows[0].start_time}`);
  const diffMin = Math.round((checkInDate - expected) / 60000);
  return Math.max(0, diffMin);
}

async function checkIn(req, res) {
  const staff = await findMyStaff(req.user.id);
  if (!staff) return res.status(404).json({ message: "Aucune fiche employé n'est associée à votre compte." });

  const today = todayStr();
  const [existing] = await pool.query('SELECT * FROM pointages WHERE staff_id = ? AND date = ?', [staff.id, today]);
  if (existing.length && existing[0].check_in) {
    return res.status(422).json({ message: 'Vous avez déjà pointé votre arrivée aujourd\'hui.' });
  }

  const now = new Date();
  const lateMinutes = await computeLateMinutes(staff.id, staff.hotel_id, now);

  await pool.query(
    `INSERT INTO pointages (staff_id, hotel_id, date, check_in, check_in_source, late_minutes)
     VALUES (?, ?, ?, ?, 'mobile', ?)
     ON DUPLICATE KEY UPDATE hotel_id = VALUES(hotel_id), check_in = VALUES(check_in),
       check_in_source = VALUES(check_in_source), late_minutes = VALUES(late_minutes)`,
    [staff.id, staff.hotel_id, today, now, lateMinutes]
  );

  res.json({
    message: lateMinutes > 0 ? `Arrivée enregistrée avec ${lateMinutes} min de retard.` : 'Arrivée enregistrée. Bonne journée !',
    late_minutes: lateMinutes,
  });
}

async function checkOut(req, res) {
  const staff = await findMyStaff(req.user.id);
  if (!staff) return res.status(404).json({ message: "Aucune fiche employé n'est associée à votre compte." });

  const today = todayStr();
  const [rows] = await pool.query('SELECT * FROM pointages WHERE staff_id = ? AND date = ?', [staff.id, today]);
  if (!rows.length || !rows[0].check_in) {
    return res.status(422).json({ message: "Vous devez d'abord pointer votre arrivée." });
  }
  if (rows[0].check_out) {
    return res.status(422).json({ message: 'Vous avez déjà pointé votre départ aujourd\'hui.' });
  }

  await pool.query(
    "UPDATE pointages SET check_out = ?, check_out_source = 'mobile', updated_at = NOW() WHERE id = ?",
    [new Date(), rows[0].id]
  );

  res.json({ message: 'Départ enregistré. À bientôt !' });
}

/** Widget + historique de l'employé connecté */
async function me(req, res) {
  const staff = await findMyStaff(req.user.id);
  if (!staff) return res.status(404).json({ message: "Aucune fiche employé n'est associée à votre compte." });

  const today = todayStr();
  const [todayRows] = await pool.query('SELECT * FROM pointages WHERE staff_id = ? AND date = ?', [staff.id, today]);
  const [history] = await pool.query(
    'SELECT * FROM pointages WHERE staff_id = ? ORDER BY date DESC LIMIT 30',
    [staff.id]
  );

  res.json({
    staff,
    today: todayRows.length ? withComputed(todayRows[0]) : null,
    history: history.map(withComputed),
  });
}

/** Rapport pour prestataire / admin */
async function report(req, res) {
  if (!['admin', 'prestataire'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Accès réservé aux propriétaires.' });
  }

  const { hotel_id, staff_id, from, to } = req.query;
  const fromDate = from || firstOfMonthStr();
  const toDate = to || todayStr();

  let hotelFilter = '';
  const hotelParams = [];
  if (req.user.role === 'prestataire') {
    hotelFilter = ' AND h.user_id = ?';
    hotelParams.push(req.user.id);
  }

  const pointages = await queryPointages(req.user, { hotel_id, staff_id, from: fromDate, to: toDate }, 'DESC');

  let schSql = `SELECT ss.*, s.first_name, s.last_name, h.name as hotel_name, h.short_name as hotel_short_name
                FROM staff_schedules ss
                JOIN staff s ON ss.staff_id = s.id
                JOIN hotels h ON ss.hotel_id = h.id
                WHERE ss.date BETWEEN ? AND ? AND ss.shift != 'repos' AND ss.date < CURDATE()${hotelFilter}`;
  const schParams = [fromDate, toDate, ...hotelParams];
  if (hotel_id) { schSql += ' AND ss.hotel_id = ?'; schParams.push(hotel_id); }
  if (staff_id) { schSql += ' AND ss.staff_id = ?'; schParams.push(staff_id); }
  const [schedules] = await pool.query(schSql, schParams);

  const pointedKeys = new Set(
    pointages.filter(p => p.check_in).map(p => `${p.staff_id}_${dstr(p.date)}`)
  );
  const absences = schedules.filter(s => !pointedKeys.has(`${s.staff_id}_${dstr(s.date)}`));

  const computed = pointages.map(withComputed);
  const totalShifts  = schedules.length;
  const presentCount = computed.filter(p => p.check_in && p.late_minutes === 0).length;
  const lateCount    = computed.filter(p => p.check_in && p.late_minutes > 0).length;
  const absentCount  = absences.length;
  const punctuality  = totalShifts > 0 ? Math.round((presentCount / totalShifts) * 100) : null;

  res.json({
    pointages: computed,
    absences,
    stats: { totalShifts, presentCount, lateCount, absentCount, punctuality },
  });
}

// Pointages visibles par l'utilisateur (admin : tous ; prestataire : ses hôtels), filtrés.
async function queryPointages(user, { hotel_id, staff_id, from, to }, order) {
  let sql = `SELECT p.*, s.first_name, s.last_name, h.id as hotel_pk, h.name as hotel_name, h.short_name as hotel_short_name
             FROM pointages p
             JOIN staff s ON p.staff_id = s.id
             JOIN hotels h ON p.hotel_id = h.id
             WHERE p.date BETWEEN ? AND ?`;
  const params = [from, to];
  if (user.role === 'prestataire') { sql += ' AND h.user_id = ?'; params.push(user.id); }
  if (hotel_id) { sql += ' AND p.hotel_id = ?'; params.push(hotel_id); }
  if (staff_id) { sql += ' AND p.staff_id = ?'; params.push(staff_id); }
  sql += ` ORDER BY p.date ${order === 'ASC' ? 'ASC' : 'DESC'}`;
  const [rows] = await pool.query(sql, params);
  return rows;
}

/* Export CSV (Excel) — miroir de PointageController::export côté web. L'app obtient un jeton
   de 2 minutes puis ouvre le lien dans le navigateur, qui ne peut pas envoyer l'en-tête
   Authorization (même mécanisme que les reçus PDF). */
async function exportToken(req, res) {
  if (!['admin', 'prestataire'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Accès réservé aux propriétaires.' });
  }
  const { hotel_id, staff_id, from, to } = req.query;
  const token = jwt.sign(
    { purpose: 'pointage-export', userId: req.user.id, filters: { hotel_id, staff_id, from, to } },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '2m' }
  );
  res.json({ token });
}

const pad2 = (n) => String(n).padStart(2, '0');
// Heures stockées en heure locale ; la connexion MySQL lit en UTC, d'où les getters UTC.
const hhmm = (d) => (d ? `${pad2(new Date(d).getUTCHours())}:${pad2(new Date(d).getUTCMinutes())}` : '');
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv(req, res) {
  let decoded;
  try {
    decoded = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).send('Lien de téléchargement invalide ou expiré.');
  }
  if (decoded.purpose !== 'pointage-export') return res.status(401).send('Lien de téléchargement invalide.');

  const [[user]] = await pool.query('SELECT id, role FROM users WHERE id = ?', [decoded.userId]);
  if (!user || !['admin', 'prestataire'].includes(user.role)) return res.status(403).send('Accès refusé.');

  const f = decoded.filters || {};
  const from = f.from || firstOfMonthStr();
  const to = f.to || todayStr();
  const rows = (await queryPointages(user, { ...f, from, to }, 'ASC')).map(withComputed);

  const lines = [['Employé', 'Hôtel', 'Date', 'Arrivée', 'Départ', 'Retard (min)', 'Heures travaillées', 'Statut']];
  for (const p of rows) {
    const [y, m, d] = dstr(p.date).split('-');
    const worked = p.worked_minutes !== null ? `${pad2(Math.floor(p.worked_minutes / 60))}:${pad2(p.worked_minutes % 60)}` : '';
    lines.push([
      `${p.first_name} ${p.last_name}`,
      p.hotel_name || '',
      `${d}/${m}/${y}`,
      hhmm(p.check_in),
      hhmm(p.check_out),
      p.late_minutes ?? 0,
      worked,
      p.status.charAt(0).toUpperCase() + p.status.slice(1),
    ]);
  }

  const csv = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n'; // BOM pour Excel
  res.set({
    'Content-Type': 'text/csv; charset=UTF-8',
    'Content-Disposition': `attachment; filename="pointages_${from.replace(/-/g, '')}_${to.replace(/-/g, '')}.csv"`,
  });
  res.send(csv);
}

module.exports = { checkIn, checkOut, me, report, exportToken, exportCsv };
