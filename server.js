const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
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
// Servir les images stockées par Laravel
app.use('/storage', express.static(path.join(__dirname, '../../public/storage')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'Hôtelio Mobile API', version: '1.0.0' }));
app.use('/api', routes);

app.use((req, res) => res.status(404).json({ message: 'Route introuvable' }));
app.use(errorHandler);

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
