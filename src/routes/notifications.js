const router = require('express').Router();
const ctrl = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.index);
router.delete('/', authenticate, ctrl.destroyAll);
router.patch('/read-all', authenticate, ctrl.markAllRead);
router.patch('/:id/read', authenticate, ctrl.markRead);
router.delete('/:id', authenticate, ctrl.destroy);

module.exports = router;
