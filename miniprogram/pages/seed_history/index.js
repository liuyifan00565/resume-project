const accountStore = require("../../utils/describe-account.js");
const seedHistoryStore = require("../../utils/seed-history.js");

Page({
  data: {
    isLoggedIn: false,
    accountName: "",
    items: [],
    showDetail: false,
    detailItem: null,
    // 批量选择
    selectMode: false,
    selectedMap: {},
    selectedCount: 0
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const auth = accountStore.getAuth();
    const isLoggedIn = !!auth;
    this.setData({
      isLoggedIn,
      accountName: auth?.nickName || "",
      items: isLoggedIn ? seedHistoryStore.listHistory() : []
    });
  },

  goToDescribe() {
    wx.switchTab({ url: "/pages/describe/index" });
  },

  // 普通点击：选择模式下切换；否则打开详情
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    if (this.data.selectMode) {
      this._toggleById(id);
      return;
    }
    const item = (this.data.items || []).find(x => x.id === id);
    if (!item) return;
    this.setData({ showDetail: true, detailItem: item });
  },

  // 长按：进入批量选择模式
  onItemLongPress(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    if (!this.data.selectMode) {
      const selectedMap = {};
      selectedMap[id] = true;
      this.setData({ selectMode: true, selectedMap, selectedCount: 1 });
      wx.vibrateShort({ type: 'medium', fail: () => {} });
      return;
    }
    this._toggleById(id);
  },

  onToggleSelect(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this._toggleById(id);
  },

  _toggleById(id) {
    const selectedMap = { ...(this.data.selectedMap || {}) };
    selectedMap[id] = !selectedMap[id];
    const selectedCount = Object.values(selectedMap).filter(Boolean).length;
    this.setData({ selectedMap, selectedCount });
  },

  exitSelectMode() {
    this.setData({ selectMode: false, selectedMap: {}, selectedCount: 0 });
  },

  batchDelete() {
    const ids = Object.keys(this.data.selectedMap || {}).filter(k => this.data.selectedMap[k]);
    if (!ids.length) {
      wx.showToast({ title: '未选择任何记录', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认删除',
      content: `确定删除选中的 ${ids.length} 条记录吗？`,
      confirmText: '删除',
      confirmColor: '#E53935',
      success: (res) => {
        if (!res.confirm) return;
        ids.forEach(id => seedHistoryStore.deleteHistoryById(id));
        this.setData({ selectMode: false, selectedMap: {}, selectedCount: 0 });
        this.refresh();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  closeDetail() {
    this.setData({ showDetail: false, detailItem: null });
  },

  onDeleteDetail() {
    const item = this.data.detailItem;
    if (!item) return;
    wx.showModal({
      title: '删除这条记录？',
      content: '删除后不可恢复',
      confirmText: '删除',
      confirmColor: '#E53935',
      success: (res) => {
        if (!res.confirm) return;
        seedHistoryStore.deleteHistoryById(item.id);
        this.setData({ showDetail: false, detailItem: null });
        this.refresh();
      }
    });
  },

  onClearAll() {
    wx.showModal({
      title: '清空全部历史？',
      content: '清空后不可恢复',
      success: (res) => {
        if (!res.confirm) return;
        seedHistoryStore.clearHistory();
        this.refresh();
      }
    });
  },

  noop() {}
});
