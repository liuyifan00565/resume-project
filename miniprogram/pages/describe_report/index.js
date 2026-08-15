// pages/describe_report/index.js
const accountStore = require("../../utils/describe-account.js");

const TAGS_KEY = "ZTJ_TAGS_V1";
const SELECTED_IDS_KEY = "ZTJ_REPORT_SELECTED_IDS_V1"; // “部分导出”时写入（从标签页传来）

// ✅ 兼容不同导出结构：module.exports / exports.XLSX / exports.default
let XLSX_RAW = null;
let XLSX = null;

try {
  XLSX_RAW = require("../../utils/xlsx.full.min.js");
  XLSX =
    (XLSX_RAW && XLSX_RAW.utils) ? XLSX_RAW :
    (XLSX_RAW && XLSX_RAW.default && XLSX_RAW.default.utils) ? XLSX_RAW.default :
    (XLSX_RAW && XLSX_RAW.XLSX && XLSX_RAW.XLSX.utils) ? XLSX_RAW.XLSX :
    null;
} catch (e) {
  XLSX = null;
}

Page({
  data: {
    isLoggedIn: false,
    accountName: "",
    allTags: [],
    selectedIds: [],
    pickedTags: [],
    report: null,

    exportFilePath: "",
    exportFileName: "",
    exportFileType: "",

    // ✅ 样本明细多选删除
    selectionMode: false,
    selectedDetailIds: [],

    // ✅ 选择日期导出
    dateOptions: [],         // [{dateKey, dateStr}]
    pickedDateKey: "",       // YYYYMMDD 或 "ALL"
    pickedDateStr: ""        // YYYY-MM-DD 或 "全部"
  },

  onShow() {
    this.loadAndBuild();
  },

  // ========= 日期工具 =========
  pad2(n) { return (n < 10 ? "0" : "") + n; },

  fmtDate(d) {
    return `${d.getFullYear()}-${this.pad2(d.getMonth() + 1)}-${this.pad2(d.getDate())}`;
  },

  fmtDateKey(d) {
    return `${d.getFullYear()}${this.pad2(d.getMonth() + 1)}${this.pad2(d.getDate())}`;
  },

  fmtDateTime(d) {
    return `${this.fmtDate(d)} ${this.pad2(d.getHours())}:${this.pad2(d.getMinutes())}:${this.pad2(d.getSeconds())}`;
  },

  // ========= 字段读取工具 =========
  getField(tag, key) {
    const fields = tag?.fields || [];
    return fields.find(x => x.key === key);
  },

  getFieldText(tag, key, fallback = "未填") {
    const f = this.getField(tag, key);
    const s = (f && String(f.value ?? "").trim()) || "";
    return s || fallback;
  },

  getSeqNo(tag) {
    return this.getFieldText(tag, "seqNo", "");
  },

  // ========= 兼容旧数据：补 dateKey / dateStr / displayTime =========
  normalizeAllTags(allTags) {
    let changed = false;

    const fixed = (allTags || []).map(t => {
      if (!t) return t;

      const createdAt = t.createdAt || Date.now();
      const d = new Date(createdAt);

      const dateKey = t.dateKey || this.fmtDateKey(d);
      const dateStr = t.dateStr || this.fmtDate(d);
      const timePoint = t.timePoint || `${this.pad2(d.getHours())}:${this.pad2(d.getMinutes())}:${this.pad2(d.getSeconds())}`;
      const displayTime = t.displayTime || `${dateStr} ${timePoint}`;

      if (!t.createdAt || !t.dateKey || !t.dateStr || !t.displayTime || !t.timePoint) changed = true;

      return { ...t, createdAt, dateKey, dateStr, timePoint, displayTime };
    });

    // 新的在前
    fixed.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return { fixed, changed };
  },

  // ========= 读取标签 + 构建报告 =========
  loadAndBuild() {
    const auth = accountStore.getAuth();
    if (!auth) {
      this.setData({
        isLoggedIn: false,
        accountName: "",
        allTags: [],
        selectedIds: [],
        pickedTags: [],
        report: null,
        selectionMode: false,
        selectedDetailIds: [],
        dateOptions: [],
        pickedDateKey: "",
        pickedDateStr: ""
      });
      return;
    }

    let allTags = accountStore.readScoped(TAGS_KEY, []);
    const selectedIds = accountStore.readScoped(SELECTED_IDS_KEY, []);

    // 1) 兼容补齐
    const { fixed, changed } = this.normalizeAllTags(allTags);
    allTags = fixed;
    if (changed) accountStore.writeScoped(TAGS_KEY, allTags);

    // 2) 生成日期选项（按 dateKey 去重）
    const map = new Map(); // dateKey -> dateStr
    allTags.forEach(t => {
      if (t?.dateKey && t?.dateStr) map.set(t.dateKey, t.dateStr);
    });
    const dateOptions = Array.from(map.entries())
      .map(([dateKey, dateStr]) => ({ dateKey, dateStr }))
      .sort((a, b) => (b.dateKey > a.dateKey ? 1 : -1)); // 倒序

    // 3) 设置默认选中日期：优先今天；否则最近一天；否则 ALL
    const todayKey = this.fmtDateKey(new Date());
    let pickedDateKey = this.data.pickedDateKey || "";
    if (!pickedDateKey) {
      const hasToday = dateOptions.some(x => x.dateKey === todayKey);
      pickedDateKey = hasToday ? todayKey : (dateOptions[0]?.dateKey || "ALL");
    }

    // 4) 如果存在“部分导出”，日期筛选不生效（避免冲突）
    const hasSelected = Array.isArray(selectedIds) && selectedIds.length > 0;

    // 5) 按规则选取 pickedTags
    let pickedTags = allTags;

    if (hasSelected) {
      pickedTags = allTags.filter(t => selectedIds.includes(t.id));
    } else {
      if (pickedDateKey !== "ALL") {
        pickedTags = allTags.filter(t => t.dateKey === pickedDateKey);
      }
    }

    // 补展示字段（summaryTitle/summarySub）
    const normalized = pickedTags.map(t => this.normalizeTag(t));

    // 若处在多选模式，同步 _checked
    const selSet = new Set(this.data.selectedDetailIds || []);
    const normalizedWithChecked = normalized.map(t => ({ ...t, _checked: selSet.has(t.id) }));

    const pickedDateStr =
      hasSelected ? "已选记录" :
      (pickedDateKey === "ALL" ? "全部" : (dateOptions.find(x => x.dateKey === pickedDateKey)?.dateStr || ""));

    this.setData({
      isLoggedIn: true,
      accountName: auth.nickName || "",
      allTags,
      selectedIds,
      pickedTags: normalizedWithChecked,

      dateOptions,
      pickedDateKey,
      pickedDateStr
    });

    if (!normalizedWithChecked.length) {
      this.setData({ report: null });
      return;
    }

    // 生成报告时，用 pickedDateStr 做报告标题日期
    this.buildReport(normalizedWithChecked, pickedDateStr);
  },

  normalizeTag(tag) {
    const series = this.getFieldText(tag, "seriesName");
    const seq = this.getFieldText(tag, "seqNo");

    const summaryTitle = `${series} #${seq}`;
    const summarySub =
      `株高:${this.getFieldText(tag, "plantHeight")}  ` +
      `粒数:${this.getFieldText(tag, "grainCount")}  ` +
      `粒重:${this.getFieldText(tag, "singlePlantGrainWeight")}`;

    return { ...tag, summaryTitle, summarySub };
  },

  // ========= 统计汇总 =========
  buildReport(tags, dateStrLabel) {
    const stat = {}; // key -> { label, items:[{v, id, seq}] }

    // ✅ 隐藏“序列名称”
    const EXCLUDE_KEYS = new Set(["seriesName"]);
    const EXCLUDE_LABELS = new Set(["序列名称"]);

    tags.forEach(tag => {
      const seq = this.getSeqNo(tag);
      (tag.fields || []).forEach(f => {
        if (EXCLUDE_KEYS.has(f.key)) return;
        if (EXCLUDE_LABELS.has(f.label)) return;

        const v = Number(f.value);
        if (Number.isNaN(v)) return;

        if (!stat[f.key]) stat[f.key] = { label: f.label, items: [] };
        stat[f.key].items.push({ v, id: tag.id, seq });
      });
    });

    // 命中列表打包：把相同极值对应的 seq 聚合成 chip
    const pack = (hits) => {
      const map = {}; // seq -> Set(ids)
      hits.forEach(h => {
        if (!h.seq) return;
        if (!map[h.seq]) map[h.seq] = new Set();
        map[h.seq].add(h.id);
      });
      return Object.keys(map).map(seq => ({
        seq,
        idsStr: Array.from(map[seq]).join(",")
      }));
    };

    const summary = Object.keys(stat).map(k => {
      const items = stat[k].items || [];
      const values = items.map(x => x.v);
      const sum = values.reduce((a, b) => a + b, 0);

      const maxVal = values.length ? Math.max(...values) : 0;
      const minVal = values.length ? Math.min(...values) : 0;

      const maxHits = items.filter(x => x.v === maxVal);
      const minHits = items.filter(x => x.v === minVal);

      return {
        key: k,
        label: stat[k].label,
        avg: values.length ? (sum / values.length).toFixed(2) : "0.00",
        max: maxVal,
        min: minVal,

        expandMax: false,
        expandMin: false,

        maxSeqItems: pack(maxHits),
        minSeqItems: pack(minHits)
      };
    });

    this.setData({
      report: {
        date: dateStrLabel || "",
        count: tags.length,
        summary,
        tags
      }
    });
  },

  // ========= ✅ 选择日期导出 =========
  onPickDate() {
    const { selectedIds, dateOptions, pickedDateKey } = this.data;

    // 有“部分导出”时不允许选日期（避免冲突）
    if (Array.isArray(selectedIds) && selectedIds.length) {
      wx.showToast({ title: "当前为“已选记录”，请先清空选择", icon: "none" });
      return;
    }

    if (!dateOptions.length) {
      wx.showToast({ title: "暂无记录", icon: "none" });
      return;
    }

    const items = ["全部", ...dateOptions.map(x => x.dateStr)];
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const idx = res.tapIndex;
        const nextKey = idx === 0 ? "ALL" : dateOptions[idx - 1].dateKey;

        if (nextKey === pickedDateKey) return;

        this.setData({ pickedDateKey: nextKey }, () => this.loadAndBuild());
      }
    });
  },

  // ========= ✅ 统计汇总二段式交互 =========
  onTapExtremeNumber(e) {
    const key = e.currentTarget.dataset.key;   // 字段 key
    const type = e.currentTarget.dataset.type; // "max" / "min"
    const { report } = this.data;
    if (!report || !report.summary) return;

    const summary = report.summary.map(row => {
      if (row.key !== key) return row;
      if (type === "max") return { ...row, expandMax: !row.expandMax, expandMin: false };
      return { ...row, expandMin: !row.expandMin, expandMax: false };
    });

    this.setData({ report: { ...report, summary } });
  },

  onTapSeq(e) {
    const idsStr = e.currentTarget.dataset.ids || "";
    const label = e.currentTarget.dataset.label || "";
    const seq = e.currentTarget.dataset.seq || "";

    const ids = idsStr.split(",").map(s => s.trim()).filter(Boolean);
    const tags = this.data.report?.tags || [];
    const hitTags = ids.map(id => tags.find(t => t.id === id)).filter(Boolean);
    if (!hitTags.length) return;

    if (hitTags.length > 1) {
      const itemList = hitTags.map(t => t.summaryTitle || `#${seq}`);
      wx.showActionSheet({
        itemList,
        success: (res) => {
          const t = hitTags[res.tapIndex];
          if (t) this.openTagDetail(t, `${label} · #${seq}`);
        }
      });
      return;
    }

    this.openTagDetail(hitTags[0], `${label} · #${seq}`);
  },

  openTagDetail(tag, prefixLabel = "") {
    const title = prefixLabel ? `${prefixLabel}` : (tag.summaryTitle || "序列信息");
    const content =
      `序列：#${this.getSeqNo(tag) || "未记录"}\n` +
      `时间：${tag.displayTime || tag.timePoint || "未记录"}\n` +
      `${tag.summarySub || ""}`;

    wx.showModal({
      title,
      content,
      showCancel: false,
      confirmText: "知道了"
    });
  },

  // ========= ✅ 样本明细：长按多选删除 =========
  onLongPressRow(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    if (!this.data.selectionMode) this.setData({ selectionMode: true });
    this.togglePick(id);
  },

  onTapRow(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;

    if (this.data.selectionMode) {
      this.togglePick(id);
      return;
    }

    const t = (this.data.pickedTags || []).find(x => x.id === id);
    if (t) this.openTagDetail(t);
  },

  togglePick(id) {
    const selected = new Set(this.data.selectedDetailIds || []);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);

    const selectedDetailIds = Array.from(selected);
    const pickedTags = (this.data.pickedTags || []).map(t => ({
      ...t,
      _checked: selected.has(t.id)
    }));

    this.setData({ selectedDetailIds, pickedTags });
  },

  exitSelectMode() {
    const pickedTags = (this.data.pickedTags || []).map(t => ({ ...t, _checked: false }));
    this.setData({ selectionMode: false, selectedDetailIds: [], pickedTags });
  },

  deleteSelected() {
    const ids = this.data.selectedDetailIds || [];
    if (!ids.length) {
      wx.showToast({ title: "未选择样本", icon: "none" });
      return;
    }

    wx.showModal({
      title: "确认删除",
      content: `将删除已选 ${ids.length} 条样本（本地记录）。此操作不可恢复。`,
      confirmText: "删除",
      confirmColor: "#E53935",
      success: (res) => {
        if (!res.confirm) return;

        const allTags = accountStore.readScoped(TAGS_KEY, []);
        const remain = allTags.filter(t => !ids.includes(t.id));
        accountStore.writeScoped(TAGS_KEY, remain);

        const selectedIds = accountStore.readScoped(SELECTED_IDS_KEY, []);
        const selectedRemain = selectedIds.filter(x => !ids.includes(x));
        accountStore.writeScoped(SELECTED_IDS_KEY, selectedRemain);

        wx.showToast({ title: "已删除", icon: "success" });

        this.setData({ selectionMode: false, selectedDetailIds: [] });
        this.loadAndBuild();
      }
    });
  },

  // ========= 复制报告 =========
  copyReport() {
    const { report } = this.data;
    if (!report) return;

    const text = this.buildTXT(report);
    wx.setClipboardData({ data: text });
  },

  // ========= 导出：TXT =========
  async exportTXT() {
    const { report } = this.data;
    if (!report) return;

    const stamp = Date.now();
    const datePart = report.date || "未记录";
    const filename = `作业报告_${datePart}_${stamp}.txt`;
    const content = this.buildTXT(report);

    try {
      wx.showLoading({ title: "正在导出..." });
      const filePath = await this.writeTextFile(filename, content);
      wx.hideLoading();
      this.afterExport(filePath, filename, "txt");
    } catch (e) {
      wx.hideLoading();
      console.error("exportTXT fail:", e);
      wx.showToast({ title: "导出失败", icon: "none" });
    }
  },

  // ========= 导出：CSV =========
  async exportCSV() {
    const { report } = this.data;
    if (!report) return;

    const stamp = Date.now();
    const datePart = report.date || "未记录";
    const filename = `作业报告_${datePart}_${stamp}.csv`;
    const content = this.buildCSV(report);

    try {
      wx.showLoading({ title: "正在导出..." });
      const filePath = await this.writeTextFile(filename, content);
      wx.hideLoading();
      this.afterExport(filePath, filename, "csv");
    } catch (e) {
      wx.hideLoading();
      console.error("exportCSV fail:", e);
      wx.showToast({ title: "导出失败", icon: "none" });
    }
  },

  // ========= 导出：Excel =========
  async exportXLSX() {
    const { report } = this.data;
    if (!report) return;

    const stamp = Date.now();
    const datePart = report.date || "未记录";
    const filename = `作业报告_${datePart}_${stamp}.xlsx`;

    try {
      wx.showLoading({ title: "正在导出..." });

      const buffer = this.buildXLSXBuffer(report);
      const filePath = await this.writeBinaryFile(filename, buffer);

      wx.hideLoading();

      this.setData({ exportFilePath: filePath, exportFileName: filename, exportFileType: "xlsx" });

      wx.showToast({ title: "Excel已导出", icon: "success" });

      wx.showActionSheet({
        itemList: ["预览Excel", "发送文件到"],
        success: (res) => {
          if (res.tapIndex === 0) this.previewFile(filePath);
          if (res.tapIndex === 1) this.shareFile(filePath, filename);
        }
      });
    } catch (e) {
      wx.hideLoading();
      console.error("exportXLSX fail:", e);
      wx.showToast({ title: "导出失败", icon: "none" });
    }
  },

  // 导出后统一体验：弹“预览/发送”
  afterExport(filePath, filename, fileType) {
    this.setData({ exportFilePath: filePath, exportFileName: filename, exportFileType: fileType });

    wx.showToast({ title: "文件已导出", icon: "success" });

    // txt/csv 微信不支持 openDocument 预览，改为"复制内容"
    const isTxtLike = (fileType === "txt" || fileType === "csv");
    const canPreview = !isTxtLike && (fileType === "xlsx" || fileType === "xls" || fileType === "doc" || fileType === "docx" || fileType === "pdf");

    const itemList = [];
    if (isTxtLike) itemList.push("复制内容");
    if (canPreview) itemList.push("预览文件");
    itemList.push("发送文件到");

    wx.showActionSheet({
      itemList,
      success: (res) => {
        const pick = itemList[res.tapIndex];
        if (pick === "复制内容") this.copyFileContent(filePath);
        if (pick === "预览文件") this.previewFile(filePath);
        if (pick === "发送文件到") this.shareFile(filePath, filename);
      }
    });
  },

  copyFileContent(filePath) {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: "utf8",
      success: ({ data }) => {
        wx.setClipboardData({
          data,
          success: () => wx.showToast({ title: "已复制到剪贴板", icon: "success" })
        });
      },
      fail: () => wx.showToast({ title: "读取失败", icon: "none" })
    });
  },

  previewFile(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const typeMap = { xlsx: "xlsx", xls: "xls", pdf: "pdf", doc: "doc", docx: "docx" };
    wx.openDocument({
      filePath,
      fileType: typeMap[ext] || ext,
      showMenu: true,
      fail: () => wx.showToast({ title: "微信内预览失败，可发送文件", icon: "none" })
    });
  },

  shareFile(filePath, filename) {
    wx.shareFileMessage({ filePath, fileName: filename });
  },

  // ========= 生成 TXT / CSV =========
  buildTXT(report) {
    let text = `作业报告\n`;
    text += `作业日期：${report.date || "未记录"}\n`;
    text += `样本数量：${report.count}\n\n`;

    text += `统计汇总：\n`;
    (report.summary || []).forEach(s => {
      text += `${s.label}：平均 ${s.avg}，最大 ${s.max}，最小 ${s.min}\n`;
    });

    text += `\n样本明细：\n`;
    (report.tags || []).forEach((t, idx) => {
      text += `${idx + 1}. ${t.summaryTitle || ""}  ${t.displayTime || t.timePoint || ""}\n`;
      if (t.summarySub) text += `   ${t.summarySub}\n`;
    });

    return text;
  },

  buildCSV(report) {
    const keyMap = {};
    (report.tags || []).forEach(t => {
      (t.fields || []).forEach(f => { keyMap[f.key] = f.label || f.key; });
    });
    const keys = Object.keys(keyMap);

    const headers = ["序号", "日期时间", ...keys.map(k => keyMap[k])];

    const esc = (v) => {
      const s = v == null ? "" : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [];
    lines.push(headers.map(esc).join(","));

    (report.tags || []).forEach((t, i) => {
      const map = {};
      (t.fields || []).forEach(f => { map[f.key] = f.value; });

      const row = [i + 1, (t.displayTime || t.timePoint || "")];
      keys.forEach(k => row.push(map[k] ?? ""));
      lines.push(row.map(esc).join(","));
    });

    return lines.join("\n");
  },

  buildXLSXBuffer(report) {
    const sheet1 = [["字段", "平均", "最大", "最小"]];
    (report.summary || []).forEach(s => sheet1.push([s.label, s.avg, s.max, s.min]));

    const keyMap = {};
    (report.tags || []).forEach(t => {
      (t.fields || []).forEach(f => { keyMap[f.key] = f.label || f.key; });
    });
    const keys = Object.keys(keyMap);

    const header = ["序号", "日期时间", ...keys.map(k => keyMap[k])];
    const sheet2 = [header];

    (report.tags || []).forEach((t, i) => {
      const map = {};
      (t.fields || []).forEach(f => (map[f.key] = f.value));

      const row = [i + 1, (t.displayTime || t.timePoint || "")];
      keys.forEach(k => row.push(map[k] ?? ""));
      sheet2.push(row);
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet1), "统计汇总");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet2), "样本明细");

    return XLSX.write(wb, { type: "array", bookType: "xlsx" });
  },

  // ========= 写文件 =========
  writeTextFile(filename, content) {
    return new Promise((resolve, reject) => {
      const fs = wx.getFileSystemManager();
      const filePath = `${wx.env.USER_DATA_PATH}/${filename}`;
      fs.writeFile({
        filePath,
        data: content,
        encoding: "utf8",
        success: () => resolve(filePath),
        fail: reject
      });
    });
  },

  writeBinaryFile(filename, arrayBuffer) {
    const fs = wx.getFileSystemManager();
    const filePath = `${wx.env.USER_DATA_PATH}/${filename}`;
    return new Promise((resolve, reject) => {
      fs.writeFile({
        filePath,
        data: arrayBuffer,
        success: () => resolve(filePath),
        fail: reject
      });
    });
  },

  // 清空“部分选择”，回到按日期/全量模式
  clearPicked() {
    accountStore.removeScoped(SELECTED_IDS_KEY);
    wx.showToast({ title: "已清空选择", icon: "success" });
    this.loadAndBuild();
  }
});
