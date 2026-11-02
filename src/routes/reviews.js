const router = require('express').Router();
const { deleteReview } = require('../controllers/hotelController');
const { authenticate } = require('../middleware/auth');

// Même chemin que l'API web : DELETE /api/reviews/{review}
router.delete('/:id', authenticate, deleteReview);

module.exports = router;
