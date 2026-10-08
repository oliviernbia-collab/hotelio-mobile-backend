const router = require('express').Router();
const ctrl = require('../controllers/pointageController');
const { authenticate } = require('../middleware/auth');

router.get('/me',        authenticate, ctrl.me);
router.post('/check-in', authenticate, ctrl.checkIn);
router.post('/check-out',authenticate, ctrl.checkOut);
router.get('/report',    authenticate, ctrl.report);

module.exports = router;
