var accountStore = require("../../utils/describe-account.js");
var STORAGE_KEY = "ZTJ_CORRECTIONS_V1";

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function fmtTimePoint(d) {
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtDate(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function uid() {
  return Date.now() + "_" + Math.random().toString(16).slice(2);
}

function toNum(v) {
  var s = String(v === undefined || v === null ? "" : v).trim();
  if (!s) return 0;
  var n = Number(s);
  return isFinite(n) ? n : 0;
}

function buildText(rec) {
  var lines = [];
  lines.push("智种计｜误检纠偏记录");
  lines.push("日期:" + rec.date + "  时间点:" + rec.timePoint);
  lines.push("样本:" + rec.sampleName);
  lines.push("原始计数:" + rec.raw);
  lines.push("漏检(+):" + rec.missed + "  误检(-):" + rec.falsePositive);
  lines.push("重复(-):" + rec.duplicate + "  杂质(-):" + rec.impurity);
  lines.push("纠偏后计数:" + rec.corrected + "（净变化:" + rec.deltaText + "，变化比例:" + rec.rateText + "）");
  lines.push("备注:" + (rec.note ? rec.note : "无"));
  return lines.join("\n");
}

function analyze(raw, missed, fp, dup, imp) {
  var corrected = raw - fp - dup - imp + missed;
  if (corrected < 0) corrected = 0;

  var delta = corrected - raw;
  var rate = raw === 0 ? 0 : (delta / raw) * 100;

  var deltaText = (delta >= 0 ? "+" : "") + delta;
  var rateText = (rate >= 0 ? "+" : "") + rate.toFixed(2) + "%";

  var absRate = Math.abs(rate);
  var levelText = "变动较小";
  var levelClass = "levelLow";
  var advice = "纠偏幅度较小，通常说明模型结果较稳定。";

  if (absRate >= 5 && absRate < 15) {
    levelText = "变动中等";
    levelClass = "levelMid";
    advice = "建议检查拍摄条件/重叠情况，必要时增加抽样或复核边缘区域。";
  } else if (absRate >= 15) {
    levelText = "变动较大";
    levelClass = "levelHigh";
    advice = "纠偏幅度较大，建议复核该批次：背景、光照、重叠、杂质、阈值设置等。";
  }

  return {
    corrected: corrected,
    deltaText: deltaText,
    rateText: rateText,
    levelText: levelText,
    levelClass: levelClass,
    advice: advice
  };
}

Page({
  data: {
    isLoggedIn: false,
    accountName: "",
    sampleName: "",
    rawCount: "",
    missed: "",
    falsePositive: "",
    duplicate: "",
    impurity: "",
    note: "",

    result: null,
    records: [],

    showDetail: false,
    detail: null
  },

  onLoad: function () {
    this.reloadRecords();
  },

  onShow: function () {
    this.reloadRecords();
  },

  reloadRecords: function () {
    var auth = accountStore.getAuth();
    var records = accountStore.readScoped(STORAGE_KEY, []);
    this.setData({
      records: records || [],
      isLoggedIn: !!auth,
      accountName: auth && auth.nickName ? auth.nickName : ""
    });
  },

  onSampleNameInput: function (e) { this.setData({ sampleName: e.detail.value }); },
  onRawInput: function (e) { this.setData({ rawCount: e.detail.value, result: null }); },
  onMissedInput: function (e) { this.setData({ missed: e.detail.value, result: null }); },
  onFpInput: function (e) { this.setData({ falsePositive: e.detail.value, result: null }); },
  onDupInput: function (e) { this.setData({ duplicate: e.detail.value, result: null }); },
  onImpInput: function (e) { this.setData({ impurity: e.detail.value, result: null }); },
  onNoteInput: function (e) { this.setData({ note: e.detail.value }); },

  calc: function () {
    var raw = toNum(this.data.rawCount);
    if (raw <= 0) {
      wx.showToast({ title: "请填写原始计数（>0）", icon: "none" });
      return;
    }

    var missed = toNum(this.data.missed);
    var fp = toNum(this.data.falsePositive);
    var dup = toNum(this.data.duplicate);
    var imp = toNum(this.data.impurity);

    var result = analyze(raw, missed, fp, dup, imp);
    this.setData({ result: result });
  },

  _buildRecord: function (now, result) {
    var sampleName = String(this.data.sampleName || "").trim();
    if (!sampleName) sampleName = "未命名样本";

    var raw = toNum(this.data.rawCount);
    var missed = toNum(this.data.missed);
    var fp = toNum(this.data.falsePositive);
    var dup = toNum(this.data.duplicate);
    var imp = toNum(this.data.impurity);
    var note = String(this.data.note || "").trim();

    var rec = {
      id: uid(),
      createdAt: now.getTime(),
      date: fmtDate(now),
      timePoint: fmtTimePoint(now),
      sampleName: sampleName,

      raw: raw,
      missed: missed,
      falsePositive: fp,
      duplicate: dup,
      impurity: imp,

      corrected: result.corrected,
      deltaText: result.deltaText,
      rateText: result.rateText,

      note: note
    };

    rec.text = buildText(rec);
    return rec;
  },

  copyPreview: function () {
    if (!this.data.result) return;
    var now = new Date();
    var rec = this._buildRecord(now, this.data.result);
    wx.setClipboardData({ data: rec.text });
  },

  saveRecord: function () {
    if (!this.data.result) {
      wx.showToast({ title: "请先计算纠偏结果", icon: "none" });
      return;
    }

    if (!accountStore.isLoggedIn()) {
      wx.showToast({ title: "请先登录后再保存纠偏记录", icon: "none" });
      return;
    }

    var now = new Date();
    var rec = this._buildRecord(now, this.data.result);

    var records = this.data.records.slice(0);
    records.unshift(rec);

    accountStore.writeScoped(STORAGE_KEY, records);

    this.setData({
      records: records,
      rawCount: "",
      missed: "",
      falsePositive: "",
      duplicate: "",
      impurity: "",
      note: "",
      result: null
    });

    wx.showToast({ title: "已保存", icon: "success" });
  },

  openDetail: function (e) {
    var id = e.currentTarget.dataset.id;
    var records = this.data.records;
    var rec = null;

    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id) { rec = records[i]; break; }
    }
    if (!rec) return;

    // 深拷贝（避免直接改列表）
    var detail = JSON.parse(JSON.stringify(rec));
    this.setData({ showDetail: true, detail: detail });
  },

  closeDetail: function () {
    this.setData({ showDetail: false, detail: null });
  },

  _recalcDetail: function (detail) {
    var raw = toNum(detail.raw);
    var missed = toNum(detail.missed);
    var fp = toNum(detail.falsePositive);
    var dup = toNum(detail.duplicate);
    var imp = toNum(detail.impurity);

    var res = analyze(raw, missed, fp, dup, imp);

    detail.corrected = res.corrected;
    detail.deltaText = res.deltaText;
    detail.rateText = res.rateText;
    detail.text = buildText(detail);

    return detail;
  },

  onDetailName: function (e) {
    var detail = this.data.detail;
    detail.sampleName = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },
  onDetailRaw: function (e) {
    var detail = this.data.detail;
    detail.raw = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },
  onDetailMissed: function (e) {
    var detail = this.data.detail;
    detail.missed = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },
  onDetailFp: function (e) {
    var detail = this.data.detail;
    detail.falsePositive = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },
  onDetailDup: function (e) {
    var detail = this.data.detail;
    detail.duplicate = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },
  onDetailImp: function (e) {
    var detail = this.data.detail;
    detail.impurity = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },
  onDetailNote: function (e) {
    var detail = this.data.detail;
    detail.note = e.detail.value;
    this.setData({ detail: this._recalcDetail(detail) });
  },

  copyDetail: function () {
    var detail = this.data.detail;
    if (!detail) return;
    wx.setClipboardData({ data: detail.text || "" });
  },

  saveDetail: function () {
    var detail = this.data.detail;
    if (!detail) return;

    var raw = toNum(detail.raw);
    if (raw <= 0) {
      wx.showToast({ title: "原始计数需 > 0", icon: "none" });
      return;
    }

    var records = this.data.records.slice(0);
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === detail.id) {
        records[i] = detail;
        break;
      }
    }

    accountStore.writeScoped(STORAGE_KEY, records);
    this.setData({ records: records, showDetail: false, detail: null });
    wx.showToast({ title: "已保存", icon: "success" });
  },

  deleteOne: function () {
    var detail = this.data.detail;
    if (!detail) return;

    var that = this;
    wx.showModal({
      title: "确认删除",
      content: "确定删除这条纠偏记录吗？",
      success: function (res) {
        if (!res.confirm) return;

        var records = that.data.records.slice(0);
        var kept = [];
        for (var i = 0; i < records.length; i++) {
          if (records[i].id !== detail.id) kept.push(records[i]);
        }

        accountStore.writeScoped(STORAGE_KEY, kept);
        that.setData({ records: kept, showDetail: false, detail: null });
        wx.showToast({ title: "已删除", icon: "success" });
      }
    });
  }
});
