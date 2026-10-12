const JEKO_BASE_URL = process.env.JEKO_BASE_URL || 'https://api.jeko.africa';

/**
 * Normalise un libellé de moyen de paiement (web ou mobile) vers le code
 * attendu par l'API Jèko. Retourne null pour un moyen non géré par Jèko
 * (Espèces, Virement) — ces paiements restent confirmés manuellement.
 */
function mapPaymentMethod(method) {
  if (!method) return null;
  const m = String(method).toLowerCase();
  if (m.includes('orange')) return 'orange';
  if (m.includes('wave')) return 'wave';
  if (m.includes('mtn')) return 'mtn';
  if (m.includes('moov')) return 'moov';
  if (m.includes('djamo')) return 'djamo';
  return null;
}

async function createPaymentRequest(data) {
  const res = await fetch(`${JEKO_BASE_URL}/partner_api/payment_requests`, {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.JEKO_API_KEY,
      'X-API-KEY-ID': process.env.JEKO_API_KEY_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function getPaymentRequest(id) {
  const res = await fetch(`${JEKO_BASE_URL}/partner_api/payment_requests/${id}`, {
    headers: {
      'X-API-KEY': process.env.JEKO_API_KEY,
      'X-API-KEY-ID': process.env.JEKO_API_KEY_ID,
    },
  });
  return res.json();
}

// Crée un contact bénéficiaire (mobile money ou bancaire) pour les virements sortants.
async function createContact(data) {
  const res = await fetch(`${JEKO_BASE_URL}/partner_api/contacts`, {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.JEKO_API_KEY,
      'X-API-KEY-ID': process.env.JEKO_API_KEY_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  return res.json();
}

async function deleteContact(contactId) {
  await fetch(`${JEKO_BASE_URL}/partner_api/contacts/${contactId}`, {
    method: 'DELETE',
    headers: {
      'X-API-KEY': process.env.JEKO_API_KEY,
      'X-API-KEY-ID': process.env.JEKO_API_KEY_ID,
    },
  }).catch(() => {});
}

module.exports = { mapPaymentMethod, createPaymentRequest, getPaymentRequest, createContact, deleteContact };
