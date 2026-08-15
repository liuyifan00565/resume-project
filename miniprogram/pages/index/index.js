// pages/index/index.js

const API_URL = 'https://yolo.kzehealth.com/api/seedcount';
// const API_URL = "http://127.0.0.1:5000/api/seedcount"
const accountStore = require('../../utils/describe-account.js');
const seedHistoryStore = require('../../utils/seed-history.js');

Page({
  data: {
    target: 100,
    baseCount: 0,
    manualPoints: 0,
    displayImageUrl: '',
    imgW: 0,
    imgH: 0,
    markers: [],
    backendMarkers: [],
    totalCount: 0,
    diffAbs: 0,
    diffPrefix: '少',
    diffSignClass: 'minus',
    locked: false,
    uploading: false,
    showCamera: false,

    // 质量检测相关
    qualityLoading: false,
    showQualityPanel: false,
    qualityResult: null,
    hasImage: false,        // 是否已有识别结果
    defectMarkers: [],      // [{x,y,color,label}] 缺陷标记点（图片像素坐标）
    
    imageScale: 1,
    translateX: 0,
    translateY: 0,
    
    cameraZoom: 0.5,
    maxZoom: 3,
    cameraContext: null,
    inputFocused: false,
  },

  // 容器矩形缓存
  containerRect: null,

  // 当前图片原始路径（供质量检测复用）
  currentFilePath: '',

  // 是否已写入历史（防重复）
  _historySaved: false,

  // YOLO 检测到的种子归一化坐标列表 [{nx, ny, idx}]
  yoloDetections: [],

  // 手势状态
  gesture: {
    mode: 'none',
    startScale: 1,
    startDist: 0,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    pivotX: 0,
    pivotY: 0,
    baseTransX: 0,
    baseTransY: 0,
  },
  onShow() {
    this._refreshLoginState();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 0  // 第1个tab
      })
    }
  },
  onLoad() {
    this._refreshLoginState();
    this._recalc();
  },

  _refreshLoginState() {
    const auth = accountStore.getAuth();
    this.setData({
      isLoggedIn: !!auth,
      accountName: auth?.nickName || ''
    });
  },

  openSeedHistory() {
    if (!accountStore.isLoggedIn()) {
      wx.showToast({ title: '请先在“我的”中登录', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/seed_history/index' });
  },

  setTarget100() { this.setData({ target: 100 }, this._recalc); },
  setTarget200() { this.setData({ target: 200 }, this._recalc); },
  
  onTargetInput(e) {
    const v = parseInt(e.detail.value, 10);
    this.setData({ target: Number.isFinite(v) ? v : 0 }, this._recalc);
  },

  onTargetFocus() {
    this.setData({ inputFocused: true });
  },

  onTargetBlur() {
    this.setData({ inputFocused: false });
  },

  selectFromAlbum() {
    if (this.data.locked) return;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath;
        // 清空旧检测结果，防止 onImageLoad 把上一张图的标记点渲染到新图上
        this.yoloDetections = [];
        // 不清零 imgH/imgW，让 onImageLoad 触发后自然更新，避免上传期间图片被截断
        this.setData({ displayImageUrl: path, backendMarkers: [] });
        this._compressAndUpload(path);
      }
    });
  },
  // goCalc() {
  //   wx.navigateTo({ url: "/pages/calculator/index" });
  // },
  
  takePhoto() {
    if (this.data.locked) return;
    this.setData({ 
      showCamera: true,
      cameraZoom: 0.5
    }, () => {
      setTimeout(() => {
        this._initCameraContext();
        this._applyCameraZoom(0.5);
      }, 300);
    });
  },

  closeCameraView() {
    this.setData({ showCamera: false, cameraZoom: 0.5 });
  },

  onCameraReady(e) {
    this._initCameraContext();
    if (e.detail && e.detail.maxZoom) {
      this.setData({ maxZoom: Math.min(e.detail.maxZoom, 5) });
    }
  },

  onCameraError(e) {
    console.error('❌ 相机错误:', e);
    wx.showToast({ title: '相机启动失败', icon: 'error' });
  },

  _initCameraContext() {
    if (!this.data.cameraContext) {
      this.data.cameraContext = wx.createCameraContext();
    }
  },

  onZoomChanging(e) {
    this.setData({ cameraZoom: e.detail.value });
    this._applyCameraZoom(e.detail.value);
  },

  onZoomChange(e) {
    this.setData({ cameraZoom: e.detail.value });
    this._applyCameraZoom(e.detail.value);
  },

  _applyCameraZoom(zoom) {
    if (this.data.cameraContext) {
      this.data.cameraContext.setZoom({
        zoom: zoom,
        success: () => console.log('✅ 相机缩放:', zoom)
      });
    }
  },

  _snapAndAnalyze() {
    if (this.data.locked) return;
    if (!this.data.cameraContext) this._initCameraContext();

    this.data.cameraContext.takePhoto({
      quality: 'high',
      success: (res) => {
        this.yoloDetections = [];
        this.setData({ showCamera: false, cameraZoom: 0.5, displayImageUrl: res.tempImagePath, backendMarkers: [] });
        this._compressAndUpload(res.tempImagePath);
      }
    });
  },

  // 上传前 canvas 缩放到 800px（与服务端 MAX_INFER_DIM 一致）
  // 体积 ~80KB（原 ~400KB），上传快 ~0.7s，精度不变（服务端本来就会缩到 800px）
  _compressAndUpload(filePath) {
    this.currentFilePath = filePath; // 保存原始路径供质量检测复用
    wx.getImageInfo({
      src: filePath,
      success: (info) => {
        const { width, height } = info;
        const MAX_DIM = 800;
        if (Math.max(width, height) <= MAX_DIM) {
          // 图片已足够小，直接上传
          this._uploadAndAnalyze(filePath);
          return;
        }
        // canvas 缩放
        const scale = MAX_DIM / Math.max(width, height);
        const nW = Math.round(width * scale);
        const nH = Math.round(height * scale);
        wx.createSelectorQuery().in(this).select('#cutCanvas').node((res) => {
          const canvas = res && res.node;
          if (!canvas) {
            // canvas 不可用时回退质量压缩
            this._compressQualityFallback(filePath);
            return;
          }
          canvas.width  = nW;
          canvas.height = nH;
          const ctx = canvas.getContext('2d');
          const img = canvas.createImage();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, nW, nH);
            wx.canvasToTempFilePath({
              canvas, fileType: 'jpg', quality: 0.85,
              success: (r) => {
                console.log(`[压缩] ${width}×${height} → ${nW}×${nH}`);
                this.smallFilePath = r.tempFilePath; // 供质检直接复用，跳过拼图
                this._uploadAndAnalyze(r.tempFilePath);
              },
              fail: () => this._compressQualityFallback(filePath),
            });
          };
          img.onerror = () => this._compressQualityFallback(filePath);
          img.src = filePath;
        }).exec();
      },
      fail: () => this._uploadAndAnalyze(filePath),
    });
  },

  // 回退：canvas 不可用时仅压缩质量
  _compressQualityFallback(filePath) {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: ({ size }) => {
        const mb = size / (1024 * 1024);
        if (mb < 0.4) { this._uploadAndAnalyze(filePath); return; }
        let quality = 40;
        if (mb > 6)      quality = 18;
        else if (mb > 4) quality = 22;
        else if (mb > 2) quality = 28;
        else if (mb > 1) quality = 35;
        wx.compressImage({
          src: filePath, quality,
          success: r => {
            this.smallFilePath = r.tempFilePath;
            this._uploadAndAnalyze(r.tempFilePath);
          },
          fail: () => this._uploadAndAnalyze(filePath),
        });
      },
      fail: () => this._uploadAndAnalyze(filePath),
    });
  },

  _uploadAndAnalyze(filePath) {
    if (this.data.uploading) return;
    this.setData({
      uploading: true,
      defectMarkers: [],
      qualityResult: null,
      showQualityPanel: false,
      // 保留 displayImageUrl（已在选图时预填原图），不清除，提升感知速度
      backendMarkers: [],
      hasImage: false,
      // 保留 imgW/imgH，上传期间图片保持完整显示，_refreshBackendMarkers 结束后会更新
    });
    wx.showLoading({ title: '识别中', mask: true });
    this._clearManual();

    wx.uploadFile({
      url: API_URL,
      name: 'file',
      filePath,
      // return_image=0：告知服务器跳过生成标注图，只返回 JSON，大幅减少响应体积和服务器耗时
      formData: { return_image: '0' },
      success: ({ data, statusCode }) => {
        if (statusCode && statusCode >= 400) {
          console.error('YOLO 后端错误:', statusCode, data?.slice(0, 200));
          wx.showToast({ title: `识别服务异常(${statusCode})，请稍后重试`, icon: 'none', duration: 3000 });
          this.setData({ uploading: false });
          wx.hideLoading();
          return;
        }
        try {
          if (!data || data.trimStart().startsWith('<')) {
            throw new Error('后端返回了 HTML 错误页，非 JSON');
          }
          const resp = JSON.parse(data || '{}');
          console.log('YOLO响应字段:', Object.keys(resp).join(', '));
          const count = +resp.count || 0;
          const dataUrl = resp.image_base64 || '';

          // 尝试提取 YOLO 检测结果（支持多种字段名格式）
          const rawDetections = resp.detections || resp.boxes || resp.seeds || resp.results || [];
          console.log('YOLO检测数量:', rawDetections.length,
            rawDetections.length > 0 ? '首条:' + JSON.stringify(rawDetections[0]) : '');

          // 将检测坐标归一化到 0-1 范围
          const imgOrigW = resp.image_width || resp.width || resp.img_width || 0;
          const imgOrigH = resp.image_height || resp.height || resp.img_height || 0;
          let normalizedDetections = [];
          if (rawDetections.length > 0) {
            if (imgOrigW > 0 && imgOrigH > 0) {
              // 像素坐标 → 归一化
              normalizedDetections = rawDetections.map((d, i) => {
                const cx = (d.center_x !== undefined ? d.center_x : (d.cx !== undefined ? d.cx : (d.x || 0)));
                const cy = (d.center_y !== undefined ? d.center_y : (d.cy !== undefined ? d.cy : (d.y || 0)));
                return { nx: cx / imgOrigW, ny: cy / imgOrigH, idx: i };
              });
            } else {
              // 无图片尺寸信息，尝试直接用作归一化坐标（若值<=1则认为已归一化）
              const first = rawDetections[0];
              const testX = first.center_x !== undefined ? first.center_x : (first.cx !== undefined ? first.cx : first.x);
              if (testX !== undefined && testX <= 1.0) {
                normalizedDetections = rawDetections.map((d, i) => {
                  const cx = d.center_x !== undefined ? d.center_x : (d.cx !== undefined ? d.cx : (d.x || 0));
                  const cy = d.center_y !== undefined ? d.center_y : (d.cy !== undefined ? d.cy : (d.y || 0));
                  return { nx: cx, ny: cy, idx: i };
                });
              }
            }
          }
          this.yoloDetections = normalizedDetections;
          console.log('归一化YOLO坐标数量:', normalizedDetections.length);

          const normalizedMarkers = [];
          // 直接用原图显示，叠加蓝点标记即可；跳过 base64 解码与本地写文件，节省 1~2 秒
          this._updateImageData(count, filePath, normalizedMarkers);
        } catch (error) {
          console.error('❌ 解析失败:', error.message, '\n原始响应(前300):', data?.slice(0, 300));
          wx.showToast({ title: '识别服务暂时不可用，请稍后重试', icon: 'none', duration: 3000 });
        }
      },
      fail: (err) => {
        console.error('❌ YOLO 上传/请求失败:', err);
        wx.showToast({ title: '识别失败', icon: 'none' });
      },
      complete: () => {
        this.setData({ uploading: false });
        wx.hideLoading();
      },
    });
  },

  _saveDataUrlToLocal(dataUrl, callback) {
    try {
      const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) {
        callback(null);
        return;
      }
      const binaryString = wx.base64ToArrayBuffer(matches[2]);
      const fs = wx.getFileSystemManager();
      const filePath = `${wx.env.USER_DATA_PATH}/temp_${Date.now()}.${matches[1]}`;
      fs.writeFile({
        filePath,
        data: binaryString,
        encoding: 'binary',
        success: () => callback(filePath),
        fail: () => callback(null)
      });
    } catch (error) {
      callback(null);
    }
  },

  _updateImageData(count, imagePath, markers) {
    this._historySaved = false;
    this._currentHistoryId = null;
    this.setData({
      baseCount: count,
      displayImageUrl: imagePath,
      backendMarkers: markers,
      markers: [],
      imageScale: 1,
      translateX: 0,
      translateY: 0,
      hasImage: true,
      qualityResult: null,
      showQualityPanel: false,
      defectMarkers: [],
    }, () => {
      this._recalc();
      this._resetGesture();
      this.containerRect = null;
      wx.showToast({ title: `识别完成: ${count}粒`, icon: 'success', duration: 2000 });
      // YOLO 结果已到，主动计算 backendMarkers（因为图片提前预显，onImageLoad 已触发过）
      this._refreshBackendMarkers(imagePath);
    });
  },

  // YOLO 结果返回后重算蓝点坐标（解决预显示导致 onImageLoad 提前触发、蓝点为空的问题）
  _refreshBackendMarkers(imagePath) {
    const dets = this.yoloDetections || [];
    if (!dets.length) return;
    wx.getImageInfo({
      src: imagePath,
      success: (info) => {
        wx.createSelectorQuery().in(this)
          .select('.gesture-container')
          .boundingClientRect((rect) => {
            if (!rect || !info.width || !info.height) return;
            const displayHeight = info.height * (rect.width / info.width);
            const backendMarkers = dets.map(d => ({
              x: d.nx * rect.width,
              y: d.ny * displayHeight,
              color: '#3b82f6',
            }));
            this.containerRect = rect;
            this.setData({ imgW: rect.width, imgH: displayHeight, backendMarkers });
          })
          .exec();
      },
    });
  },

  onImageLoad(e) {
    const { width, height } = e.detail;
    if (width && height) {
      wx.createSelectorQuery()
        .select('.gesture-container')
        .boundingClientRect((rect) => {
          if (rect) {
            const displayHeight = height * (rect.width / width);
            this.containerRect = rect;

            // 将 YOLO 归一化坐标转换为显示像素坐标，作为蓝色后端标记点
            const yoloDets = this.yoloDetections || [];
            const backendMarkers = yoloDets.map(d => ({
              x: d.nx * rect.width,
              y: d.ny * displayHeight,
              color: '#3b82f6',   // 默认蓝色；质检后会按缺陷类型染色
            }));

            this.setData({ imgW: rect.width, imgH: displayHeight, backendMarkers });
            console.log('✅ 图片加载完成:', {
              容器宽度: rect.width,
              显示高度: displayHeight,
              YOLO标记点数: backendMarkers.length,
            });
          }
        })
        .exec();
    }
  },

  onImageError(e) {
    console.error('❌ 图片加载失败');
    wx.showToast({ title: '图片加载失败', icon: 'error' });
  },

  // 🔧 手动标记功能
  onImageTap(e) {
    if (!this.data.displayImageUrl || !this.data.imgW || !this.data.imgH) return;
    
    const touch = e.touches[0] || e.changedTouches[0];
    if (!touch) return;
    
    const query = wx.createSelectorQuery();
    query.select('.img').boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((res) => {
      if (res && res[0] && res[1]) {
        const imageRect = res[0];
        const scrollOffset = res[1];
        const relativeX = touch.pageX - imageRect.left - scrollOffset.scrollLeft;
        const relativeY = touch.pageY - imageRect.top - scrollOffset.scrollTop;

        if (relativeX >= 0 && relativeX <= imageRect.width && 
            relativeY >= 0 && relativeY <= imageRect.height) {
          const markers = [...this.data.markers, { x: relativeX, y: relativeY }];
          this.setData({ 
            markers, 
            manualPoints: this.data.manualPoints + 1 
          }, this._recalc);
        }
      }
    });
  },

  undoPoint() {
    if (this.data.markers.length === 0) return;
    const markers = this.data.markers.slice(0, -1);
    this.setData({ markers, manualPoints: this.data.manualPoints - 1 }, this._recalc);
  },

  _clearManual() {
    this.setData({ 
      markers: [], 
      manualPoints: 0,
      backendMarkers: [],
      imageScale: 1,
      translateX: 0,
      translateY: 0,
    }, this._recalc);
    this._resetGesture();
  },

  _resetGesture() {
    this.gesture = {
      mode: 'none',
      startScale: 1,
      startDist: 0,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      pivotX: 0,
      pivotY: 0,
      baseTransX: 0,
      baseTransY: 0,
    };
  },

  _recalc() {
    const total = this.data.baseCount + this.data.manualPoints;
    const diff = this.data.target - total;
    this.setData({
      totalCount: total,
      diffAbs: Math.abs(diff),
      diffPrefix: diff < 0 ? '多' : '少',
      diffSignClass: diff < 0 ? 'plus' : 'minus',
    });
  },

  // ========== 质量检测 ==========

  startQualityDetect() {
    const hasImg = this.data.hasImage || !!this.data.displayImageUrl;
    if (!hasImg) {
      wx.showToast({ title: '请先识别种子图片', icon: 'none' });
      return;
    }
    if (this.data.qualityLoading || this.data.uploading) return;
    this.setData({ qualityLoading: true });

    // 把编号画在原图上再发给 ERNIE：ERNIE 直接从图中读数字 → 返回编号 → 用 YOLO 精确坐标打点
    // 比让 ERNIE 估算坐标或做文字坐标映射都更可靠
    this._createNumberedImage((numberedPath) => {
      if (numberedPath) {
        this._isNumberedImage = true;
        this._runQualityVision(numberedPath, false);
      } else {
        // 回退：画图失败时压缩原图
        this._isNumberedImage = false;
        const srcPath = this.currentFilePath || this.data.displayImageUrl;
        wx.compressImage({
          src: srcPath, quality: 80,
          success: (res) => this._runQualityVision(res.tempFilePath, false),
          fail:    ()    => this._runQualityVision(srcPath, false),
        });
      }
    });
  },

  // 把 YOLO 检测到的每粒种子的编号（白字黑边）叠加在原图上
  // ERNIE 直接读取图中编号 → 返回 indices → 客户端用 YOLO 精确坐标定位
  _createNumberedImage(callback) {
    const srcPath = this.currentFilePath || this.data.displayImageUrl;
    const yoloDets = this.yoloDetections || [];
    if (!srcPath || !yoloDets.length) { callback(null); return; }

    wx.getImageInfo({
      src: srcPath,
      success: (info) => {
        const W = info.width, H = info.height;
        const MAX_DIM = 800;
        const scale = Math.min(1, MAX_DIM / Math.max(W, H));
        const nW = Math.round(W * scale), nH = Math.round(H * scale);

        wx.createSelectorQuery().in(this).select('#cutCanvas').node((res) => {
          const canvas = res && res.node;
          if (!canvas) { callback(null); return; }
          canvas.width = nW;
          canvas.height = nH;
          const ctx = canvas.getContext('2d');
          const img = canvas.createImage();

          img.onload = () => {
            ctx.drawImage(img, 0, 0, nW, nH);
            // 字号随种子密度缩放，保证数字不重叠且可读
            const fSize = Math.max(7, Math.min(15, Math.round(nW / Math.sqrt(yoloDets.length) * 0.22)));
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `bold ${fSize}px sans-serif`;

            yoloDets.forEach((det, i) => {
              const x = det.nx * nW;
              const y = det.ny * nH;
              const label = String(i + 1);
              // 黑色描边
              ctx.strokeStyle = 'rgba(0,0,0,0.9)';
              ctx.lineWidth = Math.max(1, Math.round(fSize * 0.28));
              ctx.strokeText(label, x, y);
              // 白色填充
              ctx.fillStyle = '#FFFFFF';
              ctx.fillText(label, x, y);
            });

            wx.canvasToTempFilePath({
              canvas, fileType: 'jpg', quality: 0.82,
              success: (r) => {
                console.log(`[质检] 编号图生成: ${yoloDets.length}粒, ${nW}×${nH}`);
                callback(r.tempFilePath);
              },
              fail: (e) => { console.warn('[质检] 编号图失败:', e); callback(null); }
            });
          };
          img.onerror = () => callback(null);
          img.src = srcPath;
        }).exec();
      },
      fail: () => callback(null)
    });
  },

  /**
   * 逐粒裁图 → 编号网格拼贴 → 供 VLM 近距离逐粒判断缺陷。
   * 使用页面内 #cutCanvas 真实节点，避免 offscreen canvas 兼容性问题。
   * 超过 MAX_SEEDS 时按等间隔采样，并把采样序列存入 this._sampledDets
   * 供后续 seed_indices 映射回 YOLO 坐标使用。
   *
   * @param {Function} callback (collagePath: string|null, isCollage: boolean) => void
   */
  _cropCollageSeeds(callback) {
    // 1. 采样
    // MAX_SEEDS 24：每格 84px 显示区，VLM 能清晰看到种子纹理和形状细节
    const MAX_SEEDS = 24;
    const allDets   = this.yoloDetections || [];
    let sampledDets;
    if (allDets.length <= MAX_SEEDS) {
      sampledDets = allDets.map((d, i) => ({ ...d, origIdx: i }));
    } else {
      const step  = Math.ceil(allDets.length / MAX_SEEDS);
      sampledDets = [];
      for (let i = 0; i < allDets.length && sampledDets.length < MAX_SEEDS; i += step) {
        sampledDets.push({ ...allDets[i], origIdx: i });
      }
    }
    this._sampledDets = sampledDets;

    const srcPath = this.currentFilePath || this.data.displayImageUrl;
    if (!srcPath) { callback(null, false); return; }

    wx.getImageInfo({
      src: srcPath,
      success: (info) => {
        const W = info.width;
        const H = info.height;
        const n = sampledDets.length;

        const cropRadius = Math.min(
          Math.max(Math.round(Math.sqrt(W * H / Math.max(allDets.length, 1) * 0.25 / Math.PI)), 20),
          Math.round(Math.min(W, H) * 0.12)
        );
        const srcSize = cropRadius * 2;

        const CELL = 88;
        const PAD  = 2;
        const DISP = CELL - PAD * 2; // 84px 实际绘图区，ERNIE 能看清形状和纹理
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const canvasW = cols * CELL;
        const canvasH = rows * CELL;

        wx.createSelectorQuery().in(this).select('#cutCanvas').node((res) => {
          const canvas = res && res.node;
          if (!canvas) {
            console.error('[拼图] 未找到 #cutCanvas 节点');
            callback(null, false);
            return;
          }
          canvas.width  = canvasW;
          canvas.height = canvasH;
          const ctx = canvas.getContext('2d');
          const img = canvas.createImage();

          img.onload = () => {
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, canvasW, canvasH);
            const fSize = Math.max(9, Math.round(DISP * 0.2));

            sampledDets.forEach((det, i) => {
              const col  = i % cols;
              const row  = Math.floor(i / cols);
              const dstX = col * CELL + PAD;
              const dstY = row * CELL + PAD;

              const cx   = det.nx * W;
              const cy   = det.ny * H;
              const srcX = Math.max(0, Math.round(cx - cropRadius));
              const srcY = Math.max(0, Math.round(cy - cropRadius));
              const sw   = Math.min(srcSize, W - srcX);
              const sh   = Math.min(srcSize, H - srcY);

              ctx.drawImage(img, srcX, srcY, sw, sh, dstX, dstY, DISP, DISP);

              ctx.strokeStyle = 'rgba(255,255,255,0.25)';
              ctx.lineWidth   = 1;
              ctx.strokeRect(dstX, dstY, DISP, DISP);

              const label  = String(i + 1);
              const badgeW = fSize * (label.length * 0.62 + 0.6);
              ctx.fillStyle = 'rgba(0,0,0,0.8)';
              ctx.fillRect(dstX, dstY, badgeW, fSize + 4);
              ctx.fillStyle    = '#FFE500';
              ctx.font         = `bold ${fSize}px sans-serif`;
              ctx.textAlign    = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(label, dstX + 1, dstY + 2);
            });

            wx.canvasToTempFilePath({
              canvas,
              fileType: 'jpg',
              quality:  0.72,
              success: (r) => {
                console.log(`[拼图] 成功，${n}粒 → ${canvasW}×${canvasH}，路径:`, r.tempFilePath);
                callback(r.tempFilePath, true);
              },
              fail: (e) => {
                console.error('[拼图] canvasToTempFilePath 失败:', e);
                callback(null, false);
              },
            });
          };
          img.onerror = (e) => {
            console.error('[拼图] 加载原图失败:', e, srcPath);
            callback(null, false);
          };
          img.src = srcPath;
        }).exec();
      },
      fail: (e) => {
        console.error('[拼图] getImageInfo 失败:', e);
        callback(null, false);
      },
    });
  },

  _runQualityVision(filePath, isCollage) {
    this.setData({ showQualityPanel: false, qualityResult: null });
    wx.showLoading({ title: '质量检测中…', mask: true });

    // 确认文件存在
    try {
      wx.getFileSystemManager().accessSync(filePath);
    } catch (e) {
      this.setData({ qualityLoading: false });
      wx.hideLoading();
      wx.showToast({ title: '图片已失效，请重新识别', icon: 'none', duration: 2500 });
      return;
    }

    // ★ 直接读 base64，跳过云存储上传（省去 uploadFile + getTempFileURL，节省 2~3s）
    let imageBase64 = '';
    try {
      const b64 = wx.getFileSystemManager().readFileSync(filePath, 'base64');
      imageBase64 = `data:image/jpeg;base64,${b64}`;
    } catch (e) {
      console.warn('[质检] 读取 base64 失败，回退云存储上传:', e);
    }

    const _doCallFunction = (fileID) => {
        wx.showLoading({ title: '质量检测中…', mask: true });
        const totalCount = this.data.totalCount || 0;
        const yoloDetections = this.yoloDetections || [];
        const hasYoloPos = yoloDetections.length >= 1;

        let question;
        if (isCollage && hasYoloPos) {
          const n = (this._sampledDets || yoloDetections).length;
          question =
            `图为${n}粒种子裁图，每格左上角数字为编号1~${n}。` +
            `第一步：观察所有格子，确定数量最多的种子的颜色、形状和大小，作为主体品种基准。` +
            `第二步：找"其他粒"（杂粒）——与主体品种明显不同的少数种子（通常只有极少数）：` +
            `必须同时考虑颜色+形状，颜色明显不同或形状类型明显不同（如圆形vs椭圆、细长vs宽扁）才算。` +
            `同品种内正常的深浅变化、大小微差、角度不同、自然阴影不算其他粒。` +
            `第三步：在主体品种种子中找"缺陷粒"——有明确物理损伤：黑绿霉斑、裂口破角、虫蛀孔、严重干瘪。` +
            `表面纹路/颜色渐变/轻微大小差异不算缺陷。` +
            `若某粒既有外观差异又有损伤，优先归其他粒。正常粒不填入JSON。只输出JSON：` +
            `{"defect_details":[` +
            `{"label":"缺陷粒","count":0,"ratio_pct":0,"color":"#FF6D00","seed_indices":[]},` +
            `{"label":"其他","count":0,"ratio_pct":0,"color":"#795548","seed_indices":[]}]}`;
        } else if (this._isNumberedImage) {
          // 编号图模式：ERNIE 直接从图中读数字 → 返回编号 → 精确 YOLO 坐标打点
          question =
            `图中约${totalCount}粒种子，每粒上叠加了白色编号。` +
            `第一步：确定多数种子的颜色+形状作为主体品种基准。` +
            `第二步：找"其他粒"——与主体颜色或形状类型明显不同的少数种子（同作物不同品种也算）；` +
            `同品种内的深浅渐变/大小微差/角度/阴影不算。` +
            `第三步：在主体品种中找"缺陷粒"——有明确损伤：霉斑/裂缝/破角/虫蛀/干瘪；` +
            `自然纹路/颜色深浅/大小差异不算缺陷。` +
            `若某粒既有外观差异又有损伤，优先归其他粒。` +
            `读取各类编号，没有则[]。严格只输出JSON：` +
            `{"defect_details":[{"label":"缺陷粒","color":"#FF6D00","indices":[]},{"label":"其他","color":"#795548","indices":[]}]}`;
        } else {
          // 回退：无 YOLO 数据时用坐标 positions 方式
          question =
            `图中约${totalCount}粒种子。仔细找出：` +
            `"缺陷粒"=与主体同品种但有霉斑/裂纹/破损/虫蛀/干瘪；` +
            `"其他粒"=与多数种子在颜色、形状或大小上有可见差异的种子（不同品种均算），` +
            `如颜色偏深/偏浅、形状更圆/更细长、或大小明显偏小。请仔细寻找。` +
            `若某粒既像其他粒又像缺陷粒，优先判为其他粒。` +
            `给出每粒归一化坐标(x右→1,y下→1)。严格只输出JSON：` +
            `{"defect_details":[{"label":"缺陷粒","color":"#FF6D00","positions":[]},{"label":"其他","color":"#795548","positions":[]}]}`;
        }

      wx.cloud.callFunction({
          name: 'vision_diagnose',
          data: { fileID, imageBase64, question },
          success: (res) => {
            const text = res.result?.text || '';
            console.log('[质检] VLM完整响应:', text);
            try {
              let jsonStr = '';
              const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
              if (fenceMatch) {
                jsonStr = fenceMatch[1].trim();
              } else {
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start !== -1 && end > start) jsonStr = text.slice(start, end + 1);
              }
              if (!jsonStr) throw new Error('no JSON');
              const result = JSON.parse(jsonStr);

              // 过滤掉 ERNIE 可能自行添加的"正常粒"条目，正常粒由客户端计算
              result.defect_details = (result.defect_details || []).filter(
                d => d.label !== '正常粒' && d.label !== '正常'
              );

              // 从 positions/indices/seed_indices 长度补全 count
              result.defect_details.forEach(d => {
                const posCount  = Array.isArray(d.positions)    ? d.positions.length    : 0;
                const idxCount  = Array.isArray(d.indices)      ? d.indices.length      : 0;
                const sIdxCount = Array.isArray(d.seed_indices) ? d.seed_indices.length : 0;
                d.count = posCount || idxCount || sIdxCount || (d.count || 0);
              });

              // 总粒数直接用 YOLO 识别数，不信任 AI 的 total_count
              const yoloTotal = this.data.totalCount || 0;
              const defectTotal = result.defect_details.reduce((s, d) => s + (d.count || 0), 0);
              result.total_count = yoloTotal;
              result.normal_count = Math.max(0, yoloTotal - defectTotal);
              result.pass_rate_pct = yoloTotal > 0
                ? Math.round(result.normal_count / yoloTotal * 10000) / 100
                : 0;
              // 各类占比重算
              result.defect_details.forEach(d => {
                d.ratio_pct = yoloTotal > 0 ? Math.round((d.count || 0) / yoloTotal * 10000) / 100 : 0;
              });
              // 重新计算等级
              result.quality_grade = result.pass_rate_pct >= 95 ? '一级'
                : result.pass_rate_pct >= 85 ? '二级' : '三级';

              const imgW = this.data.imgW || 1;
              const imgH = this.data.imgH || 1;
              const mappingDets = isCollage
                ? (this._sampledDets || this.yoloDetections || [])
                : (this.yoloDetections || []);
              const allDets = this.yoloDetections || [];
              const defectMarkers = [];

              (result.defect_details || []).forEach(d => {
                if (!d.count) return;
                const color = d.color || '#F59E0B';
                const label = d.label || '';

                if (Array.isArray(d.seed_indices) && d.seed_indices.length > 0 && mappingDets.length > 0) {
                  // 拼图模式：seed_indices → 采样后的 YOLO 坐标
                  d.seed_indices.forEach(idx => {
                    if (!Number.isInteger(idx) || idx < 1 || idx > mappingDets.length) return;
                    const sampledDet = mappingDets[idx - 1];
                    const det = (isCollage && sampledDet.origIdx != null)
                      ? (allDets[sampledDet.origIdx] || sampledDet) : sampledDet;
                    defectMarkers.push({ x: det.nx * imgW, y: det.ny * imgH, color, label });
                  });

                } else if (Array.isArray(d.indices) && d.indices.length > 0 && allDets.length > 0) {
                  // 全图模式（新）：ERNIE 返回编号 → 直接用 YOLO 精确坐标打点
                  d.indices.forEach(idx => {
                    if (!Number.isInteger(idx) || idx < 1 || idx > allDets.length) return;
                    const det = allDets[idx - 1];
                    defectMarkers.push({ x: det.nx * imgW, y: det.ny * imgH, color, label });
                  });

                } else if (Array.isArray(d.positions) && d.positions.length > 0) {
                  // 兜底：ERNIE 返回坐标时直接使用（处理像素坐标归一化）
                  const anyLarge = d.positions.some(p => Number(p.x) > 2 || Number(p.y) > 2);
                  const maxX = anyLarge ? Math.max(...d.positions.map(p => Number(p.x))) : 1;
                  const maxY = anyLarge ? Math.max(...d.positions.map(p => Number(p.y))) : 1;
                  d.positions.forEach(pos => {
                    if (pos.x == null || pos.y == null) return;
                    const nx = anyLarge ? Number(pos.x) / (maxX * 1.05) : Number(pos.x);
                    const ny = anyLarge ? Number(pos.y) / (maxY * 1.05) : Number(pos.y);
                    defectMarkers.push({ x: nx * imgW, y: ny * imgH, color, label });
                  });
                }
              });

              console.log('[质检] defectMarkers数量:', defectMarkers.length, defectMarkers.slice(0,3));
              console.log('[质检] imgW/H:', this.data.imgW, this.data.imgH);
              this.setData({ qualityResult: result, showQualityPanel: true, defectMarkers });
              const defectSummary = (result.defect_details || [])
                .filter(d => d.count > 0).map(d => `${d.label}${d.count}`).join(' ') || '无缺陷';
              this._saveHistory({
                qualityGrade: result.quality_grade || '',
                passRatePct:  result.pass_rate_pct  || 0,
                normalCount:  result.normal_count   || 0,
                defectSummary
              });
            } catch (e) {
              console.error('[质检] 解析失败:', e.message, '\n原始响应:', text);
              wx.showToast({ title: '模型返回格式异常，请重试', icon: 'none', duration: 2500 });
            }
          },
          fail: (err) => {
            console.error('vision_diagnose调用失败:', err);
            wx.showToast({ title: '质量检测失败，请检查网络', icon: 'none', duration: 2500 });
          },
          complete: () => {
            this.setData({ qualityLoading: false });
            wx.hideLoading();
            // 有 fileID 时才删除云存储（base64 模式无文件需删）
            if (fileID) wx.cloud.deleteFile({ fileList: [fileID], fail: () => {} });
          }
        });
    };

    // base64 读取成功则直接调用，跳过云存储上传（节省 2~3s）
    if (imageBase64) {
      _doCallFunction(null);
    } else {
      // 回退：base64 读取失败时走云存储上传
      const cloudPath = `quality_temp/${Date.now()}.jpg`;
      wx.cloud.uploadFile({
        cloudPath, filePath,
        success: ({ fileID }) => _doCallFunction(fileID),
        fail: (err) => {
          console.error('图片上传云存储失败:', err);
          this.setData({ qualityLoading: false });
          wx.hideLoading();
          wx.showToast({ title: '图片上传失败，请重试', icon: 'error' });
        }
      });
    }
  },

  // 统一写历史（防重复计数记录，质检结果可更新）
  _saveHistory(qualityExtra) {
    const d = this.data;
    if (this._historySaved) {
      // 计数记录已存在，仅更新质检字段
      if (qualityExtra && this._currentHistoryId) {
        seedHistoryStore.updateHistoryById(this._currentHistoryId, qualityExtra);
      }
      return;
    }
    const record = seedHistoryStore.addHistory({
      source: 'seedCount',
      totalCount: d.totalCount,
      manualPoints: d.manualPoints || 0,
      target: d.target,
      diff: d.target - d.totalCount,
      ...(qualityExtra || {})
    });
    if (record) {
      this._currentHistoryId = record.id;
      this._historySaved = true;
    }
  },

  // 页面隐藏时同步最新计数（含手动补点）到历史记录
  onHide() {
    if (!this.data.hasImage) return;
    if (!this._historySaved) {
      // 首次保存
      this._saveHistory(null);
    } else if (this._currentHistoryId) {
      // 已保存过（可能后续又加/撤了手动补点），同步更新
      seedHistoryStore.updateHistoryById(this._currentHistoryId, {
        totalCount: this.data.totalCount,
        manualPoints: this.data.manualPoints || 0,
        diff: this.data.target - this.data.totalCount,
      });
    }
  },

  noop() {},

  closeQualityPanel() {
    this.setData({ showQualityPanel: false });
  },

  // 新增：允许用户分享页面
  onShareAppMessage() {
    return {
      title: '智种计 - 智能种子计数助手 🌱',
      path: '/pages/index/index',
      imageUrl: '/assets/share-cover.jpg', // 自定义封面图（需项目中存在）
    };
  },

  // 新增：分享到朋友圈
  onShareTimeline() {
    return {
      title: '智种计 - 智能AI种子计数助手',
      query: 'from=timeline'
    };
  },
});


