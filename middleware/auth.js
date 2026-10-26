/**
 * 認證／角色檢查中介軟體。
 */

// ==================== 認證中介軟體 ====================

// 檢查是否已登入
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: 'unauthorized', message: '請先登入' });
  }
}

// 檢查是否為管理員
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'forbidden', message: '需要管理員權限' });
  }
}

// 檢查是否有邀請發送權限（admin 或 can_invite=1）
function requireCanInvite(req, res, next) {
  if (req.session && req.session.userId && (req.session.role === 'admin' || req.session.canInvite)) {
    next();
  } else {
    res.status(403).json({ error: 'forbidden', message: '您沒有發送邀請連結的權限' });
  }
}

// 客戶端帳號（db_admin / client_user）：權限異動申請單的提出方
function isClientRoleSession(req) {
  const roleLevel = req.session && req.session.roleLevel;
  return roleLevel === 'db_admin' || roleLevel === 'client_user';
}

// 非客戶端帳號（engineer / user / admin）：權限異動申請單的審核方
function requireStaffRole(req, res, next) {
  if (req.session && req.session.userId && !isClientRoleSession(req)) {
    next();
  } else {
    res.status(403).json({ error: 'forbidden', message: '需要工程師或管理員權限' });
  }
}

module.exports = {
  isClientRoleSession,
  requireAdmin,
  requireAuth,
  requireCanInvite,
  requireStaffRole,
};
