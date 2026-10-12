const router = require('express').Router();
const ctrl = require('../controllers/subscriptionController');
const { authenticate } = require('../middleware/auth');

router.get('/plans', ctrl.plans);
router.get('/mine', authenticate, ctrl.mine);
router.post('/pay', authenticate, ctrl.pay);
router.post('/choose', authenticate, ctrl.choose);

module.exports = router;
