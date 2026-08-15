Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: "/pages/index/index", // 路径建议以 / 开头 
        text: "种子计数",
        icon: "\ue602" // 尝试改为 e600，通常第一个图标是这个编码
      },
      {
        pagePath: "/pages/calculator/index",
        text: "计算器",
        icon: "\ue605"
      },
      {
        pagePath: "/pages/ai/index",
        text: "AI助手",
        icon: "\ue603"
      },
      {
        pagePath: "/pages/describe/index",
        text: "我的",
        icon: "\ue604"
      }
    ]
  },

  methods: {
    onChange(e) {
      const index = e.currentTarget.dataset.index;
      const url = this.data.list[index].pagePath;
      wx.switchTab({ url });
      // 注意：自定义 TabBar 的选中状态通常由页面 onLoad/onShow 里的 getTabBar().setData 控制
      this.setData({ selected: index }); 
    }
  }
})