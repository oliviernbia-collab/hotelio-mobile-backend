const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.use(authenticate, isAdmin);

router.get('/users', ctrl.getUsers);
router.post('/users', ctrl.createUser);
router.put('/users/:id', ctrl.updateUser);
router.delete('/users/:id', ctrl.deleteUser);

router.get('/logs', ctrl.getLogs);
router.delete('/logs', ctrl.clearLogs);

router.patch('/reviews/:id/approve', ctrl.approveReview);
router.patch('/reviews/:id/reject', ctrl.rejectReview);

module.exports = router;
