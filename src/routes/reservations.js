const router = require('express').Router();
const ctrl = require('../controllers/reservationController');
const { authenticate } = require('../middleware/auth');

router.get('/',     authenticate, ctrl.index);
router.get('/mine', authenticate, ctrl.mine);
router.post('/',    authenticate, ctrl.store);
router.get('/:id',  authenticate, ctrl.show);
router.patch('/:id/status', authenticate, ctrl.updateStatus);
// Même route que l'API web : annulation = passage au statut 'annulée' (remboursement compris).
router.post('/:id/cancel', authenticate, (req, res) => {
  req.body = { status: 'annulée' };
  return ctrl.updateStatus(req, res);
});
router.post('/:id/checkin', authenticate, ctrl.checkin);
router.post('/:id/checkout', authenticate, ctrl.checkout);
router.post('/:id/payment', authenticate, ctrl.processPayment);
router.post('/:id/payment/verify', authenticate, ctrl.verifyPayment);
router.get('/:id/receipt-token', authenticate, ctrl.receiptToken);
router.get('/:id/receipt', ctrl.receipt); // authentifié par le jeton de téléchargement

module.exports = router;
