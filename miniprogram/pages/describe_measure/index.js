// pages/describe_measure/index.js
// 考种测量：参考物校准 → 缩放精准点击 → 测量株高/穗长/茎节长/分蘖高

const HISTORY_KEY = 'ZTJ_MEASURE_HISTORY_V1';

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function uid() { return `${Date.now()}_${Math.random().toString(16).slice(2)}`; }

Page({
  data: {
    step: 0,
    photoPath: '',
    imgW: 0,
    imgH: 0,

    // 视图变换（不影响测量坐标）
    imageScale: 1,
    translateX: 0,
    translateY: 0,
    zoomPct: 100,

    // 校准（原始图像坐标）
    calibPoints: [],
    calibLine: null,
    calibRealCm: '10',
    pixelsPerCm: 0,

    // 当前测量（原始图像坐标）
    measureType: '株高',
    measureTypes: ['株高', '底荚高度', '穗长', '茎节长', '分蘖高'],
    defaultTypeCount: 5,
    customTypeInput: '',
    currentPoints: [],
    currentLine: null,

    // 本次测量结果
    results: [],

    // 历史记录
    measureHistory: [],
  },

  // 手势状态（非响应式，不放 data）
  _ts: null,
  _wrapRect: null,

  onLoad() { this.loadHistory(); },
  onShow() { this.loadHistory(); },

  loadHistory() {
    try {
      const raw = wx.getStorageSync(HISTORY_KEY) || [];
      this.setData({ measureHistory: Array.isArray(raw) ? raw : [] });
    } catch (e) {}
  },

  // ===================== 选图 =====================
  selectPhoto() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album'],
      success: res => this.setData({ photoPath: res.tempFiles[0].tempFilePath, step: 1 }),
    });
  },

  takePhoto() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera'],
      success: res => this.setData({ photoPath: res.tempFiles[0].tempFilePath, step: 1 }),
    });
  },

  onImgLoad(e) {
    const { width, height } = e.detail;
    wx.createSelectorQuery().select('.photo-wrap').boundingClientRect(rect => {
      if (!rect) return;
      this.setData({ imgW: rect.width, imgH: height * (rect.width / width) });
    }).exec();
  },

  // ===================== 手势处理 =====================
  onTouchStart(e) {
    // 缓存容器位置，供 move / end 同步使用
    wx.createSelectorQuery().select('.photo-wrap').boundingClientRect(r => {
      this._wrapRect = r;
    }).exec();

    const ts = e.touches;
    if (ts.length === 1) {
      this._ts = {
        mode: 'pending',
        x0: ts[0].clientX, y0: ts[0].clientY,
        lx: ts[0].clientX, ly: ts[0].clientY,
      };
    } else if (ts.length === 2) {
      const dx = ts[1].clientX - ts[0].clientX;
      const dy = ts[1].clientY - ts[0].clientY;
      this._ts = {
        mode: 'pinch',
        d0: Math.sqrt(dx * dx + dy * dy),
        s0: this.data.imageScale,
        tx0: this.data.translateX,
        ty0: this.data.translateY,
        cx: (ts[0].clientX + ts[1].clientX) / 2,
        cy: (ts[0].clientY + ts[1].clientY) / 2,
      };
    }
  },

  onTouchMove(e) {
    const g = this._ts;
    if (!g) return;

    if (g.mode === 'pinch' && e.touches.length === 2) {
      const t = e.touches;
      const dx = t[1].clientX - t[0].clientX;
      const dy = t[1].clientY - t[0].clientY;
      const newScale = Math.max(1, Math.min(8, g.s0 * Math.sqrt(dx * dx + dy * dy) / g.d0));
      const rect = this._wrapRect;
      if (!rect) return;

      // 以捏合中心为缩放枢轴
      const pivX = g.cx - rect.left;
      const pivY = g.cy - rect.top;
      const ratio = newScale / g.s0;
      const newTX = pivX - (pivX - g.tx0) * ratio;
      const newTY = pivY - (pivY - g.ty0) * ratio;
      const c = this._clamp(newTX, newTY, newScale);
      this.setData({ imageScale: newScale, translateX: c.tx, translateY: c.ty, zoomPct: Math.round(newScale * 100) });
      return;
    }

    if (g.mode === 'pending' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - g.x0;
      const dy = e.touches[0].clientY - g.y0;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) g.mode = 'pan';
    }

    if (g.mode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - g.lx;
      const dy = t.clientY - g.ly;
      g.lx = t.clientX; g.ly = t.clientY;
      const c = this._clamp(this.data.translateX + dx, this.data.translateY + dy, this.data.imageScale);
      this.setData({ translateX: c.tx, translateY: c.ty });
    }
  },

  onTouchEnd(e) {
    const g = this._ts;
    this._ts = null;
    if (!g || g.mode !== 'pending') return;

    // 单击：放置测量点（用缓存的 rect，同步执行）
    const rect = this._wrapRect;
    if (!rect || !this.data.imgW) return;

    const touch = e.changedTouches[0];
    // 屏幕坐标 → 容器坐标 → 原始图像坐标
    const sx = touch.clientX - rect.left;
    const sy = touch.clientY - rect.top;
    const ox = (sx - this.data.translateX) / this.data.imageScale;
    const oy = (sy - this.data.translateY) / this.data.imageScale;

    // 边界检查
    if (ox < 0 || ox > this.data.imgW || oy < 0 || oy > this.data.imgH) return;

    if (this.data.step === 1) this._addCalibPoint(ox, oy);
    else if (this.data.step === 2) this._addMeasurePoint(ox, oy);
  },

  resetZoom() {
    this.setData({ imageScale: 1, translateX: 0, translateY: 0, zoomPct: 100 });
  },

  _clamp(tx, ty, scale) {
    const { imgW, imgH } = this.data;
    return {
      tx: Math.min(0, Math.max(imgW  * (1 - scale), tx)),
      ty: Math.min(0, Math.max(imgH * (1 - scale), ty)),
    };
  },

  // ===================== 校准 =====================
  _addCalibPoint(x, y) {
    let pts = [...this.data.calibPoints];
    if (pts.length >= 2) pts = [];
    pts.push({ x, y });
    this.setData({ calibPoints: pts, calibLine: pts.length === 2 ? this._line(pts[0], pts[1]) : null });
  },

  onCalibInput(e) { this.setData({ calibRealCm: e.detail.value }); },

  onCalibConfirm() {
    const pts = this.data.calibPoints;
    if (pts.length < 2) { wx.showToast({ title: '请先点击参考物两端', icon: 'none' }); return; }
    const realCm = parseFloat(this.data.calibRealCm);
    if (!realCm || realCm <= 0) { wx.showToast({ title: '请输入有效长度', icon: 'none' }); return; }
    this.setData({ pixelsPerCm: this._dist(pts[0], pts[1]) / realCm, step: 2 });
    wx.showToast({ title: '校准完成', icon: 'success' });
  },

  // ===================== 测量 =====================
  _addMeasurePoint(x, y) {
    let pts = [...this.data.currentPoints];
    if (pts.length >= 2) pts = [];
    pts.push({ x, y });

    if (pts.length === 2) {
      const line = this._line(pts[0], pts[1]);
      const cm = (this._dist(pts[0], pts[1]) / this.data.pixelsPerCm).toFixed(1);
      const result = { id: Date.now(), type: this.data.measureType, cm, pt1: pts[0], pt2: pts[1], line };
      this.setData({ currentPoints: pts, currentLine: line, results: [result, ...this.data.results] });
      setTimeout(() => this.setData({ currentPoints: [], currentLine: null }), 1200);
      return;
    }
    this.setData({ currentPoints: pts, currentLine: null });
  },

  selectType(e) {
    this.setData({ measureType: e.currentTarget.dataset.type, currentPoints: [], currentLine: null });
  },

  clearCurrent() { this.setData({ currentPoints: [], currentLine: null }); },

  deleteResult(e) {
    const id = Number(e.currentTarget.dataset.id);
    this.setData({ results: this.data.results.filter(r => r.id !== id) });
  },

  // ===================== 工具 =====================
  _line(p1, p2) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    return { left: p1.x, top: p1.y, width: Math.sqrt(dx * dx + dy * dy), angle: Math.atan2(dy, dx) * 180 / Math.PI };
  },

  _dist(p1, p2) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  },

  backToCalib() {
    this.setData({ step: 1, calibPoints: [], calibLine: null, currentPoints: [], currentLine: null, results: [] });
  },

  resetAll() {
    this.setData({
      step: 0, photoPath: '', imgW: 0, imgH: 0,
      imageScale: 1, translateX: 0, translateY: 0, zoomPct: 100,
      calibPoints: [], calibLine: null, calibRealCm: '10', pixelsPerCm: 0,
      measureType: '株高', measureTypes: ['株高', '底荚高度','穗长', '茎节长', '分蘖高'], defaultTypeCount: 5,
      customTypeInput: '', currentPoints: [], currentLine: null, results: [],
    });
    this._wrapRect = null;
  },

  // ===================== 自定义测量项目 =====================
  onCustomTypeInput(e) { this.setData({ customTypeInput: e.detail.value }); },

  addCustomType() {
    const label = String(this.data.customTypeInput || '').trim();
    if (!label) { wx.showToast({ title: '请输入项目名', icon: 'none' }); return; }
    if (this.data.measureTypes.includes(label)) {
      wx.showToast({ title: '项目已存在', icon: 'none' }); return;
    }
    this.setData({
      measureTypes: [...this.data.measureTypes, label],
      measureType: label,
      customTypeInput: '',
    });
  },

  removeCustomType(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const removed = this.data.measureTypes[idx];
    const measureTypes = this.data.measureTypes.filter((_, i) => i !== idx);
    const measureType = this.data.measureType === removed ? '株高' : this.data.measureType;
    this.setData({ measureTypes, measureType });
  },

  // ===================== 保存 / 历史记录 =====================
  saveResults() {
    if (!this.data.results.length) {
      wx.showToast({ title: '暂无测量结果', icon: 'none' }); return;
    }
    const entry = {
      id: uid(),
      createdAt: Date.now(),
      displayTime: nowStr(),
      results: this.data.results.map(r => ({ type: r.type, cm: r.cm })),
    };
    const history = [entry, ...(this.data.measureHistory || [])];
    try { wx.setStorageSync(HISTORY_KEY, history); } catch (e) {}
    this.setData({ measureHistory: history });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  deleteHistoryItem(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认删除', content: '确定删除这条记录吗？',
      confirmText: '删除', confirmColor: '#E53935',
      success: res => {
        if (!res.confirm) return;
        const history = (this.data.measureHistory || []).filter(h => h.id !== id);
        try { wx.setStorageSync(HISTORY_KEY, history); } catch (e) {}
        this.setData({ measureHistory: history });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },
});
