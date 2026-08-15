const HISTORY_KEY = "calc_history_v1";
const PICK_KEY = "calc_pick_expr_v1";

function loadHistory() {
  return wx.getStorageSync(HISTORY_KEY) || [];
}
function saveHistory(list) {
  wx.setStorageSync(HISTORY_KEY, list);
}

function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function parseTsFromId(id) {
  const p = (id || "").split("_")[0];
  const t = parseInt(p, 10);
  return Number.isFinite(t) ? t : Date.now();
}

Page({
  data: {
    groups: [],
    stats: { total: 0, latest: "-" }
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const list = loadHistory();
    console.log("HISTORY RAW:", list);

    // 兼容旧数据：没有 ts 的从 id 里解析
    const enriched = list.map((it) => {
      const ts = it.ts || parseTsFromId(it.id);
      const expr = it.expr || it.expression || it.formula || "";
      const res = it.res || it.result || it.value || "";
    
      return {
        id: it.id || `${ts}_legacy`,
        expr,
        res,
        ts,
        date: formatDate(ts),
        time: formatTime(ts)
      };
    });
    
    // 分组：date -> items
    const map = {};
    enriched.forEach((it) => {
      if (!map[it.date]) map[it.date] = [];
      map[it.date].push(it);
    });

    // 日期倒序、组内时间倒序
    const dates = Object.keys(map).sort((a, b) => (a < b ? 1 : -1));
    const groups = dates.map((date) => ({
      date,
      items: map[date].sort((a, b) => b.ts - a.ts)
    }));

    const latest = enriched.length ? enriched[0].res : "-";
    this.setData({
      groups,
      stats: { total: enriched.length, latest }
    });
  },

  onPick(e) {
    const expr = e.currentTarget.dataset.expr || "";
    if (!expr) return;

    wx.setStorageSync(PICK_KEY, expr);
    wx.switchTab({ url: "/pages/calculator/index" });
  },

  onDeleteOne(e) {
    console.log("DELETE DATASET:", e.currentTarget.dataset);
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    wx.showModal({
      title: "删除这条记录？",
      content: "删除后不可恢复",
      success: (res) => {
        if (!res.confirm) return;
        const list = loadHistory().filter((x) => x.id !== id);
        saveHistory(list);
        this.refresh();
      }
    });
  },

  onClearAll() {
    wx.showModal({
      title: "清空全部历史？",
      content: "清空后不可恢复",
      success: (res) => {
        if (!res.confirm) return;
        saveHistory([]);
        this.refresh();
      }
    });
  },

  goCalculator() {
    wx.switchTab({ url: "/pages/calculator/index" });
  }
});
