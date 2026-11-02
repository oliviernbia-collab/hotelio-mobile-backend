const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

/* Reçus PDF des réservations et des commandes boutique (téléchargés depuis l'app, et joints
   à l'e-mail de confirmation de réservation). Logo copié dans le backend : en production,
   le dossier mobile/ n'est pas déployé à côté. */

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png');
const HAS_LOGO = fs.existsSync(LOGO_PATH);

const C = { primary: '#1E3A5F', text: '#2C3E50', muted: '#7F8C8D', line: '#ECF0F1', paid: '#10B981' };
const LEFT = 50;
const RIGHT = 545;

const fmtDate  = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : '—');
// pdfkit (polices standard) n'a pas le glyphe de l'espace fine insécable des nombres fr-FR.
const fmtMoney = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;

// Les moyens de paiement sont stockés en code (« wave », « orange »…) ou déjà en libellé.
const PAYMENT_LABELS = { wave: 'Wave', orange: 'Orange Money', orange_money: 'Orange Money', mtn: 'MTN Mobile Money', moov: 'Moov Money', djamo: 'Djamo', cash: 'Espèces', especes: 'Espèces', virement: 'Virement' };
const paymentLabel = (m) => (m ? PAYMENT_LABELS[String(m).toLowerCase()] || m : '—');

function render(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: LEFT });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
    doc.end();
  });
}

function header(doc, title, subtitle) {
  if (HAS_LOGO) doc.image(LOGO_PATH, LEFT, 45, { width: 48 });
  const x = HAS_LOGO ? LEFT + 60 : LEFT;
  doc.fillColor(C.primary).fontSize(22).text('Hôtelio', x, 48);
  doc.fillColor(C.muted).fontSize(10).text('hotelio-ci.site', x, 74);

  doc.fillColor(C.text).fontSize(16).text(title, LEFT, 48, { width: RIGHT - LEFT, align: 'right' });
  doc.fillColor(C.muted).fontSize(10).text(subtitle, LEFT, 70, { width: RIGHT - LEFT, align: 'right' });
  doc.text(`Émis le ${fmtDate(new Date())}`, LEFT, 84, { width: RIGHT - LEFT, align: 'right' });

  doc.moveTo(LEFT, 110).lineTo(RIGHT, 110).strokeColor(C.line).stroke();
  doc.y = 125;
}

function paidBadge(doc, label) {
  const y = doc.y;
  doc.roundedRect(LEFT, y, 90, 20, 10).fill(C.paid);
  doc.fillColor('#FFFFFF').fontSize(10).text(label, LEFT, y + 5, { width: 90, align: 'center' });
  doc.y = y + 32;
}

function rows(doc, items) {
  for (const [label, value] of items) {
    const y = doc.y;
    doc.fontSize(11).fillColor(C.muted).text(label, LEFT, y, { width: 200 });
    doc.fillColor(C.text).text(String(value ?? '—'), 260, y, { width: RIGHT - 260, align: 'right' });
    doc.y = Math.max(doc.y, y + 18);
  }
}

function total(doc, label, amount) {
  doc.moveDown(0.5);
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(C.line).stroke();
  doc.moveDown(0.6);
  const y = doc.y;
  doc.fontSize(14).fillColor(C.primary).text(label, LEFT, y);
  doc.text(fmtMoney(amount), 260, y, { width: RIGHT - 260, align: 'right' });
  doc.y = y + 24;
}

function footer(doc, reference) {
  doc.fontSize(9).fillColor(C.muted);
  if (reference) doc.text(`Référence de paiement : ${reference}`, LEFT, 760, { width: RIGHT - LEFT, align: 'center' });
  doc.text("Merci de votre confiance — l'équipe Hôtelio", LEFT, 774, { width: RIGHT - LEFT, align: 'center' });
}

/* `r` : réservation jointe au client (first_name, last_name) et à l'hôtel (hotel_name, hotel_city). */
function buildReservationReceipt(r) {
  return render((doc) => {
    header(doc, 'Reçu de réservation', r.code);
    paidBadge(doc, 'PAYÉE');

    doc.fontSize(13).fillColor(C.text).text(r.hotel_name || '', LEFT);
    if (r.hotel_city) doc.fontSize(10).fillColor(C.muted).text(r.hotel_city);
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor(C.text).text(`Client : ${[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}`);
    doc.moveDown(1);

    rows(doc, [
      ['Chambre', r.room || '—'],
      ['Arrivée', fmtDate(r.checkin)],
      ['Départ', fmtDate(r.checkout)],
      ['Nombre de nuits', r.nights],
      ['Prix par nuit', fmtMoney(r.price)],
      ['Mode de paiement', paymentLabel(r.payment_method)],
    ]);
    total(doc, 'Total payé', r.total);
    footer(doc, r.jeko_reference);
  });
}

/* `order` : commande jointe à l'acheteur (buyer_name, buyer_email) ; `lines` : name, quantite, prix. */
function buildOrderReceipt(order, lines) {
  return render((doc) => {
    header(doc, "Reçu d'achat", `Commande n° ${order.id}`);
    paidBadge(doc, order.statut === 'livrée' ? 'LIVRÉE' : 'PAYÉE');

    doc.fontSize(11).fillColor(C.text).text(`Client : ${order.buyer_name || '—'}`, LEFT);
    if (order.buyer_email) doc.fontSize(10).fillColor(C.muted).text(order.buyer_email);
    doc.fontSize(10).fillColor(C.muted).text(`Date d'achat : ${fmtDate(order.created_at)}`);
    doc.moveDown(1);

    // Tableau des articles
    const cols = { name: LEFT, qty: 330, price: 390, sum: 465 };
    let y = doc.y;
    doc.fontSize(10).fillColor(C.muted);
    doc.text('Article', cols.name, y);
    doc.text('Qté', cols.qty, y, { width: 50, align: 'right' });
    doc.text('Prix', cols.price, y, { width: 70, align: 'right' });
    doc.text('Montant', cols.sum, y, { width: RIGHT - cols.sum, align: 'right' });
    doc.moveTo(LEFT, y + 16).lineTo(RIGHT, y + 16).strokeColor(C.line).stroke();
    y += 24;

    doc.fontSize(11).fillColor(C.text);
    for (const l of lines) {
      doc.text(l.name || 'Article', cols.name, y, { width: cols.qty - cols.name - 10 });
      const rowEnd = doc.y;
      doc.text(String(l.quantite), cols.qty, y, { width: 50, align: 'right' });
      doc.text(fmtMoney(l.prix), cols.price, y, { width: 70, align: 'right' });
      doc.text(fmtMoney(l.quantite * l.prix), cols.sum, y, { width: RIGHT - cols.sum, align: 'right' });
      y = Math.max(rowEnd, y + 16) + 6;
    }
    doc.y = y;

    doc.moveDown(0.5);
    rows(doc, [['Mode de paiement', paymentLabel(order.mode_paiement)]]);
    total(doc, 'Total payé', order.total);
    footer(doc, order.jeko_reference || order.transaction_id);
  });
}

module.exports = { buildReservationReceipt, buildOrderReceipt };
