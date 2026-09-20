const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT) || 3306,
  database: process.env.DB_DATABASE || 'db_hotelio',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+00:00',
  charset: 'utf8mb4',
});

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Connexion MySQL établie - db_hotelio');
    conn.release();
  } catch (err) {
    console.error('❌ Erreur de connexion MySQL:', err.message);
    process.exit(1);
  }
}

module.exports = { pool, testConnection };
