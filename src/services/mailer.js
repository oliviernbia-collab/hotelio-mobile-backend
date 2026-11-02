const nodemailer = require('nodemailer');
const { buildReservationReceipt } = require('./receipts');

// Même compte SMTP que le backend web (variables MAIL_* de webPHP/.env).
// Sans MAIL_HOST, l'envoi est simplement désactivé (dev local sans SMTP).
let transporter = null;
function getTransporter() {
  if (!process.env.MAIL_HOST) return null;
  if (!transporter) {
    const port = Number(process.env.MAIL_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port,
      secure: port === 465,
      auth: process.env.MAIL_USERNAME
        ? { user: process.env.MAIL_USERNAME, pass: process.env.MAIL_PASSWORD }
        : undefined,
    });
  }
  return transporter;
}

const fmtDate  = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');
const fmtMoney = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* E-mail de confirmation de réservation, avec la facture PDF en pièce jointe.
   `r` : ligne de réservation jointe au client (first_name, last_name, email) et à l'hôtel (hotel_name, hotel_city). */
async function sendReservationConfirmed(to, r) {
  const t = getTransporter();
  if (!t || !to) return false;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#2C3E50;max-width:560px">
      <h2 style="color:#1E3A5F">Réservation confirmée</h2>
      <p>Bonjour ${escapeHtml(r.first_name || 'cher client')},</p>
      <p>Votre réservation a bien été enregistrée pour l'hôtel <strong>${escapeHtml(r.hotel_name)}</strong>.</p>
      <ul>
        <li>Référence : <strong>${escapeHtml(r.code)}</strong></li>
        <li>Chambre : <strong>${escapeHtml(r.room || '—')}</strong></li>
        <li>Check-in : <strong>${fmtDate(r.checkin)}</strong></li>
        <li>Check-out : <strong>${fmtDate(r.checkout)}</strong></li>
        <li>Nombre de nuits : <strong>${escapeHtml(r.nights)}</strong></li>
        <li>Montant total : <strong>${fmtMoney(r.total)}</strong></li>
        <li>Mode de paiement : <strong>${escapeHtml(r.payment_method || '—')}</strong></li>
      </ul>
      <p>Vous trouverez votre facture en pièce jointe.</p>
      <p>Merci de votre confiance,<br>L'équipe Hôtelio</p>
    </div>`;

  await t.sendMail({
    from: { name: process.env.MAIL_FROM_NAME || 'Hôtelio', address: process.env.MAIL_FROM_ADDRESS || process.env.MAIL_USERNAME },
    to,
    subject: `Confirmation de réservation - ${r.code}`,
    html,
    attachments: [{ filename: `facture_${r.code}.pdf`, content: await buildReservationReceipt(r), contentType: 'application/pdf' }],
  });
  return true;
}

/* E-mail court qui reprend une notification in-app (équivalent du canal 'mail' des
   notifications Laravel : nouvel avis, réservation annulée…). */
async function sendNotice(to, title, message) {
  const t = getTransporter();
  if (!t || !to) return false;

  await t.sendMail({
    from: { name: process.env.MAIL_FROM_NAME || 'Hôtelio', address: process.env.MAIL_FROM_ADDRESS || process.env.MAIL_USERNAME },
    to,
    subject: title,
    html: `
      <div style="font-family:Arial,sans-serif;color:#2C3E50;max-width:560px">
        <h2 style="color:#1E3A5F">${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <p>L'équipe Hôtelio</p>
      </div>`,
  });
  return true;
}

module.exports = { sendReservationConfirmed, sendNotice };
