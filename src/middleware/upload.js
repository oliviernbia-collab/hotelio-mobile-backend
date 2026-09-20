const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

function makeStorage(subDir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../../src/uploads', subDir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${subDir.replace('/', '-')}-${Date.now()}${ext}`);
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
