const router = require('express').Router();
const ctrl = require('../controllers/reservationController');
const { authenticate } = require('../middleware/auth');

router.get('/',     authenticate, ctrl.index);
router.get('/mine', authenticate, ctrl.mine);
router.post('/',    authenticate, ctrl.store);
router.get('/:id',  authenticate, ctrl.show);
router.patch('/:id/status', authenticate, ctrl.updateStatus);
router.post('/:id/checkin', authenticate, ctrl.checkin);
router.post('/:id/checkout', authenticate, ctrl.checkout);
router.post('/:id/payment', authenticate, ctrl.processPayment);

module.exports = router;
