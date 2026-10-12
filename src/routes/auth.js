const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { login, register, me, logout, forgotPassword } = require('../controllers/authController');
const twoFaCtrl = require('../controllers/twoFaController');
const { authenticate } = require('../middleware/auth');
const { proofUpload }  = require('../middleware/upload');

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de tentatives, réessayez dans une minute.' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de tentatives, réessayez dans une minute.' },
});
const twoFaLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de tentatives, réessayez dans une minute.' },
});

router.post('/login', loginLimiter, login);
router.post('/register', registerLimiter, proofUpload.single('proof_document'), register);
router.post('/forgot-password', registerLimiter, forgotPassword);
router.get('/me', authenticate, me);
router.post('/logout', authenticate, logout);

router.get('/2fa/setup', authenticate, twoFaCtrl.setup);
router.post('/2fa/enable', authenticate, twoFaCtrl.enable);
router.post('/2fa/disable', authenticate, twoFaCtrl.disable);
router.post('/2fa/verify', twoFaLimiter, twoFaCtrl.verifyLogin);

module.exports = router;
