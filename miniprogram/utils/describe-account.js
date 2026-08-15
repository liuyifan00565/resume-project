const AUTH_STORAGE_KEY = "ZTJ_DESCRIBE_AUTH_V1";
const USER_STORAGE_PREFIX = "ZTJ_DESCRIBE_USER";

function cloneFallback(fallback) {
  if (Array.isArray(fallback)) return fallback.slice();
  if (fallback && typeof fallback === "object") return { ...fallback };
  return fallback;
}

function getAuth() {
  const auth = wx.getStorageSync(AUTH_STORAGE_KEY);
  if (!auth || !auth.userId) return null;
  return auth;
}

function saveAuth(payload) {
  const auth = {
    userId: payload.userId,
    nickName: payload.nickName || "微信用户",
    avatarUrl: payload.avatarUrl || "",
    phoneNumber: payload.phoneNumber || "",
    loginAt: payload.loginAt || Date.now()
  };

  wx.setStorageSync(AUTH_STORAGE_KEY, auth);
  return auth;
}

function clearAuth() {
  wx.removeStorageSync(AUTH_STORAGE_KEY);
}

function isLoggedIn() {
  return !!getAuth();
}

function buildScopedKey(baseKey, userId) {
  return `${USER_STORAGE_PREFIX}_${userId}_${baseKey}`;
}

function getScopedKey(baseKey) {
  const auth = getAuth();
  if (!auth || !auth.userId) return "";
  return buildScopedKey(baseKey, auth.userId);
}

function readScoped(baseKey, fallback) {
  const key = getScopedKey(baseKey);
  if (!key) return cloneFallback(fallback);

  const value = wx.getStorageSync(key);
  if (value === "" || value === undefined || value === null) {
    return cloneFallback(fallback);
  }

  return value;
}

function writeScoped(baseKey, value) {
  const key = getScopedKey(baseKey);
  if (!key) return false;
  wx.setStorageSync(key, value);
  return true;
}

function removeScoped(baseKey) {
  const key = getScopedKey(baseKey);
  if (!key) return false;
  wx.removeStorageSync(key);
  return true;
}

function getHistoryStats() {
  return {
    tags: readScoped("ZTJ_TAGS_V1", []).length,
    corrections: readScoped("ZTJ_CORRECTIONS_V1", []).length,
    seedCounts: readScoped("ZTJ_SEED_COUNT_HISTORY_V1", []).length
  };
}

module.exports = {
  AUTH_STORAGE_KEY,
  getAuth,
  saveAuth,
  clearAuth,
  isLoggedIn,
  getScopedKey,
  readScoped,
  writeScoped,
  removeScoped,
  getHistoryStats
};