const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const reportCtrl = require('../controllers/reportController');
const settingsCtrl = require('../controllers/settingsController');
const subscriptionCtrl = require('../controllers/subscriptionController');
const payoutCtrl = require('../controllers/payoutController');
const { authenticate, isAdmin } = require('../middleware/auth');

router.use(authenticate, isAdmin);

router.get('/users', ctrl.getUsers);
router.post('/users', ctrl.createUser);
router.put('/users/:id', ctrl.updateUser);
router.delete('/users/:id', ctrl.deleteUser);

router.get('/logs', ctrl.getLogs);
router.delete('/logs', ctrl.clearLogs);

router.get('/reviews', ctrl.getReviews);
router.patch('/reviews/:id/approve', ctrl.approveReview);
router.patch('/reviews/:id/reject', ctrl.rejectReview);

router.get('/reports', reportCtrl.get);
router.get('/settings', settingsCtrl.get);

router.get('/subscriptions', subscriptionCtrl.adminList);
router.post('/subscriptions/:id/payment', subscriptionCtrl.recordPayment);

router.get('/payouts', payoutCtrl.adminList);
router.post('/payouts/:userId', payoutCtrl.recordPayout);

module.exports = router;
