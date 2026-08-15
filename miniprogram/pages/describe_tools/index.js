Page({
  data: {
    modules: [
      {
        id: "tag",
        title: "生成标签",
        desc: "批次/品种/日期等一键生成并贴到作业记录",
        icon: "🏷️",
        path: "/pages/describe_tag/index"
      },
      {
        id: "report",
        title: "作业报告",
        desc: "导出TxT/Excel报告，统计汇总信息",
        icon: "📄",
        path: "/pages/describe_report/index"
      },
      {
        id: "sampling",
        title: "抽样可信度",
        desc: "均值/方差/CV评估：是否需要再抽一次",
        icon: "📊",
        path: "/pages/describe_sampling/index"
      },
      {
        id: "correction",
        title: "误检纠偏",
        desc: "点删误检/长按补漏检，形成修正闭环",
        icon: "🛠️",
        path: "/pages/describe_correction/index"
      }
    ]
  },

  onTapModule(e) {
    const { path } = e.currentTarget.dataset;
    if (!path) return;
    wx.navigateTo({ url: path });
  }
});
