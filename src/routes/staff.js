const router = require('express').Router();
const ctrl = require('../controllers/staffController');
const { authenticate } = require('../middleware/auth');

router.get('/',         authenticate, ctrl.index);
router.post('/',        authenticate, ctrl.store);
router.get('/me',       authenticate, ctrl.me);
router.get('/schedules', authenticate, ctrl.getSchedules);
router.post('/schedules', authenticate, ctrl.createSchedule);
router.get('/:id', authenticate, ctrl.show);
router.put('/:id', authenticate, ctrl.update);
router.delete('/:id', authenticate, ctrl.destroy);

module.exports = router;
