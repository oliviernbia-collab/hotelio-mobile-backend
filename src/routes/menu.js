const router = require('express').Router();
const ctrl = require('../controllers/menuController');
const { authenticate, isPrestataire } = require('../middleware/auth');

router.get('/',       authenticate,               ctrl.index);
router.post('/',      authenticate, isPrestataire, ctrl.store);
router.put('/:id',    authenticate, isPrestataire, ctrl.update);
router.delete('/:id', authenticate, isPrestataire, ctrl.destroy);

module.exports = router;
