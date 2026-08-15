// miniprogram/pages/ai/index.js

/**
 * 构建传给云函数的历史消息（最近 20 条，保留更多上下文）
 * currentIndex：取该索引（含）之前的所有消息
 */
function buildHistory(messages, currentIndex) {
  const history = [];
  const prev = messages.slice(0, currentIndex + 1);
  for (const msg of prev) {
      if (msg.role === "user") {
      if (msg.type === "image") {
        const imgUrl = msg.imageUrl || "";
        const fileID = msg.fileID || msg.fileId || "";
        // Don't pass WeChat temp/cloud URLs directly to third-party AI services
        // (they often cannot download those URLs). Instead include a text
        // placeholder and, when available, the cloud `fileID` as metadata.
        const textPart = msg.content || "这是一张图片";
        if (fileID) {
          history.push({
            role: "user",
            content: [
              { type: "text", text: textPart },
              { type: "text", text: `[图片 fileID:${fileID}]` }
            ]
          });
        } else {
          history.push({
            role: "user",
            content: [
              { type: "text", text: textPart },
              { type: "text", text: "[图片]" }
            ]
          });
        }
      } else if (msg.content) {
        history.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      const v = msg.versions && msg.versions[msg.activeVersionIndex];
      const raw = v && v.content ? v.content : "";
      const clean = raw.replace(/\n\n需要我再做一次【缺陷评估】吗？$/, "").trim();
      if (clean) history.push({ role: "assistant", content: clean });
    }
  }
  return history.slice(-20);
}

/** 根据文件名返回对应 emoji 图标 */
function getFileIcon(name) {
  if (!name) return "📄";
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    pdf: "📕", doc: "📘", docx: "📘",
    xls: "📗", xlsx: "📗", csv: "📊",
    txt: "📄", json: "📋", md: "📝",
    zip: "🗜️", rar: "🗜️", ppt: "📙", pptx: "📙",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️",
    mp4: "🎬", mp3: "🎵"
  };
  return map[ext] || "📄";
}

const AGENT_BASE = 'https://yolo.kzehealth.com/langgraph';

// 收到完整回复后，用打字机效果逐字显示
// 适配现有 versions 数据结构：更新 versions[activeVersionIndex].content
function typewriterEffect(text, messageIndex, page) {
  let i = 0
  const timer = setInterval(() => {
    if (i >= text.length) {
      clearInterval(timer)
      return
    }
    const messages = page.data.messages
    const msg = messages[messageIndex]
    if (!msg || !msg.versions) { clearInterval(timer); return }
    msg.versions[msg.activeVersionIndex].content = text.slice(0, i + 1)
    page.setData({ messages })
    i++
  }, 30)
}

/** 收集本地考种数据，随问题一起发给 Agent */
function collectLocalData() {
  try {
    return {
      measurements: wx.getStorageSync('ZTJ_MEASURE_HISTORY_V1') || [],
      tags:         (wx.getStorageSync('ZTJ_TAGS_V1') || []).slice(0, 20),
      seedCounts:   (wx.getStorageSync('ZTJ_SEED_HISTORY_V1') || []).slice(0, 10),
    };
  } catch (e) { return {}; }
}

// /** 调用 LangGraph Agent（/ai_chat），带本地数据上下文 */
// function callAgent(question, history) {
//   return new Promise((resolve) => {
//     wx.request({
//       url: `${AGENT_BASE}/ai_chat`,
//       method: 'POST',
//       data: {
//         question,
//         history: history || [],
//         localData: collectLocalData(),
//       },
//       success: res => {
//         const d = res.data || {};
//         if (d.ok && d.text) {
//           resolve({ type: 'text', text: d.text });
//         } else {
//           // 降级：走原云函数
//           wx.cloud.callFunction({
//             name: 'aiAgent',
//             data: { input: question, history: history || [] },
//             success: r => resolve(r.result && r.result.text
//               ? { type: 'text', text: r.result.text }
//               : { type: 'text', text: '暂无回复' }),
//             fail: () => resolve({ type: 'text', text: '网络异常，请稍后重试' }),
//           });
//         }
//       },
//       fail: () => {
//         // 降级：走原云函数
//         wx.cloud.callFunction({
//           name: 'aiAgent',
//           data: { input: question, history: history || [] },
//           success: r => resolve(r.result && r.result.text
//             ? { type: 'text', text: r.result.text }
//             : { type: 'text', text: '暂无回复' }),
//           fail: () => resolve({ type: 'text', text: '网络异常，请稍后重试' }),
//         });
//       },
//     });
//   });
// }

function callAgent(question, history) {
  return new Promise((resolve) => {
    wx.request({
      url: `${AGENT_BASE}/chat`,   // /ai_chat → /chat
      method: 'POST',
      data: {
        session_id: wx.getStorageSync('userOpenid') || 'anonymous',
        message: question,
        // 不需要传history了，LangGraph服务端自己管理记忆
      },
      success: res => {
        const d = res.data || {};
        if (d.reply) {
          resolve({ type: 'text', text: d.reply });
        } else {
          resolve({ type: 'text', text: '暂无回复' });
        }
      },
      fail: () => resolve({ type: 'text', text: '网络异常，请稍后重试' }),
    });
  });
}
/** 调用 aiAgent 云函数（图片分析，带上下文） */
async function callAgentWithImage(fileID, question, history) {
  // 下载云文件到本地临时路径，再转 base64，
  // 避免将微信云存储 URL 直接交给 AI 服务（服务端无法下载，导致 400 错误）
  const dl = await wx.cloud.downloadFile({ fileID });
  const tempPath = dl.tempFilePath;
  if (!tempPath) throw new Error("云文件下载失败");

  const imageBase64 = await new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: tempPath,
      encoding: 'base64',
      success: r => resolve('data:image/jpeg;base64,' + r.data),
      fail: reject,
    });
  });

  return new Promise((resolve) => {
    wx.request({
      url: `${AGENT_BASE}/chat`,
      method: 'POST',
      data: {
        session_id: wx.getStorageSync('userOpenid') || 'anonymous',
        message: question || "请分析这张种子图片",
        image: imageBase64,   // base64 而非远程 URL
      },
      success: res => {
        const d = res.data || {};
        resolve({ type: 'text', text: d.reply || '暂无回复' });
      },
      fail: () => resolve({ type: 'text', text: '网络异常，请稍后重试' }),
    });
  });
}

// 文本文件扩展名（前端可直接读 utf8）
const TEXT_EXTS = ["txt", "csv", "json", "md", "log", "xml", "html", "htm", "yaml", "yml", "tsv", "ini", "conf"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"];

Page({
  data: {
    // ─── 视图状态 ───
    view: 'list',           // 'list' | 'chat'
    conversations: [],      // [{id, title, preview, updatedAt, timeStr, messages, thumbnail, avatarType}]
    convGroups: [],         // [{label, items}] 按时间分组后的列表
    activeConvId: '',
    convTitle: '新对话',
    showConvMenu: false,
    selectMode: false,      // 批量选择模式
    selectedIds: [],        // 已选中的对话 id
    selectedSet: {},        // {id: true} 供 wxml 判断
    showSearch: false,      // 搜索模式
    searchQuery: '',        // 搜索关键词
    searchResults: [],      // 搜索结果（平铺列表）
    swipeOpenId: '',        // 当前滑开删除的对话 id

    // ─── 聊天状态 ───
    inputText: "",
    isLoading: false,
    scrollIntoView: "",
    keyboardHeight: 0,
    pendingImage: null,
    pendingFile: null,
    currentContextHint: "",
    suggestions: [
      "如何布置光照/背景更利于计数？",
      "计数结果偏多/偏少怎么调？",
      "发芽率怎么算？给公式和例子",
      "如何减少粘连/重叠导致误检？",
      "不同种子大小怎么拍更清晰？",
      "反光、阴影、模糊怎么处理？",
      "如何抽样才科学？（批次/重复）",
      "计数误差如何评估与校准？",
      "如何导出结果/生成报告？"
    ],
    messages: [],
    windowHeight: 0,   // 由 onLoad 通过 wx.getSystemInfoSync() 赋值

    // ─── 重命名弹窗 ───
    renameModalVisible: false,
    renamingConvId: '',
    renamingTitle: '',
  },

  _lastAttachmentContext: null,
  _pendingAssistantAction: null,

  _updateContextHint(context) {
    let hint = "";
    if (context && context.type === "image") {
      hint = "当前上下文：图片";
    } else if (context && context.type === "file") {
      const fileName = context.fileName || "文件";
      hint = `当前上下文：${fileName}`;
    }
    this.setData({ currentContextHint: hint });
  },

  _setAttachmentContext(context) {
    this._lastAttachmentContext = context || null;
    this._updateContextHint(this._lastAttachmentContext);
  },

  showImageOptions() {
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (res) => {
        const source = res.tapIndex === 0 ? 'camera' : 'album';
        this.chooseImage({ currentTarget: { dataset: { source } } });
      }
    });
  },

  // 文件按钮：两种来源选择
  showFileOptions() {
    if (this.data.isLoading) return;
    this._pickChatFile();
  },

  _setPendingFile(file) {
    if (!file) return;
    const name = file.name || file.originalFileName || "未命名文件";
    const path = file.path || file.tempFilePath || file.filePath || "";
    const size = file.size || file.fileSize || 0;
    if (!path) {
      wx.showToast({ title: "文件路径无效", icon: "none" });
      return;
    }
    const ext = name.split(".").pop().toLowerCase();
    if (IMAGE_EXTS.includes(ext)) {
      // 图片文件：转为图片消息，走视觉模型分析流程
      this.setData({
        pendingImage: { url: path, filePath: path, fileID: null },
        pendingFile: null
      });
      wx.showToast({ title: "图片已选择", icon: "success", duration: 1500 });
      return;
    }
    this.setData({
      pendingImage: null,
      pendingFile: {
        name,
        path,
        size,
        icon: getFileIcon(name)
      }
    });
  },

  _pickChatFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const file = res && res.tempFiles && res.tempFiles[0];
        this._setPendingFile(file);
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes("cancel")) {
          wx.showToast({ title: "选择文件失败", icon: "none" });
        }
      }
    });
  },

  // ⭐ 移除待发文件
  removePendingFile() {
    this.setData({ pendingFile: null });
    wx.showToast({ title: "已移除文件", icon: "success", duration: 1000 });
  },

  async onDoAction(e) {
    const { type, fileid } = e.currentTarget.dataset;
    if (type !== "defect" || !fileid || this.data.isLoading) return;

    const now = this._fmtTime(new Date());
    const aiMsg = {
      role: "assistant",
      time: now,
      isTyping: true,
      versions: [{ content: "🧪 正在进行缺陷评估…", time: now }],
      activeVersionIndex: 0,
      historyExpanded: false,
      compare: null
    };

    this.setData(
      { messages: [...this.data.messages, aiMsg], isLoading: true },
      () => this._scrollToBottom()
    );

    try {
      const currentMsgs = this.data.messages.slice();
      const history = buildHistory(currentMsgs, currentMsgs.length - 2);
      const answer = await callAgentWithImage(fileid, "请对这张种子图片进行详细缺陷评估，包括外观、色泽、破损情况", history);
      const reply = this._normalizeReply(answer || "暂无返回");
      const newNow = this._fmtTime(new Date());

      const updated = this.data.messages.slice();
      const lastIndex = updated.length - 1;
      updated[lastIndex] = {
        ...updated[lastIndex],
        time: newNow,
        isTyping: false,
        versions: [{ content: reply, time: newNow }],
        activeVersionIndex: 0
      };
      this.setData({ messages: updated, isLoading: false }, () => this._scrollToBottom());
    } catch (err) {
      const updated = this.data.messages.slice();
      const lastIndex = updated.length - 1;
      updated[lastIndex] = {
        ...updated[lastIndex],
        isTyping: false,
        versions: [{ content: "❌ 缺陷评估失败，请稍后再试。", time: this._fmtTime(new Date()) }],
        activeVersionIndex: 0
      };
      this.setData({ messages: updated, isLoading: false });
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
  },

  onLoad() {
    // 获取真实可用高度（已排除 tab 栏），用于撑满 chatPage
    // chatPage 高度由 CSS calc 控制，windowHeight 仅备用
    const { windowHeight } = wx.getSystemInfoSync();
    this.setData({ windowHeight });

    wx.onKeyboardHeightChange((res) => {
      this.setData({ keyboardHeight: res.height });
    });
    this._loadConversations();
  },

  onInput(e) { this.setData({ inputText: e.detail.value }); },
  onClear() { this.setData({ inputText: "" }); },
  onTapSuggestion(e) { this.setData({ inputText: e.currentTarget.dataset.text || "" }); },
  onInputFocus() { this._scrollToBottom(); },
  onInputBlur() {},

  // ================================================================
  // ==================== 对话管理 ==================================
  // ================================================================

  _convKey: 'ZTJ_AI_CONVS_V2',

  _loadConversations() {
    let convs = wx.getStorageSync(this._convKey) || [];
    if (!Array.isArray(convs)) convs = [];
    convs = convs.map(c => ({ ...c, timeStr: this._fmtConvTime(c.updatedAt) }));
    this.setData({ conversations: convs, convGroups: this._groupConversations(convs) });
    this._syncFromCloud();
  },

  // 按时间分组 + 置顶
  _groupConversations(convs) {
    if (!convs.length) return [];
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart  = todayStart - 6 * 86400000;
    const monthStart = todayStart - 29 * 86400000;

    const pinned  = convs.filter(c => c.pinned);
    const today   = convs.filter(c => !c.pinned && c.updatedAt >= todayStart);
    const week    = convs.filter(c => !c.pinned && c.updatedAt < todayStart && c.updatedAt >= weekStart);
    const month   = convs.filter(c => !c.pinned && c.updatedAt < weekStart  && c.updatedAt >= monthStart);
    const older   = convs.filter(c => !c.pinned && c.updatedAt < monthStart);

    const groups = [];
    if (pinned.length) groups.push({ label: '置顶', items: pinned });
    if (today.length)  groups.push({ label: '今天', items: today });
    if (week.length)   groups.push({ label: '本周', items: week });
    if (month.length)  groups.push({ label: '本月', items: month });
    if (older.length)  groups.push({ label: '更早', items: older });
    return groups;
  },

  _saveConversations(convs) {
    wx.setStorageSync(this._convKey, convs);
    this._syncToCloud(convs);
  },

  _fmtConvTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const pad = n => n < 10 ? '0' + n : '' + n;
    if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const days = ['日','一','二','三','四','五','六'];
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays < 7) return '周' + days[d.getDay()];
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth()+1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
  },

  async _syncFromCloud() {
    try {
      const db = wx.cloud.database();
      const res = await db.collection('ai_conversations').where({}).limit(1).get();
      if (!res.data || !res.data.length) return;
      const cloudConvs = res.data[0].conversations || [];
      const local = this.data.conversations;
      const map = {};
      [...local, ...cloudConvs].forEach(c => {
        if (!map[c.id] || c.updatedAt > map[c.id].updatedAt) map[c.id] = c;
      });
      const merged = Object.values(map)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(c => ({ ...c, timeStr: this._fmtConvTime(c.updatedAt) }));
      if (merged.length !== local.length) {
        wx.setStorageSync(this._convKey, merged);
        this.setData({ conversations: merged });
      }
    } catch (e) {}
  },

  async _syncToCloud(conversations) {
    try {
      const db = wx.cloud.database();
      const col = db.collection('ai_conversations');
      const slim = conversations.slice(0, 50).map(c => ({
        id: c.id, title: c.title, preview: c.preview, updatedAt: c.updatedAt,
        messages: (c.messages || []).slice(-30)
      }));
      const res = await col.where({}).limit(1).get();
      if (res.data && res.data.length) {
        await col.doc(res.data[0]._id).update({ data: { conversations: slim } });
      } else {
        await col.add({ data: { conversations: slim } });
      }
    } catch (e) {}
  },

  _genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  },

  _buildHelloMsg(now) {
    return {
      role: 'assistant', time: now, isTyping: false,
      versions: [{ content: '你好！我是智种计AI助手。🌱\n\n我能帮你：\n\n📸 图片分析 - 先上传图片，再描述你想了解的内容\n📎 文件分析 - 支持所有格式（docx、xlsx、pdf、txt、csv 等），我来解读\n💡 专业解答 - 回答光照布置、计数偏差、发芽率计算等问题\n📊 质检建议 - 提供科学的抽样方法和误差评估\n\n点击 📸 上传图片，点击 📎 上传文件，或直接提问～', time: now }],
      activeVersionIndex: 0, historyExpanded: false, compare: null
    };
  },

  _autoTitle(messages) {
    for (const m of messages) {
      if (m.role === 'user') return (m.content || '').slice(0, 18) || '新对话';
    }
    return '新对话';
  },

  _saveCurrentConversation() {
    const { activeConvId, messages } = this.data;
    if (!activeConvId) return;
    const title = this._autoTitle(messages);
    const lastAI = [...messages].reverse().find(m => m.role === 'assistant' && !m.isTyping);
    const v = lastAI && lastAI.versions && lastAI.versions[lastAI.activeVersionIndex];
    const preview = v && v.content ? v.content.replace(/\n/g, ' ').slice(0, 28) : '';
    // 缩略图 & 头像类型
    let thumbnail = '';
    let avatarType = 'text'; // text | image | file
    for (const m of messages) {
      if (m.role === 'user' && m.type === 'image' && m.imageUrl) {
        thumbnail = m.imageUrl; avatarType = 'image'; break;
      }
      if (m.role === 'user' && m.type === 'file') { avatarType = 'file'; }
    }
    const now = Date.now();
    const convs = this.data.conversations.slice();
    const idx = convs.findIndex(c => c.id === activeConvId);
    const updated = { id: activeConvId, title, preview, updatedAt: now, timeStr: this._fmtConvTime(now), messages, thumbnail, avatarType };
    if (idx >= 0) convs[idx] = updated;
    else convs.unshift(updated);
    convs.sort((a, b) => b.updatedAt - a.updatedAt);
    this.setData({ conversations: convs, convGroups: this._groupConversations(convs), convTitle: title });
    this._saveConversations(convs);
  },

  // ── 左滑删除 ──
  onSwipeTouchStart(e) {
    if (this.data.selectMode) return;
    this._swipeStartX = e.touches[0].clientX;
    this._swipeStartY = e.touches[0].clientY;
    this._swipeItemId = e.currentTarget.dataset.id;
  },

  onSwipeTouchMove(e) {
    if (this.data.selectMode) return;
    const dx = e.touches[0].clientX - this._swipeStartX;
    const dy = e.touches[0].clientY - this._swipeStartY;
    if (Math.abs(dy) > Math.abs(dx)) return; // 垂直滑动不处理
    const id = this._swipeItemId;
    if (dx < -80) {
      if (this.data.swipeOpenId !== id) this.setData({ swipeOpenId: id });
    } else if (dx > 20) {
      if (this.data.swipeOpenId === id) this.setData({ swipeOpenId: '' });
    }
  },

  closeSwipe() {
    if (this.data.swipeOpenId) this.setData({ swipeOpenId: '' });
  },

  swipePinConv(e) {
    const id = e.currentTarget.dataset.id;
    const pinned = !!e.currentTarget.dataset.pinned;
    this.setData({ swipeOpenId: '' });
    const convs = this.data.conversations.map(c =>
      c.id === id ? { ...c, pinned: !pinned } : c
    );
    convs.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });
    this.setData({ conversations: convs, convGroups: this._groupConversations(convs) });
    this._saveConversations(convs);
    wx.showToast({ title: pinned ? '已取消置顶' : '已置顶', icon: 'success' });
  },

  swipeDeleteConv(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ swipeOpenId: '' });
    wx.showModal({
      title: '删除对话', content: '删除后不可恢复',
      success: res => {
        if (!res.confirm) return;
        const convs = this.data.conversations.filter(c => c.id !== id);
        this.setData({ conversations: convs, convGroups: this._groupConversations(convs) });
        this._saveConversations(convs);
      }
    });
  },

  // ── 批量选择 ──
  onConvTap(e) {
    // 有滑开项时，先关闭
    if (this.data.swipeOpenId) {
      this.setData({ swipeOpenId: '' });
      return;
    }
    if (this.data.selectMode) {
      this._toggleSelect(e.currentTarget.dataset.id);
    } else {
      this.openConversation(e);
    }
  },

  onLongPressConv(e) {
    const id = e.currentTarget.dataset.id;
    const selectedIds = [id];
    const selectedSet = { [id]: true };
    this.setData({ selectMode: true, selectedIds, selectedSet, swipeOpenId: '' });
  },

  _toggleSelect(id) {
    const selectedIds = [...this.data.selectedIds];
    const idx = selectedIds.indexOf(id);
    if (idx >= 0) selectedIds.splice(idx, 1);
    else selectedIds.push(id);
    const selectedSet = {};
    selectedIds.forEach(i => { selectedSet[i] = true; });
    this.setData({ selectedIds, selectedSet });
  },

  selectAll() {
    const selectedIds = this.data.conversations.map(c => c.id);
    const selectedSet = {};
    selectedIds.forEach(i => { selectedSet[i] = true; });
    this.setData({ selectedIds, selectedSet });
  },

  cancelSelectMode() {
    this.setData({ selectMode: false, selectedIds: [], selectedSet: {} });
  },

  onSearch() {
    this.setData({ showSearch: true, searchQuery: '', searchResults: [] });
  },

  closeSearch() {
    this.setData({ showSearch: false, searchQuery: '', searchResults: [] });
  },

  onSearchInput(e) {
    const q = (e.detail.value || '').trim();
    if (!q) {
      this.setData({ searchQuery: '', searchResults: [] });
      return;
    }
    const lower = q.toLowerCase();
    const results = this.data.conversations.filter(c =>
      (c.title || '').toLowerCase().includes(lower) ||
      (c.preview || '').toLowerCase().includes(lower)
    );
    this.setData({ searchQuery: q, searchResults: results });
  },

  openSearchResult(e) {
    const id = e.currentTarget.dataset.id;
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) return;
    this._lastAttachmentContext = null;
    this._pendingAssistantAction = null;
    this.setData({
      showSearch: false, searchQuery: '', searchResults: [],
      view: 'chat', activeConvId: conv.id, convTitle: conv.title || '对话',
      messages: conv.messages || [],
      inputText: '', isLoading: false, pendingImage: null, pendingFile: null, showConvMenu: false
    }, () => this._scrollToBottom());
  },

  pinSelected() {
    const { selectedIds, conversations } = this.data;
    if (!selectedIds.length) {
      wx.showToast({ title: '请先选择对话', icon: 'none' });
      return;
    }
    // 切换置顶：已全部置顶则取消，否则全部置顶
    const allPinned = selectedIds.every(id => {
      const c = conversations.find(c => c.id === id);
      return c && c.pinned;
    });
    const convs = conversations.map(c => {
      if (this.data.selectedSet[c.id]) return { ...c, pinned: !allPinned };
      return c;
    });
    convs.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    });
    this.setData({ conversations: convs, convGroups: this._groupConversations(convs), selectMode: false, selectedIds: [], selectedSet: {} });
    this._saveConversations(convs);
    wx.showToast({ title: allPinned ? '已取消置顶' : '已置顶', icon: 'success' });
  },

  deleteSelected() {
    const { selectedIds, conversations } = this.data;
    if (!selectedIds.length) {
      wx.showToast({ title: '请先选择对话', icon: 'none' });
      return;
    }
    wx.showModal({
      title: `删除 ${selectedIds.length} 个对话`,
      content: '删除后不可恢复',
      success: res => {
        if (!res.confirm) return;
        const convs = conversations.filter(c => !this.data.selectedSet[c.id]);
        this.setData({ conversations: convs, convGroups: this._groupConversations(convs), selectMode: false, selectedIds: [], selectedSet: {} });
        this._saveConversations(convs);
      }
    });
  },

  deleteAll() {
    if (!this.data.conversations.length) return;
    wx.showModal({
      title: '删除全部对话',
      content: '删除后不可恢复',
      success: res => {
        if (!res.confirm) return;
        this.setData({ conversations: [], convGroups: [], selectMode: false, selectedIds: [], selectedSet: {} });
        this._saveConversations([]);
      }
    });
  },

  createConversation() {
    const id = this._genId();
    const now = this._fmtTime(new Date());
    this._lastAttachmentContext = null;
    this._pendingAssistantAction = null;
    this.setData({
      view: 'chat', activeConvId: id, convTitle: '新对话',
      messages: [this._buildHelloMsg(now)],
      inputText: '', isLoading: false, pendingImage: null, pendingFile: null, showConvMenu: false
    }, () => this._scrollToBottom());
  },

  openConversation(e) {
    const id = e.currentTarget.dataset.id;
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) return;
    this._lastAttachmentContext = null;
    this._pendingAssistantAction = null;
    this.setData({
      view: 'chat', activeConvId: conv.id, convTitle: conv.title || '对话',
      messages: conv.messages || [],
      inputText: '', isLoading: false, pendingImage: null, pendingFile: null, showConvMenu: false
    }, () => this._scrollToBottom());
  },

  backToList() {
    this._saveCurrentConversation();
    this.setData({ view: 'list', activeConvId: '', messages: [], showConvMenu: false });
  },

  deleteConversation(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除对话', content: '删除后不可恢复',
      success: res => {
        if (!res.confirm) return;
        const convs = this.data.conversations.filter(c => c.id !== id);
        this.setData({ conversations: convs, convGroups: this._groupConversations(convs) });
        this._saveConversations(convs);
      }
    });
  },

  toggleConvMenu() {
    this.setData({ showConvMenu: !this.data.showConvMenu });
  },

  // ─── 标题重命名 ───
  openRenameModal(e) {
    const id = e.currentTarget.dataset.id;
    const conv = this.data.conversations.find(c => c.id === id);
    if (!conv) return;
    const title = conv.title || '新对话';
    // 先写入 renamingTitle，待 setData 提交后再显示弹窗，
    // 避免 wx:if 创建 input 时 focus 与 value 竞争导致内容空白
    this.setData({ renamingConvId: id, renamingTitle: title }, () => {
      this.setData({ renameModalVisible: true });
    });
  },

  onRenameTitleInput(e) {
    this.setData({ renamingTitle: e.detail.value });
  },

  cancelRename() {
    this.setData({ renameModalVisible: false, renamingConvId: '', renamingTitle: '' });
  },

  confirmRename() {
    const { renamingConvId, renamingTitle, conversations, activeConvId } = this.data;
    const trimmed = (renamingTitle || '').trim();
    if (!renamingConvId || !trimmed) return;
    const convs = conversations.map(c => c.id === renamingConvId ? { ...c, title: trimmed } : c);
    const extra = activeConvId === renamingConvId ? { convTitle: trimmed } : {};
    this.setData({
      conversations: convs,
      convGroups: this._groupConversations(convs),
      renameModalVisible: false,
      renamingConvId: '',
      renamingTitle: '',
      ...extra,
    });
    this._saveConversations(convs);
  },

  deleteCurrentConversation() {
    this.setData({ showConvMenu: false });
    wx.showModal({
      title: '删除对话', content: '删除后不可恢复',
      success: res => {
        if (!res.confirm) return;
        const convs = this.data.conversations.filter(c => c.id !== this.data.activeConvId);
        this.setData({ conversations: convs, convGroups: this._groupConversations(convs), view: 'list', activeConvId: '', messages: [] });
        this._saveConversations(convs);
      }
    });
  },


  // ================================================================

  async chooseImage(e) {
    if (this.data.isLoading) return;
    const source = e.currentTarget.dataset.source;
    try {
      const pick = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: [source],
        sizeType: ['compressed'],
        maxDuration: 30
      });
      const filePath = pick && pick.tempFiles && pick.tempFiles[0]
        ? pick.tempFiles[0].tempFilePath : "";
      if (!filePath) return;
      this.setData({ pendingImage: { url: filePath, filePath, fileID: null } });
      wx.showToast({ title: "图片已选择", icon: "success", duration: 1500 });
    } catch (err) {
      console.error("选择图片失败：", err);
      wx.showToast({ title: "选择图片失败", icon: "none" });
    }
  },

  previewPendingImage() {
    if (!this.data.pendingImage || !this.data.pendingImage.url) return;
    wx.previewImage({ urls: [this.data.pendingImage.url], current: this.data.pendingImage.url });
  },

  removePendingImage() {
    this.setData({ pendingImage: null });
    wx.showToast({ title: "已移除图片", icon: "success", duration: 1000 });
  },

  previewImage(e) {
    const src = e.currentTarget.dataset.src;
    if (!src) return;
    wx.previewImage({ urls: [src], current: src });
  },

  previewYoloImage(e) {
    const src = e.currentTarget.dataset.src;
    if (!src) return;
    const fs = wx.getFileSystemManager();
    const path = `${wx.env.USER_DATA_PATH}/yolo_preview_${Date.now()}.jpg`;
    const base64Data = src.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFile({
      filePath: path,
      data: base64Data,
      encoding: 'base64',
      success: () => {
        wx.previewImage({ urls: [path], current: path });
      },
      fail: () => wx.showToast({ title: '预览失败', icon: 'none' })
    });
  },

  async previewFileMessage(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.messages[idx];
    if (!item || item.type !== "file") return;

    const ext = (item.fileExt || "").toLowerCase();
    const isImageFile = IMAGE_EXTS.includes(ext);

    if (item.textContent) {
      const content = (item.textContent || "").toString();
      const preview = content.length > 1200 ? `${content.slice(0, 1200)}\n\n...（内容较长，仅展示前 1200 字符）` : content;
      wx.showModal({
        title: item.fileName || "文件内容",
        content: preview || "文件为空",
        showCancel: false
      });
      return;
    }

    const openByPath = (path) => {
      wx.openDocument({
        filePath: path,
        fileType: ext || undefined,
        showMenu: true,
        fail: () => {
          wx.openDocument({
            filePath: path,
            showMenu: true,
            fail: (err) => {
              const msg = (err && err.errMsg) ? err.errMsg : "暂不支持预览该文件";
              wx.showToast({ title: msg.slice(0, 18), icon: "none" });
            }
          });
        }
      });
    };

    if (isImageFile) {
      if (item.fileID) {
        try {
          const urlRes = await wx.cloud.getTempFileURL({ fileList: [item.fileID] });
          const tempUrl = urlRes.fileList[0] && urlRes.fileList[0].tempFileURL;
          if (!tempUrl) throw new Error("获取图片地址失败");
          wx.previewImage({ urls: [tempUrl], current: tempUrl });
        } catch (err) {
          const msg = (err && err.errMsg) ? err.errMsg : "图片预览失败";
          wx.showToast({ title: msg.slice(0, 18), icon: "none" });
        }
        return;
      }

      if (item.localPath) {
        wx.previewImage({ urls: [item.localPath], current: item.localPath });
        return;
      }
    }

    if (item.fileID) {
      wx.showLoading({ title: "加载文件中…", mask: true });
      try {
        const dl = await wx.cloud.downloadFile({ fileID: item.fileID });
        wx.hideLoading();
        if (!dl.tempFilePath) throw new Error("下载失败");
        openByPath(dl.tempFilePath);
      } catch (err) {
        wx.hideLoading();
        const msg = (err && err.errMsg) ? err.errMsg : "文件预览失败";
        wx.showToast({ title: msg.slice(0, 18), icon: "none" });
      }
      return;
    }

    if (item.localPath) {
      openByPath(item.localPath);
      return;
    }

    wx.showToast({ title: "暂无可预览内容", icon: "none" });
  },

  // 优先级：文件 > 图片 > 文本
  async onSend() {
    const text = (this.data.inputText || "").trim();
    const hasPendingImage = !!this.data.pendingImage;
    const hasPendingFile = !!this.data.pendingFile;

    if (!text && !hasPendingImage && !hasPendingFile) return;
    if (this.data.isLoading) return;

    const now = this._fmtTime(new Date());

    if (!hasPendingImage && !hasPendingFile) {
      const handled = await this._tryRenameAndResendGeneratedFile(text, now);
      if (handled) {
        this.setData({ inputText: "" }, () => this._scrollToBottom());
        return;
      }
    }

    if (hasPendingFile) {
      const pendingFile = this.data.pendingFile;
      const pendingExt = ((pendingFile && pendingFile.name) || "").split(".").pop().toLowerCase();
      if (IMAGE_EXTS.includes(pendingExt)) {
        this.setData({
          pendingImage: {
            url: pendingFile.path,
            filePath: pendingFile.path,
            fileID: null
          },
          pendingFile: null
        });
        await this._sendImageMessage(text, now);
      } else {
        await this._sendFileMessage(text, now);
      }
    } else if (hasPendingImage) {
      await this._sendImageMessage(text, now);
    } else {
      await this._sendTextMessage(text, now);
    }
  },

  _getLatestAssistantText() {
    const messages = this.data.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "assistant" || m.type === "file" || m.isTyping) continue;
      const v = m.versions && m.versions[m.activeVersionIndex];
      const content = v && v.content ? (v.content || "").trim() : "";
      if (content) return content;
    }
    return "";
  },

  async _tryRenameAndResendGeneratedFile(text, now) {
    if (!text) return false;
    const hasRenameIntent = /(改名|重命名|命名|改成|换成|叫做|名称)/.test(text);
    if (!hasRenameIntent) return false;

    const targetExt = /(word|docx|doc|文档)/i.test(text)
      ? "docx"
      : (/(pdf|电子版)/i.test(text) ? "pdf" : "");
    const hasConvertKeyword = /(转成|转换成|转为|并转|改成.*pdf|改成.*word|改为.*pdf|改为.*word|以.*(word|docx|pdf).*格式|按.*(word|docx|pdf).*格式|用.*(word|docx|pdf).*格式)/i.test(text);

    const nameMatch = text.match(/(?:命名(?:为)?|改名(?:为)?|重命名(?:为)?|改成|换成|叫做|名称(?:为)?)\s*["“]?([^"”\n，。,！？!?\s]+)/i);
    let newBaseName = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "";
    newBaseName = newBaseName.replace(/(并|然后|再|以|按|用).*/i, "").trim();
    if (!newBaseName) return false;

    const messages = this.data.messages || [];
    const source = [...messages].reverse().find(m => {
      if (!m || m.type !== "file" || !m.fileID) return false;
      return true;
    });
    if (!source) return false;

    const sourceExt = (source.fileExt || "").toLowerCase();
    const needConvert = !!targetExt && (hasConvertKeyword || (sourceExt && sourceExt !== targetExt));

    if (needConvert) {
      const sourceText = this._getLatestAssistantText();
      if (!sourceText) {
        wx.showToast({ title: "未找到可转换内容", icon: "none" });
        return true;
      }
      await this._sendGeneratedDocument(
        sourceText,
        targetExt,
        newBaseName,
        `已按你的要求重命名并转为 ${newBaseName}.${targetExt}，点击查看/转发`
      );
      return true;
    }

    const ext = ((targetExt || sourceExt || "docx").toLowerCase() === "pdf") ? "pdf" : "docx";
    const renamedFile = {
      role: "assistant",
      type: "file",
      fileName: `${newBaseName}.${ext}`,
      fileExt: ext,
      fileID: source.fileID,
      content: `已按你的要求重命名为 ${newBaseName}.${ext}，点击查看/转发`,
      time: now
    };

    this.setData({ messages: [...messages, renamedFile] }, () => this._scrollToBottom());
    return true;
  },

  // ⭐ 文件消息发送：支持所有格式
  //   - 文本类（txt/csv/json…）：前端读取 utf8 文本直传
  //   - 二进制类（docx/xlsx/pdf…）：上传云存储后传 fileID
  async _sendFileMessage(userQuestion, now) {
    const file = this.data.pendingFile;
    const ext = (file.name || "").split(".").pop().toLowerCase();
    const isTextFile = TEXT_EXTS.includes(ext);
    const userMsgIndex = this.data.messages.length;

    const userMsg = {
      role: "user",
      type: "file",
      fileName: file.name,
      fileExt: ext,
      localPath: file.path,
      fileSize: file.size,
      content: userQuestion || "请分析这个文件",
      time: now
    };

    const aiMsg = {
      role: "assistant",
      time: now,
      isTyping: true,
      versions: [{ content: "📄 正在处理文件…", time: now }],
      activeVersionIndex: 0,
      historyExpanded: false,
      compare: null
    };

    this.setData(
      { messages: [...this.data.messages, userMsg, aiMsg], pendingFile: null, inputText: "", isLoading: true },
      () => this._scrollToBottom()
    );

    try {
      const currentMsgs = this.data.messages.slice();
      const history = buildHistory(currentMsgs, currentMsgs.length - 1);
      let callData;

      if (isTextFile) {
        const fs = wx.getFileSystemManager();
        const textContent = await new Promise((resolve, reject) => {
          fs.readFile({ filePath: file.path, encoding: "utf8", success: r => resolve(r.data), fail: reject });
        });
        this.setData({
          [`messages[${userMsgIndex}].textContent`]: textContent,
          [`messages[${userMsgIndex}].previewMode`]: "text"
        });
        callData = {
          input: userQuestion || "请分析这个文件",
          textFileContent: textContent,
          fileName: file.name,
          history
        };
      } else {
        // 二进制文件：上传到云存储
        wx.showLoading({ title: "上传文件中…" });
        const cloudPath = `uploads/${Date.now()}-${file.name}`;
        const up = await wx.cloud.uploadFile({ cloudPath, filePath: file.path });
        wx.hideLoading();
        if (!up.fileID) throw new Error("文件上传失败");
        this.setData({
          [`messages[${userMsgIndex}].fileID`]: up.fileID,
          [`messages[${userMsgIndex}].previewMode`]: "document"
        });
        callData = {
          input: userQuestion || "请分析这个文件",
          fileID: up.fileID,
          fileName: file.name,
          history
        };
      }

      this._setAttachmentContext({
        type: "file",
        fileID: callData.fileID || "",
        textContent: callData.textFileContent || "",
        fileName: file.name,
        fileExt: ext
      });
      this._pendingAssistantAction = null;

      const res = await wx.cloud.callFunction({ name: "aiAgent", data: callData });
      const reply = this._normalizeReply((res.result && res.result.text) || "暂无结果");
      const newNow = this._fmtTime(new Date());

      const updated = this.data.messages.slice();
      const last = updated.length - 1;
      updated[last] = {
        ...updated[last],
        time: newNow,
        isTyping: false,
        versions: [{ content: reply, time: newNow }],
        activeVersionIndex: 0,
        historyExpanded: false,
        compare: null
      };
      this.setData({ messages: updated, isLoading: false }, () => {
        this._scrollToBottom();
        this._saveCurrentConversation();
      });

    } catch (err) {
      this._pendingAssistantAction = null;
      wx.hideLoading();
      console.error("文件发送失败：", err);
      const updated = this.data.messages.slice();
      const last = updated.length - 1;
      updated[last] = {
        ...updated[last],
        isTyping: false,
        versions: [{
          content: "❌ 文件处理失败：" + (err && err.message || "未知错误"),
          time: this._fmtTime(new Date())
        }],
        activeVersionIndex: 0
      };
      this.setData({ messages: updated, isLoading: false }, () => this._scrollToBottom());
    }
  },

  async _sendImageMessage(userQuestion, now) {
    const pendingImage = this.data.pendingImage;

    const userMsgIndex = this.data.messages.length;
    const userImgMsg = {
      role: "user",
      type: "image",
      imageUrl: pendingImage.url,
      content: userQuestion || "请帮我分析这张图片",
      time: now
    };
    const aiMsg = {
      role: "assistant",
      time: now,
      isTyping: true,
      versions: [{ content: "🔍 正在分析图片…", time: now }],
      activeVersionIndex: 0,
      historyExpanded: false,
      compare: null
    };

    this.setData({
      messages: [...this.data.messages, userImgMsg, aiMsg],
      isLoading: true,
      inputText: "",
      pendingImage: null
    }, () => this._scrollToBottom());

    
  try {
    const cloudPath = `diagnosis/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
    const up = await wx.cloud.uploadFile({ cloudPath, filePath: pendingImage.filePath });
    const fileID = up.fileID;
    if (!fileID) throw new Error("上传失败：未获得 fileID");

    const urlRes = await wx.cloud.getTempFileURL({ fileList: [fileID] });
    const cloudImageUrl = (urlRes.fileList[0] && urlRes.fileList[0].tempFileURL) || "";
    this.setData({
      [`messages[${userMsgIndex}].imageUrl`]: cloudImageUrl || pendingImage.url,
      [`messages[${userMsgIndex}].fileID`]: fileID
    });

    // ⭐ 调LangGraph接口：图片以 base64 传送，避免服务端无法下载微信云存储 URL
    // （微信 tempFileURL 不可被第三方 AI 服务直接下载，会报 400 multimodal 错误）
    const imageBase64 = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: pendingImage.filePath,
        encoding: 'base64',
        success: r => resolve('data:image/jpeg;base64,' + r.data),
        fail: reject,
      });
    });

    const sessionId = wx.getStorageSync('userOpenid') || 'anonymous';
    const response = await new Promise((resolve, reject) => {
      wx.request({
        url: 'https://yolo.kzehealth.com/langgraph/chat',
        method: 'POST',
        data: {
          session_id: sessionId,
          message: userQuestion || "请分析这张种子图片",
          image: imageBase64,   // base64 而非云存储 URL
        },
        success: res => resolve(res.data || {}),
        fail: err => reject(new Error(err.errMsg || '请求失败'))
      });
    });

    const replyText = response.reply || "暂无返回";
    const reply = this._normalizeReply(replyText);
    const yoloImageBase64 = response.image_base64 || ""; // YOLO标注图
    const newNow = this._fmtTime(new Date());

    const updated = this.data.messages.slice();
    const lastIndex = updated.length - 1;
    updated[lastIndex] = {
      ...updated[lastIndex],
      time: newNow,
      isTyping: false,
      versions: [{ content: reply, time: newNow }],
      activeVersionIndex: 0,
      historyExpanded: false,
      compare: null,
      yoloImageBase64,  // ⭐ 存标注图
      actions: [{ type: "defect", label: "做缺陷评估", fileID }]
    };
    this.setData({ messages: updated, isLoading: false }, () => {
      this._scrollToBottom();
      this._saveCurrentConversation();
    });

  } 
  catch (err) {
      this._pendingAssistantAction = null;
      const msg = "❌ 图片分析失败：\n" + (err && err.message ? err.message : "unknown");
      const updated = this.data.messages.slice();
      const lastIndex = updated.length - 1;
      if (updated[lastIndex] && updated[lastIndex].role === "assistant") {
        updated[lastIndex] = {
          ...updated[lastIndex],
          isTyping: false,
          versions: [{ content: msg, time: this._fmtTime(new Date()) }],
          activeVersionIndex: 0
        };
      }
      this.setData({ messages: updated, isLoading: false, pendingImage: null }, () => this._scrollToBottom());
    }
  },

  async _sendTextMessage(text, now) {
    const userMsg = { role: "user", content: text, time: now };
    const aiMsg = {
      role: "assistant",
      time: now,
      isTyping: true,
      versions: [{ content: "🤔 正在思考中…", time: now }],
      activeVersionIndex: 0,
      historyExpanded: false,
      compare: null
    };

    const messagesWithAI = [...this.data.messages, userMsg, aiMsg];
    this.setData({ messages: messagesWithAI, inputText: "", isLoading: true }, () => this._scrollToBottom());

    try {
      // 本地意图识别：命中导航关键词直接跳转，不走网络
      const localTask = this._detectLocalNavigationIntent(text);
      if (localTask) {
        const updated = [...this.data.messages];
        updated.pop();
        this.setData({ messages: updated, isLoading: false }, () => {
          this.executeTask(localTask);
        });
        return;
      }

      const result = await this._callAIFromConversation(messagesWithAI);

      if (result && result.type === "task") {
        const updated = [...this.data.messages];
        updated.pop();
        this.setData({ messages: updated, isLoading: false }, () => {
          this.executeTask(result);
        });
        return;
      }

      const reply = this._normalizeReply(result && result.text ? result.text : "暂无回复");
      const newNow = this._fmtTime(new Date());
      const updated = [...this.data.messages];
      const lastIndex = updated.length - 1;
      updated[lastIndex] = {
        ...updated[lastIndex],
        time: newNow,
        isTyping: false,
        versions: [{ content: '', time: newNow }],  // 先置空，由打字机逐字填充
        activeVersionIndex: 0,
        historyExpanded: false,
        compare: null
      };
      this.setData({ messages: updated, isLoading: false }, () => {
        this._scrollToBottom();
        typewriterEffect(reply, lastIndex, this);
        this._saveCurrentConversation();
      });
    } catch (err) {
      const updated = [...this.data.messages];
      const lastIndex = updated.length - 1;
      updated[lastIndex] = {
        ...updated[lastIndex],
        isTyping: false,
        versions: [{
          content: "❌ 请求失败：\n" + (err && err.message || "unknown") + "\n\n（请检查网络或稍后重试）",
          time: this._fmtTime(new Date())
        }],
        activeVersionIndex: 0
      };
      this.setData({ messages: updated, isLoading: false }, () => this._scrollToBottom());
    }
  },

  // ⭐ 下载 AI 回复：选择格式后导出
  downloadMessage(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.messages[idx];
    if (!item || item.role !== "assistant" || item.isTyping) return;
    const v = item.versions && item.versions[item.activeVersionIndex];
    const content = v && v.content ? v.content : "";
    if (!content) return;

    wx.showActionSheet({
      itemList: ["导出为 TXT", "发送 Word 到聊天"],
      success: (res) => {
        if (res.tapIndex === 0) this._downloadTxt(content);
        else this._sendGeneratedDocument(content, "docx");
      }
    });
  },

  // TXT：前端直接写文件并打开
  _downloadTxt(content) {
    const fileName = `AI回复_${Date.now()}.txt`;
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
    wx.getFileSystemManager().writeFile({
      filePath,
      data: content,
      encoding: "utf8",
      success: () => {
        wx.openDocument({
          filePath,
          showMenu: true,
          fail: () => {
            // 降级：复制到剪贴板
            wx.setClipboardData({
              data: content,
              success: () => wx.showToast({ title: "已复制到剪贴板", icon: "success" })
            });
          }
        });
      },
      fail: () => wx.showToast({ title: "保存失败", icon: "none" })
    });
  },

  // 生成 Word/PDF 后直接发送到聊天，用户可点击查看与转发
  async _sendGeneratedDocument(content, format, customBaseName = "", customHint = "") {
    const isPdf = format === "pdf";
    const ext = isPdf ? "pdf" : "docx";
    const customFileName = customBaseName ? `${customBaseName}.${ext}` : "";
    wx.showLoading({ title: isPdf ? "生成 PDF…" : "生成 Word…", mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: "aiAgent",
        data: { action: "generateDocument", content, format, fileName: customFileName }
      });
      if (!res.result || !res.result.fileID) {
        throw new Error((res.result && res.result.error) || "生成失败");
      }

      const now = this._fmtTime(new Date());
      const fileMsg = {
        role: "assistant",
        type: "file",
        fileName: (res.result && res.result.fileName) || customFileName || `AI回复_${Date.now()}.${ext}`,
        fileExt: ext,
        fileID: res.result.fileID,
        content: customHint || (isPdf ? "AI已生成 PDF，点击查看/转发" : "AI已生成 Word，点击查看/转发"),
        time: now
      };

      this.setData({ messages: [...this.data.messages, fileMsg] }, () => this._scrollToBottom());
      wx.hideLoading();
      wx.showToast({ title: "已发送到聊天", icon: "success" });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: err.message || "生成失败", icon: "none" });
    }
  },

  copyText(e) {
    const text = e.currentTarget.dataset.text || "";
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: "已复制", icon: "success", duration: 1500 })
    });
  },

  copyActiveVersion(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.messages[idx];
    if (!item || item.role !== "assistant") return;
    const v = item.versions && item.versions[item.activeVersionIndex];
    const text = v && v.content ? v.content : "";
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: "已复制", icon: "success", duration: 1500 })
    });
  },

  toggleHistory(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const messages = [...this.data.messages];
    const item = messages[idx];
    if (!item || item.role !== "assistant") return;
    item.historyExpanded = !item.historyExpanded;
    messages[idx] = item;
    this.setData({ messages }, () => this._scrollToBottom());
  },

  setCompare(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const vindex = Number(e.currentTarget.dataset.vindex);
    const messages = [...this.data.messages];
    const item = messages[idx];
    if (!item || item.role !== "assistant") return;
    item.compare = { vindex };
    item.historyExpanded = true;
    messages[idx] = item;
    this.setData({ messages }, () => this._scrollToBottom());
  },

  useVersion(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const vindex = Number(e.currentTarget.dataset.vindex);
    const messages = [...this.data.messages];
    const item = messages[idx];
    if (!item || item.role !== "assistant") return;
    if (!item.versions || vindex < 0 || vindex >= item.versions.length) return;
    item.activeVersionIndex = vindex;
    item.compare = null;
    messages[idx] = item;
    wx.showToast({ title: "已切换版本", icon: "success", duration: 1500 });
    this.setData({ messages });
  },

  async regenerateAt(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (this.data.isLoading) return;
    const messages = [...this.data.messages];
    const target = messages[idx];
    if (!target || target.role !== "assistant") return;

    target.isTyping = true;
    messages[idx] = target;
    this.setData({ messages, isLoading: true }, () => this._scrollToBottom());

    try {
      const convo = this._buildConversationForRegenerate(idx);
      const replyRaw = await this._callAIFromConversation(convo);
      const reply = this._normalizeReply(replyRaw && replyRaw.text ? replyRaw.text : "暂无回复");
      const now = this._fmtTime(new Date());

      const updated = [...this.data.messages];
      const it = updated[idx];
      const versions = Array.isArray(it.versions) ? [...it.versions] : [];
      versions.push({ content: reply, time: now });
      it.versions = versions;
      it.activeVersionIndex = versions.length - 1;
      it.isTyping = false;
      it.time = now;
      it.historyExpanded = true;
      it.compare = null;
      updated[idx] = it;
      this.setData({ messages: updated, isLoading: false }, () => this._scrollToBottom());
    } catch (err) {
      const updated = this.data.messages.slice();
      const it = updated[idx];
      it.isTyping = false;
      it.historyExpanded = true;
      it.versions = (it.versions || []).concat([{
        content: "❌ 重新生成失败：\n" + (err && err.message || "unknown"),
        time: this._fmtTime(new Date())
      }]);
      it.activeVersionIndex = it.versions.length - 1;
      updated[idx] = it;
      this.setData({ messages: updated, isLoading: false }, () => this._scrollToBottom());
    }
  },

  async _callAIFromConversation(messages) {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].content) {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return { type: "text", text: "暂无回复" };

    const userText = messages[lastUserIdx].content;
    const history = buildHistory(messages, lastUserIdx - 1);

    const confirmAction = this._pendingAssistantAction || this._findPendingAssistantAction(messages, lastUserIdx - 1);
    if (confirmAction && this._isAffirmativeFollowUp(userText)) {
      if (confirmAction.type === "defect" && confirmAction.fileID) {
        this._pendingAssistantAction = null;
        this._setAttachmentContext({
          type: "image",
          fileID: confirmAction.fileID,
          imageUrl: "",
          content: userText
        });
        return await callAgentWithImage(
          confirmAction.fileID,
          "请对这张种子图片进行详细缺陷评估，包括外观、色泽、破损情况",
          history
        );
      }
    }

    const attachment = this._lastAttachmentContext || this._findRecentAttachmentContext(messages, lastUserIdx - 1);
    if (attachment && this._shouldReuseAttachmentContext(userText, attachment)) {
      if (attachment.type === "image" && attachment.fileID) {
        this._setAttachmentContext(attachment);
        return await callAgentWithImage(attachment.fileID, userText, history);
      }
      if (attachment.type === "file") {
        this._setAttachmentContext(attachment);
        return await callAgentWithFile(attachment, userText, history);
      }
    }

    return await callAgent(userText, history);
  },

  _isAffirmativeFollowUp(text) {
    const value = (text || "").trim();
    return /^(要|需要|好的|好|是|是的|可以|行|继续|继续吧|开始吧|来吧|请开始)$/.test(value);
  },

  _shouldReuseAttachmentContext(text, attachment) {
    const value = (text || "").trim();
    if (!value || !attachment) return false;
    if (this._isAffirmativeFollowUp(value)) return true;
    if (value.length <= 18) return true;
    return /(这个|这个文件|这份|这张|它|其|上述|上面|刚才|继续|进一步|详细|展开|总结|提取|分析|评估|解释|翻译|重命名|转成|转为)/.test(value);
  },

  _findPendingAssistantAction(messages, beforeIndex) {
    for (let i = beforeIndex; i >= 0; i--) {
      const item = messages[i];
      if (!item || item.role !== "assistant") continue;
      if (Array.isArray(item.actions) && item.actions.length) {
        return item.actions[0];
      }
      const v = item.versions && item.versions[item.activeVersionIndex];
      const content = v && v.content ? v.content : "";
      if (content && /需要我再做一次【缺陷评估】吗/.test(content)) {
        return null;
      }
      if (content) break;
    }
    return null;
  },

  _findRecentAttachmentContext(messages, beforeIndex) {
    for (let i = beforeIndex; i >= 0; i--) {
      const item = messages[i];
      if (!item || item.role !== "user") continue;
      if (item.type === "image" && (item.fileID || item.imageUrl)) {
        return {
          type: "image",
          fileID: item.fileID || "",
          imageUrl: item.imageUrl || "",
          content: item.content || ""
        };
      }
      if (item.type === "file" && (item.fileID || item.textContent)) {
        return {
          type: "file",
          fileID: item.fileID || "",
          textContent: item.textContent || "",
          fileName: item.fileName || "file",
          fileExt: item.fileExt || ""
        };
      }
    }
    return null;
  },

  _buildConversationForRegenerate(idx) {
    const raw = this.data.messages || [];
    const prev = raw.slice(0, idx);
    let lastUser = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (raw[i].role === "user" && raw[i].type !== "image") {
        lastUser = raw[i];
        break;
      }
    }
    if (lastUser) {
      const tail = prev[prev.length - 1];
      if (!tail || tail.role !== "user" || (tail.content || "") !== (lastUser.content || "")) {
        prev.push(lastUser);
      }
    }
    return prev;
  },

  _scrollToBottom() {
    const len = (this.data.messages || []).length;
    if (!len) return;
    this.setData({ scrollIntoView: `msg-${len - 1}` });
  },

  _fmtTime(d) {
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _detectLocalNavigationIntent(text) {
    const t = (text || '').trim();
    const routes = [
      { re: /生成标签|标签生成|填标签|写标签|制作标签|标签页/, target: '/pages/describe_tag/index' },
      { re: /称重|籽粒称重|粒重|重量|称一下/, target: '/pages/describe_weight/index' },
      { re: /作业报告|查报告|生成报告|导出报告/, target: '/pages/describe_report/index' },
      { re: /取样|抽样|抽查|采样/, target: '/pages/describe_sampling/index' },
      { re: /测量|株高|茎高|测高/, target: '/pages/describe_measure/index' },
      { re: /校正|偏差校正|误差校正/, target: '/pages/describe_correction/index' },
      { re: /工具|辅助工具/, target: '/pages/describe_tools/index' },
      { re: /计算器|发芽率|出苗率|计算/, target: '/pages/calculator/index' },
      { re: /种子计数|去计数|拍照计数|开始计数/, target: '/pages/index/index' },
    ];
    for (const { re, target } of routes) {
      if (re.test(t)) {
        return { type: 'task', steps: [{ action: 'navigate', target }] };
      }
    }
    return null;
  },

  executeTask(task) {
    const step = task.steps[0];
    this.setData({ isLoading: false });
    if (step.action === "navigate") {
      const tabBarPages = [
        "/pages/index/index",
        "/pages/calculator/index",
        "/pages/ai/index",
        "/pages/describe/index"
      ];
      if (tabBarPages.includes(step.target)) {
        wx.switchTab({ url: step.target });
      } else {
        wx.navigateTo({ url: step.target });
      }
    }
    wx.showToast({ title: "跳转中...", icon: "none" });
  },

  _normalizeReply(text) {
    let t = (text || "").toString();
    t = t.replace(/^\s+/, "");
    t = t.replace(/\n{3,}/g, "\n\n");
    return t;
  }
});

