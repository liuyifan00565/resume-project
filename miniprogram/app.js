App({
  onLaunch() {
    wx.cloud.init({
      env: "cloud1-5g91jejo54a9c31f",
      traceUser: true
    });
  },
  globalData: {
    tabIndex: 0
  }
});
