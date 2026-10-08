const router = require('express').Router();
const ctrl = require('../controllers/roomController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.index);
router.get('/mine', authenticate, ctrl.mine);
router.get('/:id', authenticate, ctrl.show);
router.post('/', authenticate, ctrl.store);
router.put('/:id', authenticate, ctrl.update);
router.patch('/:id/status', authenticate, ctrl.updateStatus);
router.post('/:id/cleaned', authenticate, ctrl.markCleaned);
router.delete('/:id', authenticate, ctrl.destroy);

module.exports = router;
