const router  = require('express').Router();
const ctrl    = require('../controllers/hotelController');
const { authenticate } = require('../middleware/auth');
const multer  = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const upload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: { folder: 'hotelio/hotels' },
  }),
  limits:     { fileSize: 15 * 1024 * 1024 },   // 15 Mo
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Seuls les fichiers JPG, PNG et WebP sont acceptés.'));
  },
});

// Wrapper qui transforme les erreurs multer en réponse JSON
function withUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Image trop volumineuse — max 15 Mo.' });
    }
    return res.status(400).json({ message: err.message || 'Erreur upload' });
  });
}

router.get('/',       ctrl.index);
router.get('/mine',   authenticate, ctrl.mine);
router.get('/:id',    ctrl.show);
router.post('/',      authenticate, withUpload, ctrl.store);
router.put('/:id',    authenticate, withUpload, ctrl.update);
router.delete('/:id', authenticate, ctrl.destroy);
router.post('/:id/reviews',  authenticate, ctrl.addReview);
router.post('/:id/favorite', authenticate, ctrl.toggleFavorite);

module.exports = router;
