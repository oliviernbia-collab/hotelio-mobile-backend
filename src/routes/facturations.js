const router = require('express').Router();
const ctrl = require('../controllers/facturationController');
const { authenticate } = require('../middleware/auth');

router.get('/',               authenticate, ctrl.index);
router.post('/',              authenticate, ctrl.store);
router.get('/:id',            authenticate, ctrl.show);
router.put('/:id',            authenticate, ctrl.update);
router.patch('/:id/pay',      authenticate, ctrl.pay);
router.delete('/:id',         authenticate, ctrl.destroy);
router.get('/:id/download',   ctrl.download);

module.exports = router;
