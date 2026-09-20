const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

function parseProduct(p) {
  return {
    ...p,
    image_url: p.image ? `${APP_URL}/storage/${p.image}` : null,
  };
}

/* Envoie une notification in-app à un utilisateur */
async function notifyUser(userId, type, title, body, extra = {}) {
  try {
    const notifId = uuidv4();
    await pool.query(
      `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at)
       VALUES (?, ?, 'App\\\\Models\\\\User', ?, ?, NOW())`,
      [notifId, type, userId, JSON.stringify({ title, body, ...extra })]
    );
  } catch (e) {
    console.error('Notification error:', e);
  }
}

async function getProducts(req, res) {
  const { category, search } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (search)   { sql += ' AND name LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY name';
  const [rows] = await pool.query(sql, params);
  res.json(rows.map(parseProduct));
}

async function getMyProducts(req, res) {
  const [rows] = await pool.query(
    'SELECT * FROM products WHERE user_id = ? ORDER BY name',
    [req.user.id]
  );
  res.json(rows.map(parseProduct));
}

async function createProduct(req, res) {
  const { name, price, stock, category, emoji, description } = req.body;
  if (!name || price === undefined) return res.status(422).json({ message: 'Nom et prix requis' });
  const imagePath = req.file ? `images/products/${req.file.filename}` : null;
  const [result] = await pool.query(
    'INSERT INTO products (user_id, name, price, stock, category, emoji, description, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, name, Number(price), Number(stock) || 0, category || null, emoji || null, description || null, imagePath]
  );
  const [newProduct] = await pool.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
  res.status(201).json(parseProduct(newProduct[0]));
}

async function updateProduct(req, res) {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Produit introuvable' });
  if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Non autorisé' });
  }
  const fields = ['name', 'price', 'stock', 'category', 'emoji', 'description'];
  const updates = [];
  const params  = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  });
  if (req.file) {
    updates.push('image = ?');
    params.push(`images/products/${req.file.filename}`);
  }
  if (!updates.length) return res.status(422).json({ message: 'Aucune donnée' });
  params.push(req.params.id);
  await pool.query(`UPDATE products SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
  const [updated] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  res.json(parseProduct(updated[0]));
}

async function deleteProduct(req, res) {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Produit introuvable' });
  if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Non autorisé' });
  }
  await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
  res.json({ message: 'Produit supprimé' });
}

async function getProduct(req, res) {
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Produit introuvable' });
  res.json(parseProduct(rows[0]));
}

async function getCart(req, res) {
  const [rows] = await pool.query(
    `SELECT lc.*, p.name, p.price as unit_price, p.emoji, p.image
     FROM ligne_commandes lc
     JOIN products p ON lc.product_id = p.id
     JOIN commandes c ON lc.commande_id = c.id
     WHERE c.user_id = ? AND c.statut = 'en_attente'`,
    [req.user.id]
  );
  const total = rows.reduce((sum, item) => sum + item.prix * item.quantite, 0);
  res.json({ items: rows, total });
}

async function addToCart(req, res) {
  const { quantite, quantity } = req.body;
  const qty = Number(quantite || quantity || 1);
  const [product] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product.length) return res.status(404).json({ message: 'Produit introuvable' });
  if (product[0].stock < qty) return res.status(422).json({ message: 'Stock insuffisant' });

  let [panier] = await pool.query("SELECT id FROM commandes WHERE user_id = ? AND statut = 'en_attente' LIMIT 1", [req.user.id]);
  let commandeId;
  if (!panier.length) {
    const [res2] = await pool.query("INSERT INTO commandes (user_id, total, statut) VALUES (?, 0, 'en_attente')", [req.user.id]);
    commandeId = res2.insertId;
  } else {
    commandeId = panier[0].id;
  }

  const [existing] = await pool.query('SELECT id, quantite FROM ligne_commandes WHERE commande_id = ? AND product_id = ?', [commandeId, req.params.id]);
  if (existing.length) {
    await pool.query('UPDATE ligne_commandes SET quantite = quantite + ? WHERE id = ?', [qty, existing[0].id]);
  } else {
    await pool.query('INSERT INTO ligne_commandes (commande_id, product_id, quantite, prix) VALUES (?, ?, ?, ?)', [commandeId, req.params.id, qty, product[0].price]);
  }

  const [total] = await pool.query('SELECT SUM(quantite * prix) as total FROM ligne_commandes WHERE commande_id = ?', [commandeId]);
  await pool.query('UPDATE commandes SET total = ? WHERE id = ?', [total[0].total || 0, commandeId]);

  res.json({ message: 'Produit ajouté au panier' });
}

async function removeFromCart(req, res) {
  const [panier] = await pool.query("SELECT id FROM commandes WHERE user_id = ? AND statut = 'en_attente' LIMIT 1", [req.user.id]);
  if (!panier.length) return res.status(404).json({ message: 'Panier introuvable' });
  await pool.query('DELETE FROM ligne_commandes WHERE commande_id = ? AND product_id = ?', [panier[0].id, req.params.id]);
  const [total] = await pool.query('SELECT SUM(quantite * prix) as total FROM ligne_commandes WHERE commande_id = ?', [panier[0].id]);
  await pool.query('UPDATE commandes SET total = ? WHERE id = ?', [total[0].total || 0, panier[0].id]);
  res.json({ message: 'Produit retiré du panier' });
}

async function placeOrder(req, res) {
  const { mode_paiement } = req.body;
  const [panier] = await pool.query("SELECT * FROM commandes WHERE user_id = ? AND statut = 'en_attente' LIMIT 1", [req.user.id]);
  if (!panier.length) return res.status(404).json({ message: 'Panier vide' });
  const [items] = await pool.query('SELECT * FROM ligne_commandes WHERE commande_id = ?', [panier[0].id]);
  if (!items.length) return res.status(422).json({ message: 'Panier vide' });

  // Confirmer la commande
  await pool.query(
    "UPDATE commandes SET statut = 'confirmée', mode_paiement = ?, updated_at = NOW() WHERE id = ?",
    [mode_paiement, panier[0].id]
  );

  // Décrémenter les stocks
  for (const item of items) {
    await pool.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantite, item.product_id]);
  }

  // ── Notifier le(s) prestataire(s) propriétaires des produits ──────────────
  const productIds = items.map(i => i.product_id);
  const [products] = await pool.query(
    'SELECT id, name, emoji, price, user_id FROM products WHERE id IN (?)',
    [productIds]
  );
  const [buyerRows] = await pool.query('SELECT name FROM users WHERE id = ?', [req.user.id]);
  const buyerName = buyerRows[0]?.name ?? 'Un client';

  // Regrouper par prestataire
  const byPrestataire = {};
  for (const prod of products) {
    if (!prod.user_id) continue;
    if (!byPrestataire[prod.user_id]) byPrestataire[prod.user_id] = [];
    const ordered = items.find(i => i.product_id === prod.id);
    byPrestataire[prod.user_id].push({
      name: prod.name,
      emoji: prod.emoji ?? '📦',
      qty:  ordered?.quantite ?? 1,
      prix: ordered?.prix ?? prod.price,
    });
  }

  for (const [userId, orderItems] of Object.entries(byPrestataire)) {
    const summary = orderItems.map(i => `${i.emoji} ${i.name} ×${i.qty}`).join(', ');
    const total   = orderItems.reduce((s, i) => s + i.prix * i.qty, 0);
    await notifyUser(
      Number(userId),
      'order_placed',
      '🛍️ Nouvelle commande !',
      `${buyerName} a commandé : ${summary}. Total : ${Number(total).toLocaleString()} FCFA`,
      { order_id: panier[0].id, items: orderItems }
    );
  }

  res.json({ message: 'Commande confirmée', commande_id: panier[0].id });
}

async function myOrders(req, res) {
  const [rows] = await pool.query(
    "SELECT c.*, (SELECT COUNT(*) FROM ligne_commandes lc WHERE lc.commande_id = c.id) as nb_items FROM commandes c WHERE c.user_id = ? AND c.statut != 'en_attente' ORDER BY c.created_at DESC",
    [req.user.id]
  );
  res.json(rows);
}

async function getOrderItems(req, res) {
  const orderId = req.params.id;

  // Vérifier l'accès : propriétaire de la commande OU prestataire avec produits dedans OU admin
  const [orderRows] = await pool.query('SELECT * FROM commandes WHERE id = ?', [orderId]);
  if (!orderRows.length) return res.status(404).json({ message: 'Commande introuvable' });
  const order = orderRows[0];

  if (order.user_id !== req.user.id && req.user.role !== 'admin') {
    const [owned] = await pool.query(
      `SELECT lc.id FROM ligne_commandes lc
       JOIN products p ON lc.product_id = p.id
       WHERE lc.commande_id = ? AND p.user_id = ? LIMIT 1`,
      [orderId, req.user.id]
    );
    if (!owned.length) return res.status(403).json({ message: 'Non autorisé' });
  }

  const [items] = await pool.query(
    `SELECT lc.id, lc.product_id, lc.quantite, lc.prix,
            (lc.quantite * lc.prix) AS sous_total,
            p.name, p.emoji, p.category, p.image
     FROM ligne_commandes lc
     JOIN products p ON lc.product_id = p.id
     WHERE lc.commande_id = ?`,
    [orderId]
  );

  res.json(items.map(item => ({
    ...item,
    image_url: item.image ? `${APP_URL}/storage/${item.image}` : null,
  })));
}

async function cancelOrder(req, res) {
  const [rows] = await pool.query('SELECT * FROM commandes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ message: 'Commande introuvable' });
  const order = rows[0];
  if (!['confirmée', 'en_cours'].includes(order.statut)) {
    return res.status(422).json({ message: 'Cette commande ne peut plus être annulée.' });
  }

  // Récupérer les articles avec info prestataire
  const [items] = await pool.query(
    `SELECT lc.quantite, lc.product_id,
            p.name, p.emoji, p.user_id AS prestataire_id
     FROM ligne_commandes lc
     JOIN products p ON lc.product_id = p.id
     WHERE lc.commande_id = ?`,
    [order.id]
  );

  // Réinitialiser les stocks
  for (const item of items) {
    await pool.query('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantite, item.product_id]);
  }
  await pool.query("UPDATE commandes SET statut = 'annulée', updated_at = NOW() WHERE id = ?", [order.id]);

  // ── Notifier les prestataires de l'annulation ─────────────────────────────
  const [buyerRows] = await pool.query('SELECT name FROM users WHERE id = ?', [req.user.id]);
  const buyerName = buyerRows[0]?.name ?? 'Un client';

  const byPrestataire = {};
  for (const item of items) {
    if (!item.prestataire_id) continue;
    if (!byPrestataire[item.prestataire_id]) byPrestataire[item.prestataire_id] = [];
    byPrestataire[item.prestataire_id].push(item);
  }

  for (const [userId, cancelledItems] of Object.entries(byPrestataire)) {
    const summary = cancelledItems.map(i => `${i.emoji ?? '📦'} ${i.name} ×${i.quantite}`).join(', ');
    await notifyUser(
      Number(userId),
      'order_cancelled',
      '❌ Commande annulée',
      `${buyerName} a annulé sa commande. Articles remis en stock : ${summary}`,
      { order_id: order.id }
    );
  }

  res.json({ message: 'Commande annulée' });
}

module.exports = {
  getProducts, getProduct, getMyProducts,
  createProduct, updateProduct, deleteProduct,
  getCart, addToCart, removeFromCart,
  placeOrder, myOrders, getOrderItems, cancelOrder,
};
