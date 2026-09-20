const router  = require('express').Router();
const ctrl    = require('../controllers/boutiqueController');
const { authenticate } = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const uploadDir = path.join(__dirname, '../../../../storage/app/public/images/products');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 9)}${ext}`);
    },
  }),
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Seuls les fichiers JPG, PNG et WebP sont acceptés.'));
  },
});

function withUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'Image trop volumineuse — max 10 Mo.' });
    return res.status(400).json({ message: err.message || 'Erreur upload' });
  });
}

router.get('/products',          ctrl.getProducts);
router.get('/products/mine',     authenticate, ctrl.getMyProducts);
router.get('/products/:id',      ctrl.getProduct);
router.post('/products',         authenticate, withUpload, ctrl.createProduct);
router.put('/products/:id',      authenticate, withUpload, ctrl.updateProduct);
router.delete('/products/:id',   authenticate, ctrl.deleteProduct);
router.get('/cart',              authenticate, ctrl.getCart);
router.post('/cart/:id',         authenticate, ctrl.addToCart);
router.delete('/cart/:id',       authenticate, ctrl.removeFromCart);
router.post('/order',            authenticate, ctrl.placeOrder);
router.get('/my-orders',           authenticate, ctrl.myOrders);
router.get('/orders/:id/items',    authenticate, ctrl.getOrderItems);
router.patch('/orders/:id/cancel', authenticate, ctrl.cancelOrder);

module.exports = router;
