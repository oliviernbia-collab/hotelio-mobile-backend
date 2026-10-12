const router = require('express').Router();

router.use('/auth', require('./auth'));
router.use('/hotels', require('./hotels'));
router.use('/rooms', require('./rooms'));
router.use('/reservations', require('./reservations'));
router.use('/clients', require('./clients'));
router.use('/staff', require('./staff'));
router.use('/menu', require('./menu'));
router.use('/orders', require('./orders'));
router.use('/expenses', require('./expenses'));
router.use('/pools', require('./pools'));
router.use('/tickets', require('./tickets'));
router.use('/facturations', require('./facturations'));
router.use('/notifications', require('./notifications'));
router.use('/boutique', require('./boutique'));
router.use('/profile', require('./profile'));
router.use('/dashboard', require('./dashboard'));
router.use('/favorites', require('./favorites'));
router.use('/admin', require('./admin'));
router.use('/services', require('./services'));
router.use('/pointage', require('./pointage'));
router.use('/subscriptions', require('./subscriptions'));

module.exports = router;
