const router = require('express').Router();
const { index } = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, index);

module.exports = router;
