/**
 * 檔案上傳（multer）設定。
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { UPLOAD_DIR } = require('../lib/config');

// multer 上傳處理（所有需要 file upload 的端點共用）
// 上傳限制：單檔 10MB、只收 Excel / CSV；無論成功或失敗，回應結束後一律刪除暫存檔
const UPLOAD_ALLOWED_EXT = new Set(['.xlsx', '.csv']);

const uploadRaw = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(Buffer.from(file.originalname || '', 'latin1').toString('utf8')).toLowerCase();
    if (!UPLOAD_ALLOWED_EXT.has(ext)) return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    cb(null, true);
  }
});

const upload = {
  single(field) {
    const handler = uploadRaw.single(field);
    return (req, res, next) => {
      res.on('close', () => {
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
      });
      handler(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '檔案過大，上限 10MB' });
        if (err.message === 'UNSUPPORTED_FILE_TYPE') return res.status(400).json({ error: '僅支援 .xlsx 或 .csv 檔案' });
        console.error('Upload error:', err);
        return res.status(400).json({ error: '檔案上傳失敗' });
      });
    };
  }
};

module.exports = {
  upload,
};
