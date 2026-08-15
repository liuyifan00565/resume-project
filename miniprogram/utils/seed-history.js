const accountStore = require("./describe-account.js");

const SEED_HISTORY_KEY = "ZTJ_SEED_COUNT_HISTORY_V1";
const MAX_HISTORY = 500;

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDateTime(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function normalizeItem(item) {
  const createdAt = Number(item?.createdAt) || Date.now();
  const totalCount = Number(item?.totalCount) || 0;
  const target = Number(item?.target) || 0;
  const diff = Number(item?.diff);

  const base = {
    id: item?.id || `${createdAt}_${Math.random().toString(16).slice(2)}`,
    createdAt,
    displayTime: item?.displayTime || formatDateTime(createdAt),
    source: item?.source || "unknown",
    totalCount,
    manualPoints: Number(item?.manualPoints) || 0,
    target,
    diff: Number.isFinite(diff) ? diff : target - totalCount
  };

  // 质检字段（可选）
  if (item?.qualityGrade) {
    base.qualityGrade  = item.qualityGrade;
    base.passRatePct   = Number(item.passRatePct)  || 0;
    base.normalCount   = Number(item.normalCount)   || 0;
    base.defectSummary = item.defectSummary || '';
    // 英文 CSS 类名（避免中文字符做选择器）
    const gradeMap = { '一级': 'grade-1', '二级': 'grade-2', '三级': 'grade-3' };
    base.gradeClass = gradeMap[item.qualityGrade] || 'grade-2';
  }

  return base;
}

function listHistory() {
  const raw = accountStore.readScoped(SEED_HISTORY_KEY, []);
  const list = (raw || []).map(normalizeItem).sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

function addHistory(payload) {
  if (!accountStore.isLoggedIn()) return null;

  const createdAt = Date.now();
  const record = normalizeItem({
    id: `${createdAt}_${Math.random().toString(16).slice(2, 8)}`,
    createdAt,
    displayTime: formatDateTime(createdAt),
    source: payload?.source || "unknown",
    totalCount: payload?.totalCount,
    manualPoints: payload?.manualPoints,
    target: payload?.target,
    diff: payload?.diff,
    // 质检字段透传
    qualityGrade:  payload?.qualityGrade,
    passRatePct:   payload?.passRatePct,
    normalCount:   payload?.normalCount,
    defectSummary: payload?.defectSummary
  });

  const list = [record, ...listHistory()].slice(0, MAX_HISTORY);
  const ok = accountStore.writeScoped(SEED_HISTORY_KEY, list);
  return ok ? record : null;
}

function updateHistoryById(id, updates) {
  if (!accountStore.isLoggedIn() || !id) return false;
  const gradeMap = { '一级': 'grade-1', '二级': 'grade-2', '三级': 'grade-3' };
  const list = listHistory().map(x => {
    if (x.id !== id) return x;
    const merged = { ...x, ...updates };
    if (merged.qualityGrade) merged.gradeClass = gradeMap[merged.qualityGrade] || 'grade-2';
    return merged;
  });
  return accountStore.writeScoped(SEED_HISTORY_KEY, list);
}

function deleteHistoryById(id) {
  if (!accountStore.isLoggedIn()) return false;
  const next = listHistory().filter((x) => x.id !== id);
  return accountStore.writeScoped(SEED_HISTORY_KEY, next);
}

function clearHistory() {
  if (!accountStore.isLoggedIn()) return false;
  return accountStore.writeScoped(SEED_HISTORY_KEY, []);
}

module.exports = {
  SEED_HISTORY_KEY,
  listHistory,
  addHistory,
  updateHistoryById,
  deleteHistoryById,
  clearHistory
};
