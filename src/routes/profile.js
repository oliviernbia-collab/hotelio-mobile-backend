const router = require('express').Router();
const ctrl   = require('../controllers/profileController');
const { authenticate } = require('../middleware/auth');
const { avatarUpload } = require('../middleware/upload');

router.get('/',         authenticate, ctrl.show);
router.put('/',         authenticate, ctrl.update);
router.put('/password', authenticate, ctrl.changePassword);
router.post('/avatar',  authenticate, avatarUpload.single('avatar'), ctrl.uploadAvatar);
router.put('/payout',   authenticate, ctrl.updatePayout);
router.delete('/',      authenticate, ctrl.deactivate);

module.exports = router;
