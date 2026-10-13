const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
require('express-async-errors'); // patche express pour transmettre les rejets de promesses à errorHandler au lieu de planter le process
const cors = require('cors');
const { testConnection } = require('./src/config/database');
const routes = require('./src/routes/index');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// L'app mobile native (Expo Go / build) n'est pas soumise à CORS — cette restriction
// protège uniquement un éventuel build web (react-native-web). ALLOWED_ORIGINS accepte
// une liste séparée par des virgules ; à défaut, seules les origines de dev sont acceptées.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:19006,http://192.168.100.4:8081,http://192.168.100.4:19006,exp://192.168.100.4:8081,exp://192.168.100.4:19006')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Le port du bundler Expo/Metro peut varier (8081 déjà pris, tunnel, etc.), donc en plus
// de la liste explicite on autorise tout port sur localhost et sur l'IP LAN du poste de dev.
const devOriginPattern = /^(https?|exp):\/\/(localhost|127\.0\.0\.1|192\.168\.100\.4):\d+$/;

app.use(cors({
  origin: (origin, callback) => {
    // Pas d'en-tête Origin (app native, curl, Postman...) → toujours autorisé.
    if (!origin || allowedOrigins.includes(origin) || devOriginPattern.test(origin)) {
      return callback(null, true);
    }
    console.warn(`⚠️  CORS: origine refusée: ${origin}`);
    callback(new Error('Origin non autorisée par CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'src/uploads')));
// Servir les images stockées par Laravel (webPHP/public/storage, depuis la réorganisation en monorepo)
app.use('/storage', express.static(path.join(__dirname, '../webPHP/public/storage')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'Hôtelio Mobile API', version: '1.0.0' }));

// Page-relais pour successUrl/errorUrl Jèko : l'utilisateur revient ici depuis le
// navigateur système après son paiement. La confirmation définitive vient normalement
// du webhook Jèko (voir JekoWebhookController@handle côté web) — mais celui-ci ne peut
// pas nous joindre si ce serveur n'est pas accessible publiquement (ex. développement
// local). En filet de sécurité, on demande donc ici au backend web de revérifier
// directement auprès de Jèko et de confirmer le paiement si le webhook n'est pas
// encore arrivé (voir JekoWebhookController::syncPayment).
const WEBPHP_URL = process.env.WEBPHP_URL || 'http://localhost:8000';

app.get('/payment/bridge', async (req, res) => {
  const ok = req.query.result !== 'error';
  let synced = null;

  if (ok && req.query.ref && process.env.JEKO_INTERNAL_SYNC_KEY) {
    try {
      const syncRes = await fetch(`${WEBPHP_URL}/api/internal/jeko/sync-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': process.env.JEKO_INTERNAL_SYNC_KEY,
        },
        body: JSON.stringify({ reference: req.query.ref }),
      });
      const data = await syncRes.json();
      synced = !!data.synced;
    } catch (e) {
      console.error('⚠️  /payment/bridge : échec de la vérification de secours auprès de Jèko:', e.message);
    }
  }

  const title = !ok
    ? '⚠️ Paiement annulé ou échoué'
    : synced === false
      ? '⏳ Paiement en cours de confirmation'
      : '✅ Paiement terminé';

  const message = !ok
    ? "Vous pouvez maintenant revenir sur l'application Hôtelio."
    : synced === false
      ? "Le paiement est en cours de vérification — ça ne devrait prendre que quelques instants. Revenez sur l'application et actualisez dans un moment."
      : "Vous pouvez maintenant revenir sur l'application Hôtelio.";

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Hôtelio</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:48px 20px;background:#F8F9FA;color:#2C3E50;">
      <h2>${title}</h2>
      <p>${message}</p>
    </body></html>`);
});

app.use('/api', routes);

app.use((req, res) => res.status(404).json({ message: 'Route introuvable' }));
app.use(errorHandler);

// Filet de sécurité pour les erreurs survenant hors du cycle requête/réponse
// (ex. tâche de fond, timer). Les erreurs des routes sont déjà gérées par
// express-async-errors + errorHandler et ne devraient jamais arriver ici.
process.on('unhandledRejection', (err) => {
  console.error('❌ Promesse rejetée non gérée:', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Exception non interceptée:', err);
});

async function bootstrap() {
  await testConnection();
  const server = app.listen(PORT, HOST, () => {
    console.log(`🚀 Hôtelio Mobile API démarré sur http://${HOST}:${PORT}`);
    console.log(`📡 Accessible depuis le réseau: http://192.168.100.4:${PORT}`);
    console.log(`📡 Base de données: ${process.env.DB_DATABASE}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Le port ${PORT} est déjà utilisé. Changez PORT dans .env ou arrêtez l'autre processus.`);
    } else {
      console.error('❌ Erreur serveur:', err.message);
    }
    process.exit(1);
  });
}

bootstrap();
