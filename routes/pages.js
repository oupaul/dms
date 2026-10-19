/**
 * 靜態頁面與首頁。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { ensureEditorAccess } = require('../middleware/viewer');
const ROOT_DIR = path.join(__dirname, '..');

const router = express.Router();

// login.html 為公開頁（不需登入），同時相容 public/ 和根目錄兩種部署位置
router.get('/login.html', (req, res) => {
  const inPublic = path.join(ROOT_DIR, 'public', 'login.html');
  const inRoot   = path.join(ROOT_DIR, 'login.html');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err) {
      console.error('SendFile login.html error:', err);
      res.status(404).send('login.html not found');
    }
  });
});

// 共用主題樣式：與 login.html 相同，同時相容 public/ 與根目錄兩種部署位置（過去只有 public/ 有檔案時才找得到）
router.get('/megapower-theme.css', (req, res) => {
  const inPublic = path.join(ROOT_DIR, 'public', 'megapower-theme.css');
  const inRoot   = path.join(ROOT_DIR, 'megapower-theme.css');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('not found');
  });
});

router.get('/csv_generator.html', ensureEditorAccess, (req, res) => {
  const inPublic = path.join(ROOT_DIR, 'public', 'csv_generator.html');
  const inRoot   = path.join(ROOT_DIR, 'csv_generator.html');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'CSV Generator not found' });
    }
  });
});

router.get('/user_csv_generator.html', ensureEditorAccess, (req, res) => {
  const inPublic = path.join(ROOT_DIR, 'public', 'user_csv_generator.html');
  const inRoot   = path.join(ROOT_DIR, 'user_csv_generator.html');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'User CSV Generator not found' });
    }
  });
});

router.get('/permission_generator.html', ensureEditorAccess, (req, res) => {
  const inPublic = path.join(ROOT_DIR, 'public', 'permission_generator.html');
  const inRoot   = path.join(ROOT_DIR, 'permission_generator.html');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'Permission Generator not found' });
    }
  });
});

// 靜態檔案
router.use(express.static('public'));

// 首頁：同時相容 public/ 和根目錄兩種部署位置（同 /login.html 的做法）
function sendIndexHtml(req, res) {
  const inPublic = path.join(ROOT_DIR, 'public', 'index.html');
  const inRoot   = path.join(ROOT_DIR, 'index.html');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err) {
      console.error('SendFile index.html error:', err);
      res.status(404).json({ error: 'Index not found' });
    }
  });
}

router.get('/', (req, res) => {
  console.log('Hit / (root)');
  sendIndexHtml(req, res);
});

router.get('/index.html', (req, res) => {
  console.log('Hit /index.html');
  sendIndexHtml(req, res);
});

module.exports = router;
