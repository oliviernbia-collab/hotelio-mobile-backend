const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

function makeStorage(subDir) {
  return new CloudinaryStorage({
    cloudinary,
    params: {
      folder: `hotelio/${subDir}`,
      resource_type: 'auto',
    },
  });
}

const ALLOWED_PROOF = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];

const proofUpload = multer({
  storage: makeStorage('proofs'),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_PROOF.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Seuls les fichiers PDF et images (JPG, PNG) sont acceptés.'));
  },
});

const avatarUpload = multer({
  storage: makeStorage('avatars'),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Seuls les fichiers JPG, PNG et WebP sont acceptés.'));
  },
});

module.exports = { proofUpload, avatarUpload };
