// pages/describe_tag/index.js
const accountStore = require("../../utils/describe-account.js");
const seedHistoryStore = require("../../utils/seed-history.js");

const STORAGE_KEY = "ZTJ_TAGS_V1";

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}
function pad3(n) {
  n = Number(n) || 0;
  if (n < 10) return "00" + n;
  if (n < 100) return "0" + n;
  return String(n);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtDateKey(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}
function fmtTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}
function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// 生成序号：YYYYMMDDHHmmss-xxx（当天第 xxx 个）
function makeAutoSeqNo() {
  const now = new Date();
  const ymd = fmtDateKey(now);
  const hh = pad2(now.getHours());
  const mm = pad2(now.getMinutes());
  const ss = pad2(now.getSeconds());

  const counterKey = `ZTJ_SEQ_COUNTER_${ymd}`;
  let n = Number(wx.getStorageSync(counterKey) || 0);
  n += 1;
  wx.setStorageSync(counterKey, n);

  return `${ymd}${hh}${mm}${ss}-${pad3(n)}`;
}

// 构建标签文本：带日期 + 时间点（保证跨天复制也清晰）
function buildTagText(fields, dateStr, timePoint) {
  const get = (key) => {
    const f = (fields || []).find((x) => x.key === key);
    return (f && String(f.value || "").trim()) || "未填";
  };

  const customLines = (fields || [])
    .filter((f) => String(f.key).startsWith("custom_"))
    .map((f) => `${f.label}:${String(f.value || "").trim() || "未填"}`);

  const passRateLine = (() => {
    const v = get("passRatePct");
    return v && v !== "未填" ? `质检合格率:${v}%` : null;
  })();

  return [
    `智种计｜序列名称:${get("seriesName")}｜序号:${get("seqNo")}`,
    `识别粒数:${get("recognizedCount")} 粒`,
    ...(passRateLine ? [passRateLine] : []),
    `日期:${dateStr}`,
    `时间点:${timePoint}`,
    `株高(cm):${get("plantHeight")}｜底荚高度(cm):${get("bottomPodHeight")}`,
    `分枝数:${get("branchCount")}｜主茎结数:${get("mainStemNodeCount")}`,
    `单株粒重(g):${get("singlePlantGrainWeight")}`,
    ...customLines
  ].join("\n");
}

function buildSummary(fields) {
  const val = (key) => {
    const f = (fields || []).find((x) => x.key === key);
    return (f && String(f.value || "").trim()) || "未填";
  };
  return {
    title: `${val("seriesName")} #${val("seqNo")}`,
    sub: `识别粒数:${val("recognizedCount")}  株高:${val("plantHeight")}  粒重:${val("singlePlantGrainWeight")}`
  };
}

Page({
  data: {
    isLoggedIn: false,
    accountName: "",
    // 表单字段
    fields: [
      { fid: "f_seriesName", key: "seriesName", label: "序列名称", value: "", required: true, deletable: false },
      { fid: "f_seqNo", key: "seqNo", label: "序号", value: "", required: true, deletable: false },
      { fid: "f_recognizedCount", key: "recognizedCount", label: "识别粒数", value: "", required: false, deletable: false },
      { fid: "f_passRatePct", key: "passRatePct", label: "质检合格率(%)", value: "", required: false, deletable: true },

      { fid: "f_plantHeight", key: "plantHeight", label: "株高(cm)", value: "", required: false, deletable: true },
      { fid: "f_bottomPodHeight", key: "bottomPodHeight", label: "底荚高度(cm)", value: "", required: false, deletable: true },
      { fid: "f_branchCount", key: "branchCount", label: "分枝数", value: "", required: false, deletable: true },
      { fid: "f_mainStemNodeCount", key: "mainStemNodeCount", label: "主茎结数", value: "", required: false, deletable: true },
      { fid: "f_singlePlantGrainWeight", key: "singlePlantGrainWeight", label: "单株粒重(g)", value: "", required: false, deletable: true }
    ],

    customLabel: "",
    tagText: "",

    // 列表
    tags: [],

    // 详情
    showDetail: false,
    detail: null,

    // 选择模式（后面可用于“部分生成报告/批量删除”）
    selectMode: false,
    selectedMap: {},
    selectedCount: 0,
    seedCountHistory: []
  },

  onLoad() {
    this.reloadTags();
  },

  onShow() {
    this.reloadTags();
  },

  reloadTags() {
    const auth = accountStore.getAuth();
    const raw = accountStore.readScoped(STORAGE_KEY, []);
    const { tags, changed } = this.normalizeTags(raw);
    if (changed && auth) accountStore.writeScoped(STORAGE_KEY, tags);
    this.setData({
      tags,
      isLoggedIn: !!auth,
      accountName: auth?.nickName || "",
      seedCountHistory: auth ? seedHistoryStore.listHistory() : []
    });
  },

  // 从籽粒称重历史记录中选择单株粒重
  chooseWeightFromHistory() {
    const WEIGHT_HISTORY_KEY = 'ZTJ_WEIGHT_HISTORY_V1';
    const list = wx.getStorageSync(WEIGHT_HISTORY_KEY) || [];
    if (!list.length) {
      wx.showToast({ title: '暂无称重记录，请先在籽粒称重页面获取数据', icon: 'none', duration: 2500 });
      return;
    }
    const items = list.slice(0, 15).map(r => `${r.value} ${r.unit}  （${r.time}）`);
    wx.showActionSheet({
      itemList: items,
      success: res => {
        const record = list[res.tapIndex];
        const fields = this.data.fields.map(f =>
          f.key === 'singlePlantGrainWeight' ? { ...f, value: record.value } : f
        );
        this.setData({ fields });
      }
    });
  },

  // 通用：从已保存标签中收集该字段的历史值供选择
  chooseFieldFromHistory(e) {
    const key = e.currentTarget.dataset.key;
    if (!accountStore.isLoggedIn()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }

    const seen = new Set();
    const items = [];
    for (const tag of (this.data.tags || [])) {
      const val = String(((tag.fields || []).find(f => f.key === key) || {}).value || '').trim();
      if (val && !seen.has(val)) {
        seen.add(val);
        items.push(val);
        if (items.length >= 10) break;
      }
    }

    if (!items.length) {
      wx.showToast({ title: '暂无历史值', icon: 'none' });
      return;
    }

    wx.showActionSheet({
      itemList: items,
      success: res => {
        const fields = this.data.fields.map(f =>
          f.key === key ? { ...f, value: items[res.tapIndex] } : f
        );
        this.setData({ fields });
      }
    });
  },

  // 从考种测量历史中选择（株高 / 底荚高度）
  chooseMeasureFromHistory(e) {
    const key = e.currentTarget.dataset.key;
    const typeMap = { plantHeight: '株高', bottomPodHeight: '底荚高度' };
    const targetType = typeMap[key];

    let raw = [];
    try { raw = wx.getStorageSync('ZTJ_MEASURE_HISTORY_V1') || []; } catch (_) {}

    const seen = new Set();
    const items = [];
    for (const entry of raw) {
      for (const r of (entry.results || [])) {
        if (!targetType || r.type === targetType) {
          const key2 = `${r.type}|${r.cm}`;
          if (!seen.has(key2)) {
            seen.add(key2);
            items.push({ label: `${r.type} ${r.cm}cm   ${entry.displayTime}`, value: r.cm });
            if (items.length >= 10) break;
          }
        }
      }
      if (items.length >= 10) break;
    }

    if (!items.length) {
      wx.showToast({ title: '暂无测量记录', icon: 'none' }); return;
    }

    wx.showActionSheet({
      itemList: items.map(i => i.label),
      success: res => {
        const fields = this.data.fields.map(f =>
          f.key === key ? { ...f, value: items[res.tapIndex].value } : f
        );
        this.setData({ fields });
      }
    });
  },

  choosePassRateFromHistory() {
    if (!accountStore.isLoggedIn()) {
      wx.showToast({ title: "请先登录后再选择", icon: "none" });
      return;
    }

    const list = (this.data.seedCountHistory || [])
      .filter((x) => x.passRatePct != null)
      .slice(0, 6);

    if (!list.length) {
      wx.showToast({ title: "暂无含合格率的历史记录", icon: "none" });
      return;
    }

    wx.showActionSheet({
      itemList: list.map((x) => `${x.passRatePct}%  ${x.qualityGrade || ''}  ${x.displayTime}`),
      success: (res) => {
        const picked = list[res.tapIndex];
        if (!picked) return;

        const fields = this.data.fields.map((f) => (
          f.key === "passRatePct" ? { ...f, value: String(picked.passRatePct) } : f
        ));
        this.setData({ fields });
      },
      fail: () => {
        wx.showToast({ title: "选择失败，请重试", icon: "none" });
      }
    });
  },

  chooseCountFromHistory() {
    if (!accountStore.isLoggedIn()) {
      wx.showToast({ title: "请先登录后再选择", icon: "none" });
      return;
    }

    const list = (this.data.seedCountHistory || []).slice(0, 6);
    if (!list.length) {
      wx.showToast({ title: "暂无识别历史", icon: "none" });
      return;
    }

    wx.showActionSheet({
      itemList: list.map((x) => `${x.totalCount}粒  ${x.displayTime}`),
      success: (res) => {
        const picked = list[res.tapIndex];
        if (!picked) return;

        const fields = this.data.fields.map((f) => (
          f.key === "recognizedCount" ? { ...f, value: String(picked.totalCount) } : f
        ));
        this.setData({ fields });
      },
      fail: () => {
        wx.showToast({ title: "选择失败，请重试", icon: "none" });
      }
    });
  },

  // 给旧数据补齐：createdAt / dateKey / dateStr / timePoint / displayTime
  normalizeTags(list) {
    let changed = false;

    const tags = (list || []).map((t) => {
      const createdAt = t.createdAt || Date.now();
      const d = new Date(createdAt);

      const dateKey = t.dateKey || fmtDateKey(d);
      const dateStr = t.dateStr || fmtDate(d);
      const timePoint = t.timePoint || fmtTime(d);
      const displayTime = t.displayTime || `${dateStr} ${timePoint}`;

      if (!t.createdAt || !t.dateKey || !t.dateStr || !t.timePoint || !t.displayTime) changed = true;

      return {
        ...t,
        createdAt,
        dateKey,
        dateStr,
        timePoint,
        displayTime
      };
    });

    // 新的在前
    tags.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { tags, changed };
  },

  onFieldInput(e) {
    const { key } = e.currentTarget.dataset;
    const value = e.detail.value;
    const fields = this.data.fields.map((f) => (f.key === key ? { ...f, value } : f));
    this.setData({ fields });
  },

  // 自动生成序号
  genSeqNo() {
    const seqNo = makeAutoSeqNo();
    const fields = this.data.fields.map((f) => (f.key === "seqNo" ? { ...f, value: seqNo } : f));
    this.setData({ fields });
    wx.showToast({ title: "已生成序号", icon: "success" });
  },

  removeField(e) {
    const { key } = e.currentTarget.dataset;
    const fields = this.data.fields.filter((f) => f.key !== key);
    this.setData({ fields });
  },

  onCustomLabelInput(e) {
    this.setData({ customLabel: e.detail.value });
  },

  addCustomField() {
    const label = String(this.data.customLabel || "").trim();
    if (!label) {
      wx.showToast({ title: "请输入字段名", icon: "none" });
      return;
    }

    const key = "custom_" + uid();
    const fid = "f_" + key;

    const fields = [
      ...this.data.fields,
      { fid, key, label, value: "", required: false, deletable: true }
    ];

    this.setData({ fields, customLabel: "" });
  },

  // 生成标签：保存记录（带日期与显示时间）
  genTag() {
    const fields = this.data.fields;

    // 必填校验：序列名称、序号
    const need = fields.filter((f) => f.required);
    for (const f of need) {
      if (!String(f.value || "").trim()) {
        wx.showToast({ title: `请填写${f.label}`, icon: "none" });
        return;
      }
    }

    const now = new Date();
    const dateKey = fmtDateKey(now);
    const dateStr = fmtDate(now);
    const timePoint = fmtTime(now);
    const displayTime = fmtDateTime(now);

    const summary = buildSummary(fields);
    const tagText = buildTagText(fields, dateStr, timePoint);

    if (!accountStore.isLoggedIn()) {
      this.setData({ tagText });
      wx.showToast({ title: "请先登录后再保存标签", icon: "none" });
      return;
    }

    const newTag = {
      id: uid(),
      createdAt: now.getTime(),

      dateKey,
      dateStr,
      timePoint,
      displayTime,

      fields: fields.map((f) => ({
        fid: f.fid,
        key: f.key,
        label: f.label,
        value: f.value
      })),

      tagText,
      summaryTitle: summary.title,
      summarySub: summary.sub
    };

    const tags = [newTag, ...(this.data.tags || [])];
  accountStore.writeScoped(STORAGE_KEY, tags);

    this.setData({ tagText, tags });
    wx.showToast({ title: "已生成并保存", icon: "success" });
  },

  copyTag() {
    if (!this.data.tagText) return;
    wx.setClipboardData({ data: this.data.tagText });
  },

  // 点击列表：选择模式=切换；普通=打开详情
  onTagTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;

    if (this.data.selectMode) {
      this.toggleById(id);
      return;
    }

    const tag = (this.data.tags || []).find((t) => t.id === id);
    if (!tag) return;

    this.setData({
      showDetail: true,
      detail: JSON.parse(JSON.stringify(tag))
    });
  },

  // 长按进入选择模式
  onTagLongPress(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;

    if (!this.data.selectMode) {
      const selectedMap = {};
      selectedMap[id] = true;
      this.setData({ selectMode: true, selectedMap, selectedCount: 1 });
      return;
    }

    // 已在选择模式：长按也当作切换
    this.toggleById(id);
  },

  // 点击 checkbox 容器（用 catchtap 防止触发行点击）
  onToggleSelect(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    this.toggleById(id);
  },

  toggleById(id) {
    const selectedMap = { ...(this.data.selectedMap || {}) };
    selectedMap[id] = !selectedMap[id];
    const selectedCount = Object.values(selectedMap).filter(Boolean).length;
    this.setData({ selectedMap, selectedCount });
  },

  exitSelectMode() {
    this.setData({ selectMode: false, selectedMap: {}, selectedCount: 0 });
  },

  selectAllTags() {
    const allSelected = this.data.selectedCount === this.data.tags.length;
    if (allSelected) {
      this.setData({ selectedMap: {}, selectedCount: 0 });
    } else {
      const selectedMap = {};
      (this.data.tags || []).forEach(t => { selectedMap[t.id] = true; });
      this.setData({ selectedMap, selectedCount: this.data.tags.length });
    }
  },

  batchDelete() {
    const ids = Object.keys(this.data.selectedMap || {}).filter((k) => this.data.selectedMap[k]);
    if (!ids.length) {
      wx.showToast({ title: "未选择任何记录", icon: "none" });
      return;
    }

    wx.showModal({
      title: "确认删除",
      content: `确定删除选中的 ${ids.length} 条标签吗？`,
      confirmText: "删除",
      confirmColor: "#E53935",
      success: (res) => {
        if (!res.confirm) return;

        const tags = (this.data.tags || []).filter((t) => !ids.includes(t.id));
        accountStore.writeScoped(STORAGE_KEY, tags);

        this.setData({ tags, selectMode: false, selectedMap: {}, selectedCount: 0 });
        wx.showToast({ title: "已删除", icon: "success" });
      }
    });
  },

  // 把已选标签 id 写入 report 页使用的 key，然后跳转
  goReportWithSelected() {
    const ids = Object.keys(this.data.selectedMap || {}).filter((k) => this.data.selectedMap[k]);
    if (!ids.length) {
      wx.showToast({ title: "未选择任何记录", icon: "none" });
      return;
    }
    accountStore.writeScoped("ZTJ_REPORT_SELECTED_IDS_V1", ids);

    this.setData({ selectMode: false, selectedMap: {}, selectedCount: 0 });
    wx.navigateTo({ url: "/pages/describe_report/index" });
  },

  // 详情弹窗
  closeDetail() {
    this.setData({ showDetail: false, detail: null });
  },

  onDetailInput(e) {
    const { fid } = e.currentTarget.dataset;
    const value = e.detail.value;

    const detail = this.data.detail;
    if (!detail) return;

    const fields = (detail.fields || []).map((f) => (f.fid === fid ? { ...f, value } : f));
    detail.fields = fields;

    const summary = buildSummary(fields);
    detail.summaryTitle = summary.title;
    detail.summarySub = summary.sub;

    const dateStr = detail.dateStr || (detail.createdAt ? fmtDate(new Date(detail.createdAt)) : fmtDate(new Date()));
    const timePoint = detail.timePoint || (detail.createdAt ? fmtTime(new Date(detail.createdAt)) : fmtTime(new Date()));
    detail.tagText = buildTagText(fields, dateStr, timePoint);

    this.setData({ detail });
  },

  copyDetailText() {
    const detail = this.data.detail;
    if (!detail) return;
    wx.setClipboardData({ data: detail.tagText });
  },

  saveDetail() {
    const detail = this.data.detail;
    if (!detail) return;

    const series = (detail.fields || []).find((f) => f.key === "seriesName")?.value;
    const seqNo = (detail.fields || []).find((f) => f.key === "seqNo")?.value;
    if (!String(series || "").trim() || !String(seqNo || "").trim()) {
      wx.showToast({ title: "序列名称/序号不能为空", icon: "none" });
      return;
    }

    const tags = (this.data.tags || []).map((t) => (t.id === detail.id ? detail : t));
  accountStore.writeScoped(STORAGE_KEY, tags);

    this.setData({ tags, showDetail: false, detail: null });
    wx.showToast({ title: "已保存", icon: "success" });
  },

  deleteOne() {
    const detail = this.data.detail;
    if (!detail) return;

    wx.showModal({
      title: "确认删除",
      content: "确定删除这条标签吗？",
      confirmText: "删除",
      confirmColor: "#E53935",
      success: (res) => {
        if (!res.confirm) return;

        const tags = (this.data.tags || []).filter((t) => t.id !== detail.id);
        accountStore.writeScoped(STORAGE_KEY, tags);

        this.setData({ tags, showDetail: false, detail: null });
        wx.showToast({ title: "已删除", icon: "success" });
      }
    });
  }
});
