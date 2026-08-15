function uid() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const accountStore = require("../../utils/describe-account.js");

function round(x, k = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(k);
}

Page({
  data: {
    isLoggedIn: false,
    accountName: "",
    metricName: "抽样值",
    unit: "",
    targetRSE: "10", // %
    samples: [
      { id: uid(), value: "" },
      { id: uid(), value: "" },
      { id: uid(), value: "" }
    ],
    result: null,
    showImport: false,
    importFields: [],
    importKey: ""
  },

  onMetricNameInput(e) {
    this.setData({ metricName: e.detail.value });
  },

  onShow() {
    const auth = accountStore.getAuth();
    this.setData({
      isLoggedIn: !!auth,
      accountName: auth?.nickName || ""
    });
  },
  onUnitInput(e) {
    this.setData({ unit: e.detail.value });
  },
  onTargetRSEInput(e) {
    this.setData({ targetRSE: e.detail.value });
  },

  addSample() {
    this.setData({ samples: [...this.data.samples, { id: uid(), value: "" }] });
  },

  removeSample(e) {
    const { id } = e.currentTarget.dataset;
    const samples = this.data.samples.filter(s => s.id !== id);
    this.setData({ samples, result: null });
  },

  onSampleInput(e) {
    const { id } = e.currentTarget.dataset;
    const v = e.detail.value;
    const samples = this.data.samples.map(s => (s.id === id ? { ...s, value: v } : s));
    this.setData({ samples, result: null });
  },

  clearAll() {
    this.setData({
      samples: [{ id: uid(), value: "" }, { id: uid(), value: "" }, { id: uid(), value: "" }],
      result: null
    });
  },

  fillDemo() {
    // 示例：可以体现“稳定/不稳定”差异
    const demo = [102, 98, 101, 97, 104, 99];
    this.setData({
      samples: demo.map(x => ({ id: uid(), value: String(x) })),
      result: null
    });
  },
// 和“生成标签”页同一个存储 key
STORAGE_KEY: "ZTJ_TAGS_V1",

openImport() {
  if (!accountStore.isLoggedIn()) {
    wx.showToast({ title: "请先登录后再导入标签历史", icon: "none" });
    return;
  }

  const tags = accountStore.readScoped(this.STORAGE_KEY, []);

  // 先构建“可选字段列表”：默认字段 + 自定义字段
  const base = [
    { key: "plantHeight", label: "株高(cm)", hint: "从每条标签的 株高 导入" },
    { key: "bottomPodHeight", label: "底荚高度(cm)", hint: "从每条标签的 底荚高度 导入" },
    { key: "branchCount", label: "分枝数", hint: "从每条标签的 分枝数 导入" },
    { key: "mainStemNodeCount", label: "主茎结数", hint: "从每条标签的 主茎结数 导入" },
    { key: "grainCount", label: "粒数", hint: "从每条标签的 粒数 导入" },
    { key: "singlePlantGrainWeight", label: "单株粒重(g)", hint: "从每条标签的 单株粒重 导入" }
  ];

  // 自定义字段：扫描所有 tag.fields 里 key 以 custom_ 开头的
  const customMap = new Map();
  for (const t of tags) {
    const fs = (t && t.fields) || [];
    for (const f of fs) {
      if (f && typeof f.key === "string" && f.key.startsWith("custom_")) {
        if (!customMap.has(f.key)) {
          customMap.set(f.key, {
            key: f.key,
            label: f.label || "自定义字段",
            hint: "从自定义字段导入（仅提取数值）"
          });
        }
      }
    }
  }

  const importFields = [...base, ...Array.from(customMap.values())];
  const importKey = importFields.length ? importFields[0].key : "";

  this.setData({ showImport: true, importFields, importKey });
},

closeImport() {
  this.setData({ showImport: false });
},

pickImportKey(e) {
  const { key } = e.currentTarget.dataset;
  this.setData({ importKey: key });
},
doImport() {
  const key = this.data.importKey;
  if (!key) {
    wx.showToast({ title: "没有可导入字段", icon: "none" });
    return;
  }

  const tags = accountStore.readScoped(this.STORAGE_KEY, []);

  // 从 tags 提取字段数值
  const values = [];
  for (const t of tags) {
    const fs = (t && t.fields) || [];
    const f = fs.find(x => x && x.key === key);
    if (!f) continue;

    const s = String(f.value ?? "").trim();
    if (!s) continue;

    // 只提取数值（允许 "12.3" / "12" / "12g" 这种，自动取前面的数）
    const m = s.match(/-?\d+(\.\d+)?/);
    if (!m) continue;

    const num = Number(m[0]);
    if (Number.isFinite(num)) values.push(num);
  }

  if (values.length < 2) {
    this.setData({ showImport: false });
    wx.showToast({ title: "有效数值不足 2 条（无法计算）", icon: "none" });
    return;
  }

  // 更新为 samples
  const samples = values.map(v => ({ id: uid(), value: String(v) }));

  // 同步指标名称/单位（根据 key 友好设置）
  const mapMeta = {
    plantHeight: { metricName: "株高", unit: "cm" },
    bottomPodHeight: { metricName: "底荚高度", unit: "cm" },
    branchCount: { metricName: "分枝数", unit: "" },
    mainStemNodeCount: { metricName: "主茎结数", unit: "" },
    grainCount: { metricName: "粒数", unit: "粒" },
    singlePlantGrainWeight: { metricName: "单株粒重", unit: "g" }
  };

  const meta = mapMeta[key];

  this.setData({
    samples,
    result: null,
    showImport: false,
    metricName: meta ? meta.metricName : this.data.metricName,
    unit: meta ? meta.unit : this.data.unit
  });

  wx.showToast({ title: `已导入 ${values.length} 条`, icon: "success" });
},

  calc() {
    const raw = this.data.samples
      .map(s => String(s.value || "").trim())
      .filter(x => x !== "")
      .map(x => Number(x))
      .filter(x => Number.isFinite(x));

    if (raw.length < 2) {
      wx.showToast({ title: "至少输入 2 条有效数据", icon: "none" });
      return;
    }

    const n = raw.length;
    const mean = raw.reduce((a, b) => a + b, 0) / n;

    // 样本方差（n-1）
    let ss = 0;
    for (const x of raw) ss += (x - mean) * (x - mean);
    const variance = ss / (n - 1);
    const std = Math.sqrt(variance);

    const cv = mean === 0 ? Infinity : (std / Math.abs(mean)) * 100; // %
    const se = std / Math.sqrt(n);
    const rse = mean === 0 ? Infinity : (se / Math.abs(mean)) * 100; // %

    // 目标RSE
    let target = Number(String(this.data.targetRSE || "").trim());
    if (!Number.isFinite(target) || target <= 0) target = 10;

    // 估算需要的总样本量：RSE ≈ CV / sqrt(n)  => n_need ≈ (CV/target)^2
    const nNeed = Math.ceil(Math.pow(cv / target, 2));
    const needMore = Math.max(0, nNeed - n);

    // 分级（基于 RSE）
    let levelText = "高可信";
    let levelClass = "levelHigh";
    let advice = `结果较稳定，通常无需继续抽样（目标RSE≤${target}%）。`;

    if (rse > target && rse <= target * 1.8) {
      levelText = "中等可信";
      levelClass = "levelMid";
      advice = `波动略大，建议再抽样以降低不确定性（当前RSE≈${round(rse)}%）。`;
    } else if (rse > target * 1.8) {
      levelText = "低可信";
      levelClass = "levelLow";
      advice = `波动较大，建议增加抽样次数或检查抽样一致性（当前RSE≈${round(rse)}%）。`;
    }

    this.setData({
      result: {
        n,
        mean: round(mean, 2),
        var: round(variance, 2),
        std: round(std, 2),
        cv: round(cv, 2),
        rse: round(rse, 2),
        nNeed: Number.isFinite(nNeed) ? nNeed : "—",
        needMore: Number.isFinite(needMore) ? needMore : 0,
        levelText,
        levelClass,
        advice
      }
    });
  }
});
