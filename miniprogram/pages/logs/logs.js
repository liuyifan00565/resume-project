// pages/index/index.js

const API_URL = 'https://yolo.kzehealth.com/api/seedcount';

Page({
  data: {
    target: 100,
    baseCount: 0,
    manualPoints: 0,
    displayImageUrl: '',
    imgW: 0,
    imgH: 0,
    markers: [],           // 用户手动添加的标记点
    backendMarkers: [],    // 后端识别返回的标记点
    totalCount: 0,
    diffAbs: 0,
    diffPrefix: '少',
    diffSignClass: 'minus',
    locked: false,
    uploading: false,
    showCamera: false,
    
    // 🆕 图片缩放相关
    imageScale: 1,         // 当前缩放比例
    imageScalePercent: 100,
    imageX: 0,             // 图片 X 位置
    imageY: 0,             // 图片 Y 位置
    
    // 🆕 相机缩放相关
    cameraZoom: 1,         // 相机缩放倍数
    maxZoom: 3,            // 最大缩放倍数
    cameraContext: null,   // 相机上下文
  },

  onLoad() {
    this._recalc();
  },

  setTarget100() { this.setData({ target: 100 }, this._recalc); },
  setTarget200() { this.setData({ target: 200 }, this._recalc); },
  
  onTargetInput(e) {
    const v = parseInt(e.detail.value, 10);
    this.setData({ target: Number.isFinite(v) ? v : 0 }, this._recalc);
  },

  selectFromAlbum() {
    if (this.data.locked) return;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath;
        this._uploadAndAnalyze(path);
      }
    });
  },

  takePhoto() {
    if (this.data.locked) return;
    this.setData({ 
      showCamera: true,
      cameraZoom: 1  // 重置缩放
    }, () => {
      // 延迟初始化相机上下文，确保 camera 组件已渲染
      setTimeout(() => {
        this._initCameraContext();
      }, 300);
    });
  },

  closeCameraView() {
    this.setData({ 
      showCamera: false,
      cameraZoom: 1
    });
  },

  // 🆕 相机准备就绪回调
  onCameraReady(e) {
    console.log('✅ 相机初始化完成', e);
    this._initCameraContext();
    
    // 获取相机支持的最大缩放倍数
    if (e.detail && e.detail.maxZoom) {
      this.setData({ maxZoom: Math.min(e.detail.maxZoom, 5) });
      console.log('✅ 相机最大缩放:', this.data.maxZoom);
    }
  },

  // 🆕 相机错误回调
  onCameraError(e) {
    console.error('❌ 相机错误:', e);
    wx.showToast({ title: '相机启动失败', icon: 'error' });
  },

  // 🆕 初始化相机上下文
  _initCameraContext() {
    if (!this.data.cameraContext) {
      this.data.cameraContext = wx.createCameraContext();
      console.log('✅ 相机上下文已创建');
    }
  },

  // 🆕 缩放滑块变化（实时预览）
  onZoomChanging(e) {
    const zoom = e.detail.value;
    this.setData({ cameraZoom: zoom });
    this._applyCameraZoom(zoom);
  },

  // 🆕 缩放滑块变化完成
  onZoomChange(e) {
    const zoom = e.detail.value;
    this.setData({ cameraZoom: zoom });
    this._applyCameraZoom(zoom);
  },

  // 🆕 应用相机缩放
  _applyCameraZoom(zoom) {
    if (this.data.cameraContext) {
      this.data.cameraContext.setZoom({
        zoom: zoom,
        success: () => {
          console.log('✅ 相机缩放成功:', zoom);
        },
        fail: (err) => {
          console.error('❌ 相机缩放失败:', err);
        }
      });
    }
  },

  _snapAndAnalyze() {
    if (this.data.locked) return;
    
    if (!this.data.cameraContext) {
      this._initCameraContext();
    }
    
    this.data.cameraContext.takePhoto({
      quality: 'high',
      success: (res) => {
        this.setData({ 
          showCamera: false,
          cameraZoom: 1
        });
        this._uploadAndAnalyze(res.tempImagePath);
      },
      fail: (err) => {
        console.error('❌ 拍照失败:', err);
        wx.showToast({ title: '拍照失败', icon: 'error' });
      }
    });
  },

  _uploadAndAnalyze(filePath) {
    if (this.data.uploading) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '识别中', mask: true });

    this._clearManual();

    // 保存原始图片路径
    const originalPath = filePath;

    wx.uploadFile({
      url: API_URL,
      name: 'file',
      filePath,
      success: ({ data }) => {
        console.log('========== 后端响应 ==========');
        console.log('原始数据:', data);
        
        try {
          const resp = JSON.parse(data || '{}');
          console.log('解析后的完整对象:', resp);
          
          const count = +resp.count || 0;
          const dataUrl = resp.image_base64 || '';
          const detections = []; // 后端暂未返回具体坐标

          
          // 规范化坐标格式：统一转换为 {x, y} 格式
          const normalizedMarkers = detections.map ? detections.map(d => ({
            x: d.x || d.center_x || 0,
            y: d.y || d.center_y || 0
          })) : [];
          
          
          console.log('========== 解析结果 ==========');
          console.log('种子数量:', count);
          console.log('检测点数量:', normalizedMarkers.length);
          console.log('Data URL长度:', dataUrl.length);
          
          // 🔧 修复方案1: 如果返回了 data URL,先尝试将其保存为本地文件
          if (dataUrl && dataUrl.startsWith('data:image')) {
            this._saveDataUrlToLocal(dataUrl, (savedPath) => {
              if (savedPath) {
                console.log('✅ Data URL 已保存为本地文件:', savedPath);
                this._updateImageData(count, savedPath, normalizedMarkers);
              } else {
                console.log('⚠️ Data URL 保存失败,使用原图 + 覆盖层');
                this._updateImageData(count, originalPath, normalizedMarkers);
              }
            });
          } else {
            // 没有 data URL,使用原图 + 覆盖层显示标记点
            console.log('⚠️ 后端未返回标记图像,使用原图 + 覆盖层');
            this._updateImageData(count, originalPath, normalizedMarkers);
          }
          
        } catch (error) {
          console.error('❌ 解析响应失败:', error);
          wx.showToast({ title: '数据解析失败', icon: 'error' });
        }
      },
      fail: (err) => {
        console.error('❌ 上传失败:', err);
        wx.showToast({ title: '识别失败,请重试', icon: 'none' });
      },
      complete: () => {
        this.setData({ uploading: false });
        wx.hideLoading();
        console.log('========== 请求完成 ==========');
      },
    });
  },

  // 🔧 新增：将 Data URL 保存为本地临时文件
  _saveDataUrlToLocal(dataUrl, callback) {
    try {
      // 提取 base64 数据
      const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) {
        console.error('❌ Data URL 格式不正确');
        callback(null);
        return;
      }

      const imageType = matches[1]; // png, jpeg, etc.
      const base64Data = matches[2];

      // 将 base64 转换为 ArrayBuffer
      const binaryString = wx.base64ToArrayBuffer(base64Data);
      
      // 写入临时文件
      const fs = wx.getFileSystemManager();
      const fileName = `temp_marked_${Date.now()}.${imageType}`;
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

      fs.writeFile({
        filePath: filePath,
        data: binaryString,
        encoding: 'binary',
        success: () => {
          console.log('✅ 文件保存成功:', filePath);
          callback(filePath);
        },
        fail: (err) => {
          console.error('❌ 文件保存失败:', err);
          callback(null);
        }
      });
    } catch (error) {
      console.error('❌ Data URL 处理失败:', error);
      callback(null);
    }
  },

  // 🔧 新增：统一更新图像数据的方法
  _updateImageData(count, imagePath, markers) {
    this.setData({
      baseCount: count,
      displayImageUrl: imagePath,
      backendMarkers: markers,
      markers: [],
      imgW: 0,
      imgH: 0,
      imageScale: 1,  // 重置缩放
      imageX: 0,
      imageY: 0,
    }, () => {
      this._recalc();
      wx.showToast({ 
        title: `识别完成: ${count}粒`, 
        icon: 'success', 
        duration: 2000 
      });
      console.log('✅ 数据已更新,图片路径:', imagePath);
      console.log('✅ 标记点数量:', markers.length);
    });
  },

  onImageLoad(e) {
    const { width, height } = e.detail;
    if (width && height) {
      this.setData({ imgW: width, imgH: height });
      console.log('✅ 图片加载成功:', { width, height });
    }
  },

  onImageError(e) {
    console.error('❌ 图片加载失败:', e.detail);
    wx.showToast({ title: '图片加载失败', icon: 'error' });
  },

  // 🆕 图片缩放事件
  onImageScale(e) {
    const scale = e.detail.scale;
    this.setData({ imageScale: scale, imageScalePercent: Math.round(scale * 100) });
    console.log('✅ 图片缩放:', scale);
  },

  // 🆕 图片移动事件
  onImageMove(e) {
    this.setData({
      imageX: e.detail.x,
      imageY: e.detail.y
    });
  },

  // 🆕 防止移动事件冒泡
  preventMove(e) {
    // 阻止事件冒泡，让 movable-view 可以正常工作
    return false;
  },

  previewImage() {
    if (this.data.displayImageUrl) {
      wx.previewImage({ urls: [this.data.displayImageUrl] });
    }
  },

  // 🔧 修复：正确计算相对于覆盖层的坐标
  onImageTap(e) {
    if (!this.data.displayImageUrl) return;
    
    // 考虑缩放比例，计算实际点击位置
    const scale = this.data.imageScale;
    const touch = e.touches[0];
    
    // 获取点击位置相对于图片的坐标
    const query = wx.createSelectorQuery();
    query.select('.overlay').boundingClientRect();
    query.exec((res) => {
      if (res && res[0]) {
        const rect = res[0];
        
        // 计算相对于覆盖层的坐标
        let x = touch.clientX - rect.left;
        let y = touch.clientY - rect.top;
        
        // 考虑缩放和偏移
        x = x / scale;
        y = y / scale;
        
        console.log('========== 点击坐标 ==========');
        console.log('屏幕坐标:', { clientX: touch.clientX, clientY: touch.clientY });
        console.log('覆盖层位置:', { left: rect.left, top: rect.top });
        console.log('缩放比例:', scale);
        console.log('相对坐标:', { x, y });
        console.log('图片尺寸:', { imgW: this.data.imgW, imgH: this.data.imgH });
        
        // 确保坐标在图片范围内
        if (x >= 0 && x <= this.data.imgW && y >= 0 && y <= this.data.imgH) {
          const markers = [...this.data.markers, { x, y }];
          this.setData({ 
            markers, 
            manualPoints: this.data.manualPoints + 1 
          }, this._recalc);
          
          console.log('✅ 添加标记点:', { x, y });
        } else {
          console.log('⚠️ 点击位置超出图片范围');
        }
      }
    });
  },

  undoPoint() {
    if (this.data.markers.length === 0) return;
    const markers = this.data.markers.slice(0, -1);
    this.setData({ 
      markers, 
      manualPoints: this.data.manualPoints - 1 
    }, this._recalc);
    console.log('✅ 撤销标记点,剩余:', markers.length);
  },

  _clearManual() {
    this.setData({ 
      markers: [], 
      manualPoints: 0,
      backendMarkers: [],
      imageScale: 1,  // 重置缩放
      imageX: 0,
      imageY: 0,
    }, this._recalc);
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
});
