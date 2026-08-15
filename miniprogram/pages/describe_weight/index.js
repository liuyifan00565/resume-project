const WEIGHT_SERVER = 'https://yolo.kzehealth.com';
const WEIGHT_DEVICE_CODE = 'seed_box_001';
const SAMPLE_INTERVAL_MS = 500;   // 每 500ms 采一次
const SAMPLE_COUNT = 6;           // 共采 6 次（3 秒）
const HISTORY_KEY = 'ZTJ_WEIGHT_HISTORY_V1';

Page({
  data: {
    isFetching: false,
    isSampling: false,
    countdown: 3,
    serverStateText: '等待连接',
    serverConnected: false,
    statusText: '点击获取按钮开始采样',
    weightValue: '--',
    weightUnit: 'g',
    deviceText: '设备：-',
    lastUpdateTime: '--',
    hasResult: false,
    canConfirm: false,
    // 历史记录
    history: [],
    selectMode: false,
    selectedIds: [],
    selectedSet: {},
  },

  _sampleTimer: null,
  _countdownTimer: null,
  _samples: [],
  _samplesDone: 0,
  _lastDevice: '',
  _lastServerTime: '',

  onLoad() {
    this._loadHistory();
  },

  onShow() {
    this._loadHistory();
  },

  onUnload() {
    this._clearTimers();
  },

  onHide() {
    this._clearTimers();
  },

  _clearTimers() {
    if (this._sampleTimer)    { clearInterval(this._sampleTimer);    this._sampleTimer = null; }
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
  },

  _loadHistory() {
    const h = wx.getStorageSync(HISTORY_KEY) || [];
    this.setData({ history: Array.isArray(h) ? h : [] });
  },

  _saveHistory(list) {
    wx.setStorageSync(HISTORY_KEY, list);
    this.setData({ history: list });
  },

  formatTimeNow() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  },

  // ─── 点击获取：开始 3 秒采样 ───
  onFetchWeight() {
    if (this.data.isSampling || this.data.isFetching) return;

    this._clearTimers();
    this._samples = [];
    this._samplesDone = 0;
    this._lastDevice = '';
    this._lastServerTime = '';

    this.setData({
      isSampling: true,
      isFetching: true,
      canConfirm: false,
      countdown: 3,
      statusText: '正在采样，请稳定设备...',
      serverStateText: '采样中',
    });

    // 倒计时 1s 更新一次
    let cd = 3;
    this._countdownTimer = setInterval(() => {
      cd = Math.max(0, cd - 1);
      this.setData({ countdown: cd });
      if (cd <= 0) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
    }, 1000);

    // 采样 500ms 一次
    this._sampleTimer = setInterval(() => {
      this._doSample();
    }, SAMPLE_INTERVAL_MS);
  },

  _doSample() {
    wx.request({
      url: `${WEIGHT_SERVER}/latest_weight`,
      method: 'GET',
      data: { deviceCode: WEIGHT_DEVICE_CODE },
      timeout: 3000,
      success: (res) => {
        const payload = res.data && res.data.data;
        if (res.statusCode === 200 && res.data && res.data.code === 0 && payload && payload.weight !== undefined) {
          this._samples.push(Number(payload.weight));
          this._lastDevice = payload.deviceCode || WEIGHT_DEVICE_CODE;
          this._lastServerTime = payload.time || '';
          this.setData({ serverConnected: true });
        } else {
          this.setData({ serverConnected: false });
        }
      },
      fail: () => {
        this.setData({ serverConnected: false });
      },
      complete: () => {
        this._samplesDone++;
        if (this._samplesDone >= SAMPLE_COUNT) {
          this._finalizeSampling();
        }
      },
    });
  },

  _finalizeSampling() {
    this._clearTimers();

    if (this._samples.length === 0) {
      this.setData({
        isSampling: false,
        isFetching: false,
        canConfirm: false,
        serverConnected: false,
        serverStateText: '连接失败',
        statusText: '无法获取数据，请检查设备和网络',
        countdown: 0,
      });
      return;
    }

    // 取均值
    const avg = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    const displayVal = avg >= 1000 ? (avg / 1000).toFixed(3) : avg.toFixed(2);
    const unit = avg >= 1000 ? 'kg' : 'g';
    const now = this.formatTimeNow();

    this.setData({
      isSampling: false,
      isFetching: false,
      canConfirm: true,
      hasResult: true,
      weightValue: displayVal,
      weightUnit: unit,
      deviceText: `设备：${this._lastDevice || WEIGHT_DEVICE_CODE}`,
      lastUpdateTime: this._lastServerTime || now,
      serverStateText: '已连接',
      serverConnected: true,
      statusText: `已采样 ${this._samples.length} 次，均值已锁定`,
      countdown: 0,
    });
  },

  // ─── 确认保存 ───
  onConfirmRecord() {
    if (!this.data.canConfirm) return;
    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      value: this.data.weightValue,
      unit: this.data.weightUnit,
      device: this.data.deviceText,
      time: this.formatTimeNow(),
      sampleCount: this._samples.length,
    };
    const history = [record, ...this.data.history];
    this._saveHistory(history);
    this.setData({ canConfirm: false });
    wx.showToast({ title: '已保存记录', icon: 'success' });
  },

  // ─── 历史记录批量删除 ───
  onLongPressRecord(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({
      selectMode: true,
      selectedIds: [id],
      selectedSet: { [id]: true },
    });
  },

  onTapRecord(e) {
    if (!this.data.selectMode) return;
    const id = e.currentTarget.dataset.id;
    const selectedIds = [...this.data.selectedIds];
    const idx = selectedIds.indexOf(id);
    if (idx >= 0) selectedIds.splice(idx, 1);
    else selectedIds.push(id);
    const selectedSet = {};
    selectedIds.forEach(i => { selectedSet[i] = true; });
    this.setData({ selectedIds, selectedSet });
  },

  cancelSelect() {
    this.setData({ selectMode: false, selectedIds: [], selectedSet: {} });
  },

  selectAll() {
    const selectedIds = this.data.history.map(h => h.id);
    const selectedSet = {};
    selectedIds.forEach(i => { selectedSet[i] = true; });
    this.setData({ selectedIds, selectedSet });
  },

  deleteSelected() {
    const { selectedIds } = this.data;
    if (!selectedIds.length) return;
    wx.showModal({
      title: `删除 ${selectedIds.length} 条记录`,
      content: '删除后不可恢复',
      success: res => {
        if (!res.confirm) return;
        const history = this.data.history.filter(h => !this.data.selectedSet[h.id]);
        this._saveHistory(history);
        this.setData({ selectMode: false, selectedIds: [], selectedSet: {} });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },
});
