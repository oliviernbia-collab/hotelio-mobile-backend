const router = require('express').Router();
const ctrl = require('../controllers/poolController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.index);
router.post('/', authenticate, ctrl.store);
router.put('/:id', authenticate, ctrl.update);
router.delete('/:id', authenticate, ctrl.destroy);

module.exports = router;
