// pages/describe/index.js
const accountStore = require("../../utils/describe-account.js");

Page({
  data: {
    isLoggedIn: false,
    authUser: null,
    profileDraft: { nickName: "", avatarUrl: "" },
    historyStats: { tags: 0, corrections: 0 },
    loginBusy: false
  },

  onShow() {
    this.refreshAccountState();

    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
  },

  refreshAccountState() {
    const authUser = accountStore.getAuth();
    this.setData({
      isLoggedIn: !!authUser,
      authUser,
      profileDraft: { nickName: "", avatarUrl: "" },
      historyStats: accountStore.getHistoryStats()
    });
  },

  // 手动上传头像
  onPickAvatar(e) {
    const avatarUrl = e.detail?.avatarUrl || "";
    if (!avatarUrl) return;
    this.setData({ "profileDraft.avatarUrl": avatarUrl });
  },

  // 手动填写昵称
  onNicknameInput(e) {
    this.setData({ "profileDraft.nickName": e.detail.value });
  },

  onQuickLogin() {
    if (this.data.loginBusy) return;

    this.setData({ loginBusy: true });
    wx.showLoading({ title: "登录中..." });

    // 先从微信拉取头像和昵称，自动填入 draft
    const profilePromise = new Promise((resolve) => {
      if (!wx.getUserProfile) {
        resolve({ nickName: "", avatarUrl: "" });
        return;
      }
      wx.getUserProfile({
        desc: "用于自动读取微信头像和昵称",
        success: (res) => {
          resolve({
            nickName: res?.userInfo?.nickName || "",
            avatarUrl: res?.userInfo?.avatarUrl || ""
          });
        },
        fail: (err) => {
          console.warn("getUserProfile fail:", err);
          resolve({ nickName: "", avatarUrl: "" });
        }
      });
    });

    Promise.all([
      profilePromise,
      wx.cloud.callFunction({ name: "describeAccount" })
    ]).then(([profileInfo, cloudRes]) => {
      const openid = cloudRes?.result?.openid;
      if (!openid) {
        console.error("NO_OPENID in response:", cloudRes);
        throw new Error("NO_OPENID");
      }

      // 用户手动填的优先，否则用微信自动获取的
      const draft = this.data.profileDraft;
      const nickName = String(draft.nickName || "").trim() || profileInfo.nickName || "微信用户";
      const avatarUrl = draft.avatarUrl || profileInfo.avatarUrl || "";

      accountStore.saveAuth({ userId: openid, nickName, avatarUrl });

      this.refreshAccountState();
      wx.showToast({ title: "已登录", icon: "success" });
    }).catch((err) => {
      console.error("describe login catch error:", err);
      wx.showToast({ title: "登录失败：" + String(err?.message || err), icon: "none" });
    }).finally(() => {
      wx.hideLoading();
      this.setData({ loginBusy: false });
    });
  },

  onLogout() {
    wx.showModal({
      title: "退出当前账号",
      content: "退出后将不显示该账号的历史记录，重新登录后可恢复查看。",
      success: (res) => {
        if (!res.confirm) return;

        accountStore.clearAuth();
        this.refreshAccountState();
        wx.showToast({ title: "已退出", icon: "success" });
      }
    });
  },

  onGoTools() {
    wx.navigateTo({ url: "/pages/describe_tools/index" });
  },

  onGoWeight() {
    wx.navigateTo({ url: "/pages/describe_weight/index" });
  },

  onGoMeasure() {
    wx.navigateTo({ url: "/pages/describe_measure/index" });
  }
});
