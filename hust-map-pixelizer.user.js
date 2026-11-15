// ==UserScript==
// @name         HUST Map Pixelizer · 校园地图像素化框选工具
// @namespace    hust-map-pixelizer
// @version      0.7.1
// @description  在校园地图（ArcGIS）上拖拽框选，按可配置比例尺与旋转角生成 Minecraft 方块网格的像素化视图；颜色优先取自矢量要素，底图经 takeScreenshot 兜底采样
// @match        https://map.hust.edu.cn/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 幂等注入：清理旧实例
  ['cmpx-style', 'cmpx-panel', 'cmpx-overlay'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  // ================== 配置 ==================
    const CFG_KEY = 'cmpx-config-v2';   // v2：默认采样方式改为众数；升版使新默认对老用户生效（旧自定义配置随之重置）
    const DEFAULT_CFG = {
      scale: 1.1,        // 比例尺：1 实地米 = MC 中 scale 格（1 格 = 1 方块）
      rotation: 0,       // 采样网格旋转角（度，正值顺时针）
      mppManual: null,   // 手动校准的 米/像素；null = 自动
      sampleMode: 'mode',  // 底图采样方式：point 单点 | mean 均值 | median 中位数 | mode 众数（默认）
    };
  const MAX_CELLS = 40000;
  const MAX_FEATURES_PER_LAYER = 3000;
  // Tampermonkey 在 document-idle 注入时，地图 App 的 ArcGIS 引擎往往尚未初始化完成，
  // window.view2D 那一刻还不存在，因此必须等待就绪后再装配工具
  const VIEW_WAIT_MS = 60000;
  // 全局网格基准点（WebMercator 投影米，取校园附近的整数值）。
  // 网格划分在世界坐标系下以此点为原点、按比例尺定格距、绕此点旋转——
  // 因此建筑采样分块只受 比例尺/旋转角（与本常量）影响，与拖框偏差、缩放级别无关。
  // ⚠ 团队所有人必须使用同一脚本版本（基准点一致），否则各人导出的像素图无法相互对齐。
  const GRID_DATUM = { x: 12736000, y: 3570000 };

  // ================== ArcGIS 接入 ==================
  function findView() {
    for (const k of ['view2D', 'view', 'mapView', 'mainView', 'theView']) {
      const v = window[k];
      if (v && v.declaredClass && /esri\.views/.test(v.declaredClass)) return v;
    }
    try {
      for (const k of Object.getOwnPropertyNames(window)) {
        const v = window[k];
        if (v && v.declaredClass && /esri\.views\.(Map|Scene)View/.test(v.declaredClass)) return v;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // 等待地图引擎就绪（view 存在、图层已加载、分辨率有效）后装配
  boot(0);
  function boot(attempt) {
    const v = findView();
    const ready = v && v.map && v.map.layers && v.map.layers.length > 0
      && isFinite(v.resolution) && v.resolution > 0;
    if (!ready) {
      if (attempt * 300 >= VIEW_WAIT_MS) {
        console.warn('[cmpx] 等待 ArcGIS MapView 就绪超时（' + VIEW_WAIT_MS + 'ms），工具未加载');
        return;
      }
      setTimeout(() => boot(attempt + 1), 300);
      return;
    }
    init(v);
  }

  function init(viewRef) {
    let view = viewRef;   // pixelize 时会重新探测，避免 2D/3D 切换等场景拿到失效实例

    let cfg = loadCfg();
    let armed = false, dragging = false, pixelizing = false;
    let selStart = null, selRect = null, lastResult = null;
    let mppSource = '—';

    function loadCfg() {
      try {
        return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(CFG_KEY) || '{}')) };
      } catch (e) { return { ...DEFAULT_CFG }; }
    }
    function saveCfg() {
      try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
    }

    // 真实地面距离口径的 米/像素（与地图比例尺条/测距工具一致，已实测校验）：
    //  - WebMercator：resolution 是投影米/像素，在纬度 φ 处真实地面距离 = 投影距离 × cos(φ)，必须校正
    //    （武汉 cos30.5°≈0.861，不校正会多算 ~16% 的方块数）
    //  - 地理坐标系：resolution 是度/像素，×111320×cos(纬度)
    //  - 其他真米制投影坐标系：resolution 即米/像素
    function mppFromView() {
      try {
        if (!isFinite(view.resolution) || view.resolution <= 0) return null;
        const sr = view.spatialReference;
        const lat = view.center ? view.center.latitude : 30.5;
        const latRad = lat * Math.PI / 180;
        if (sr && sr.isWebMercator) return view.resolution * Math.cos(latRad);
        if (sr && sr.isGeographic) return view.resolution * 111320 * Math.cos(latRad);
        return view.resolution;
      } catch (e) { return null; }
    }

    // 兜底：页面比例尺控件文本（如 "0.3 km"）+ 控件像素宽度
    function mppFromScaleBar() {
      const rx = /^(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)\s*$/i;
      for (const el of document.querySelectorAll('div,span')) {
        if (el.children.length) continue;
        const m = (el.textContent || '').trim().match(rx);
        if (!m) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.width > 300 || r.height > 26 || r.height < 4) continue;
        let meters = parseFloat(m[1]);
        if (/^(公里|千米|km)$/i.test(m[2])) meters *= 1000;
        return meters / r.width;
      }
      return null;
    }

    function currentMpp() {
      if (cfg.mppManual > 0) { mppSource = '手动'; return cfg.mppManual; }
      const v = mppFromView();
      if (v) { mppSource = '视图分辨率(真实距离)'; return v; }
      const s = mppFromScaleBar();
      if (s) { mppSource = '比例尺控件'; return s; }
      mppSource = '无';
      return null;
    }

    // 可见要素图层（map.layers 索引 0 = 最底层；收集后反转成“顶层优先”）
    // 注意：listMode='hide' 仅表示该图层不出现在图层面板 UI 中，图层本身照常渲染，不能据此跳过（本校建筑层正是 hide）
    function collectFeatureLayers(layers, out) {
      layers.forEach((l) => {
        if (l.visible === false) return;
        if (l.type === 'feature') out.push(l);
        else if (l.type === 'group' && l.layers) collectFeatureLayers(l.layers, out);
      });
      return out;
    }

    // 查询选区范围内所有可见要素图层的要素（返回顺序 = 绘制顶层优先）
    // 注意：不传 quantizationParameters——'edit' 等量化模式返回的是量化坐标，与 toMap 的地图坐标不同系，会导致点在多边形判定全部失配
    async function queryFeaturesInExtent(extent) {
      const layers = collectFeatureLayers(view.map.layers, []).reverse();
      const geo = view.extent.clone();   // 借用真实 Extent 实例，避免依赖 AMD require
      geo.xmin = extent.xmin; geo.ymin = extent.ymin;
      geo.xmax = extent.xmax; geo.ymax = extent.ymax;
      const all = [];
      for (const layer of layers) {
        try {
          const res = await layer.queryFeatures({
            geometry: geo, returnGeometry: true, outFields: ['*'],
            num: MAX_FEATURES_PER_LAYER,
          });
          if (res && res.features) for (const f of res.features) all.push({ layer, feature: f });
        } catch (e) { /* 图层不可查询，跳过 */ }
      }
      return all;
    }

    // 点在多边形内：跨所有环做偶奇计数（外环 + 洞）
    function pointInRings(rings, x, y) {
      let inside = false;
      for (const ring of rings) {
        let cnt = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) cnt++;
        }
        if (cnt % 2 === 1) inside = !inside;
      }
      return inside;
    }

    function colorOfSymbol(sym) {
      if (!sym) return null;
      const norm = (c) => c && typeof c.r === 'number'
        ? [Math.round(c.r), Math.round(c.g), Math.round(c.b), c.a == null ? 1 : c.a] : null;
      const fill = norm(sym.color);
      if (fill && fill[3] > 0.05) return fill;
      const out = sym.outline ? norm(sym.outline.color) : null;
      if (out && out[3] > 0.05) return out;
      return null;
    }
    function cssColor(c) {
      return c[3] >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${c[3].toFixed(3)})`;
    }

    // 底图兜底：takeScreenshot（ArcGIS 自渲染，不受 WebGL buffer 限制）
    // ⚠ 不要通过临时隐藏图层来净化截图：切换 visible 会触发地图应用
    // （DisplayMap.js）的图层监视回调并抛出未捕获异常，导致地图此后
    // 不再刷新精度与文字标注（用户实测）。文字杂色由聚合时的
    // 低饱和偏暗像素过滤（SAMPLE_TEXT_LUM_MAX / SAMPLE_LABEL_MAXSAT）处理。
    async function takeShot() {
      try {
        const ss = await view.takeScreenshot({ format: 'png' });
        if (ss && ss.data && ss.data.width) return ss;
      } catch (e) { /* 忽略 */ }
      return null;
    }
      function sampleShot(ss, clientX, clientY) {
        const rect = view.container.getBoundingClientRect();
        const vx = clientX - rect.left, vy = clientY - rect.top;
        if (vx < 0 || vy < 0 || vx >= rect.width || vy >= rect.height) return null;
        const px = Math.min(ss.data.width - 1, Math.floor(vx * ss.data.width / rect.width));
        const py = Math.min(ss.data.height - 1, Math.floor(vy * ss.data.height / rect.height));
        const i = (py * ss.data.width + px) * 4, d = ss.data.data;
        return [d[i], d[i + 1], d[i + 2], d[i + 3] / 255];
      }

      // 世界坐标 → 页面客户区坐标：用 toMap 采样三点建立“屏幕→世界”仿射基并求逆，
      // 自动兼容视图旋转（view.rotation）等二维视图变换；不使用 view.toScreen（4.18 mobile 版有空引用异常）。
      // aff 在每次像素化/绘制时求一次（3 次 toMap），逐格换算用 affToClient（纯数学，快）。
      function getAffine() {
        const p0 = view.toMap({ x: 0, y: 0 });
        const px = view.toMap({ x: 100, y: 0 });
        const py = view.toMap({ x: 0, y: 100 });
        return {
          p0,
          bx: { x: (px.x - p0.x) / 100, y: (px.y - p0.y) / 100 },   // 屏幕 +x 方向的世界增量
          by: { x: (py.x - p0.x) / 100, y: (py.y - p0.y) / 100 },   // 屏幕 +y 方向的世界增量
        };
      }
      function affToClient(aff, wx, wy, vrect) {
        const dx = wx - aff.p0.x, dy = wy - aff.p0.y;
        const det = aff.bx.x * aff.by.y - aff.bx.y * aff.by.x;
        const lx = (dx * aff.by.y - dy * aff.by.x) / det;
        const ly = (aff.bx.x * dy - aff.by.x * dx) / det;
        return { x: lx + vrect.left, y: ly + vrect.top };
      }

      // 文字/标注像素过滤阈值：底图地名文字烙在瓦片里，为低饱和偏暗像素
      // （实测文字亮度 120-190、R≈G≈B；地面色——草地 219/路面 241/建筑米色 228——亮度均 ≥200 且有色彩倾向）
      const SAMPLE_TEXT_LUM_MAX = 200;   // 亮度低于此值视为疑似标注像素
      const SAMPLE_LABEL_MAXSAT = 24;    // 最大通道差低于此值视为低饱和（灰字特征）

    // ================== 样式与 UI ==================
    const style = document.createElement('style');
    style.id = 'cmpx-style';
    // 面板风格对齐校园地图官方 UI：白底卡片、浅灰描边、蓝色主按钮（#1677ff）、精简圆角
    style.textContent = `
#cmpx-panel { position: fixed; top: 16px; right: 16px; width: 300px; z-index: 2147483646;
  background: #fff; border: 1px solid #e4e7ed; border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0,0,0,.12); font: 13px/1.5 system-ui, sans-serif; color: #303133;
  user-select: none; }
#cmpx-panel .cmpx-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  background: #fff; color: #1677ff; border-bottom: 1px solid #e4e7ed; border-radius: 8px 8px 0 0; cursor: move; }
#cmpx-panel .cmpx-head b { flex: 1; font-size: 13px; }
#cmpx-panel .cmpx-head button { border: 0; background: transparent; color: #909399;
  width: 22px; height: 20px; border-radius: 4px; cursor: pointer; }
#cmpx-panel .cmpx-body { padding: 8px 10px 10px; }
#cmpx-panel label { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#cmpx-panel label span { flex: 0 0 88px; color: #606266; }
#cmpx-panel input[type=number] { width: 72px; padding: 2px 4px; border: 1px solid #dcdfe6;
  border-radius: 4px; font: inherit; color: #303133; }
#cmpx-panel select { padding: 2px 4px; border: 1px solid #dcdfe6; border-radius: 4px;
  font: inherit; color: #303133; background: #fff; }
#cmpx-panel .cmpx-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
#cmpx-panel button.cmpx-act { padding: 4px 10px; border: 1px solid #1677ff; border-radius: 4px;
  background: #1677ff; color: #fff; cursor: pointer; font: inherit; }
#cmpx-panel button.cmpx-act.on { background: #ff4d4f; border-color: #ff4d4f; }
#cmpx-panel button.cmpx-mini { padding: 4px 8px; border: 1px solid #dcdfe6; border-radius: 4px;
  background: #fff; color: #606266; cursor: pointer; font: inherit; }
#cmpx-panel .cmpx-mppinfo { color: #909399; font-size: 11px; flex: 1; }
/* 预览画布按原始像素尺寸显示（不压缩），超出面板部分滚动查看——
   否则 CSS 非整数倍缩放会把 1px 网格线压得忽粗忽细（此前“网格线不均匀”的原因） */
#cmpx-preview-wrap { max-width: 100%; max-height: 320px; overflow: auto; margin-top: 6px;
  border: 1px solid #999; background:
  repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
#cmpx-preview { display: block; image-rendering: pixelated; }
#cmpx-status { margin-top: 4px; color: #606266; font-size: 12px; min-height: 16px; }
#cmpx-overlay { position: fixed; inset: 0; z-index: 2147483645; display: none; pointer-events: none; }
#cmpx-overlay.cmpx-armed { pointer-events: auto; cursor: crosshair; }
`;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'cmpx-panel';
    panel.innerHTML = `
<div class="cmpx-head"><b>像素化框选 v0.7</b><button data-act="collapse" title="收起/展开">—</button></div>
<div class="cmpx-body">
  <div class="cmpx-row"><button class="cmpx-act" data-act="toggle">① 开始框选</button>
       <button class="cmpx-mini" data-act="export">导出图片</button>
       <button class="cmpx-mini" data-act="clear">清除</button></div>
  <label><span>比例尺 (格/米)</span><input type="number" id="cmpx-scale" step="0.05" min="0.1"></label>
  <label><span>旋转角 (°)</span><input type="number" id="cmpx-rot" step="0.1">
       <button class="cmpx-mini" data-act="rot-">−0.1</button><button class="cmpx-mini" data-act="rot+">+0.1</button></label>
  <label><span>底图采样</span><select id="cmpx-smode">
       <option value="point">单点（默认）</option>
       <option value="mean">均值</option>
       <option value="median">中位数</option>
       <option value="mode">众数</option>
  </select></label>
  <label><span>米/像素</span><input type="number" id="cmpx-mpp" step="0.01" min="0" placeholder="自动">
       <span class="cmpx-mppinfo" id="cmpx-mppinfo"></span></label>
  <div id="cmpx-preview-wrap"><canvas id="cmpx-preview" width="1" height="1"></canvas></div>
  <div id="cmpx-status">未框选。开启框选后在地图上拖拽；Esc 退出。</div>
</div>`;
    document.body.appendChild(panel);

    const $ = (sel) => panel.querySelector(sel);
    const head = panel.querySelector('.cmpx-head');
    const body = panel.querySelector('.cmpx-body');
    const statusEl = $('#cmpx-status');
    const previewCv = $('#cmpx-preview');
    const pctx = previewCv.getContext('2d');

    const overlay = document.createElement('div');
    overlay.id = 'cmpx-overlay';
    const ovCv = document.createElement('canvas');
    overlay.appendChild(ovCv);
    document.body.appendChild(overlay);
    const octx = ovCv.getContext('2d');

    function fitOverlay() {
      const dpr = window.devicePixelRatio || 1;
      ovCv.width = Math.round(innerWidth * dpr);
      ovCv.height = Math.round(innerHeight * dpr);
      ovCv.style.width = innerWidth + 'px';
      ovCv.style.height = innerHeight + 'px';
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderOverlay();
    }
    window.addEventListener('resize', fitOverlay);

    // ---- 面板交互 ----
    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = (ev) => {
        panel.style.left = Math.max(0, ev.clientX - ox) + 'px';
        panel.style.top = Math.max(0, ev.clientY - oy) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
      e.preventDefault();
    });

    panel.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === 'collapse') body.style.display = body.style.display === 'none' ? '' : 'none';
      if (act === 'toggle') setArmed(!armed);
      if (act === 'export') exportImage();
      if (act === 'clear') {
        selRect = null; lastResult = null;
        if (!armed) overlay.style.display = 'none';
        renderOverlay(); renderPreview(); setStatus('已清除。');
      }
      if (act === 'rot+') { cfg.rotation = norm360(cfg.rotation + 0.1); syncInputs(); cfgChanged(); }
      if (act === 'rot-') { cfg.rotation = norm360(cfg.rotation - 0.1); syncInputs(); cfgChanged(); }
    });

    function norm360(d) {
      const x = ((d % 360) + 360) % 360;
      return Math.round(x * 10) / 10;   // 0.1° 步进，消除浮点累加噪声
    }
    function setStatus(t) { statusEl.textContent = t; }

    const inScale = $('#cmpx-scale'), inRot = $('#cmpx-rot'), inMpp = $('#cmpx-mpp'), inMode = $('#cmpx-smode');
    function syncInputs() {
      inScale.value = cfg.scale;
      inRot.value = cfg.rotation;
      inMpp.value = cfg.mppManual != null ? cfg.mppManual : '';
      inMode.value = cfg.sampleMode || 'point';
    }
    function cfgChanged() {
      saveCfg();
      if (selRect) pixelize(selRect);
    }
    inScale.addEventListener('change', () => {
      const v = parseFloat(inScale.value);
      if (v > 0) { cfg.scale = v; cfgChanged(); }
    });
    inRot.addEventListener('change', () => {
      const v = parseFloat(inRot.value);
      if (isFinite(v)) { cfg.rotation = norm360(v); cfgChanged(); }
    });
    inMpp.addEventListener('change', () => {
      const v = parseFloat(inMpp.value);
      cfg.mppManual = v > 0 ? v : null;
      cfgChanged();
    });
    inMode.addEventListener('change', () => {
      if (['point', 'mean', 'median', 'mode'].includes(inMode.value)) {
        cfg.sampleMode = inMode.value;
        cfgChanged();
      }
    });

    function setArmed(on) {
      armed = on;
      // 有结果时保持覆盖层可见（非武装态点击穿透，不挡地图操作）
      overlay.style.display = (on || lastResult) ? 'block' : 'none';
      overlay.classList.toggle('cmpx-armed', on);
      const btn = panel.querySelector('[data-act=toggle]');
      btn.classList.toggle('on', on);
      btn.textContent = on ? '② 框选中…（点击退出）' : '① 开始框选';
      if (!on) { dragging = false; renderOverlay(); }
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) setArmed(false); });

    // ---- 遮罩拖拽框选 ----
    overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true; selStart = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    });
    overlay.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      drawRubber(selStart, { x: e.clientX, y: e.clientY });
    });
    overlay.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      const x1 = Math.min(selStart.x, e.clientX), x2 = Math.max(selStart.x, e.clientX);
      const y1 = Math.min(selStart.y, e.clientY), y2 = Math.max(selStart.y, e.clientY);
      if (x2 - x1 < 4 || y2 - y1 < 4) { renderOverlay(); return; }
      selRect = { x1, y1, x2, y2 };
      pixelize(selRect);
    });

    function drawRubber(a, b) {
      renderOverlay();
      octx.save();
      octx.strokeStyle = '#e74c3c'; octx.lineWidth = 1.5; octx.setLineDash([6, 4]);
      octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y),
        Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      octx.restore();
    }

    // ================== 像素化主流程 ==================
    // 网格为全校区统一的世界坐标网格（全局基准）：
    //   格距 = 1/比例尺（真实米，换算为 WebMercator 投影米），原点锚定 GRID_DATUM，旋转绕基准点；
    //   框选只是“窗口”——格中心落在框内才收录（确定性裁剪）。
    // 因此建筑采样分块只受 比例尺/旋转角（+基准常量）影响：
    //   同一建筑在相同配置下，无论谁拖框、框的位置尺寸如何偏差、地图缩放到哪一级，分块与内容唯一。
    async function pixelize(rect) {
      if (pixelizing) return;
      view = findView() || view;   // 重新探测，防止拿已失效的视图实例
      const mpp = currentMpp();    // 真实地面米 / 屏幕像素
      $('#cmpx-mppinfo').textContent = `${mpp ? mpp.toFixed(3) : '—'} (${mppSource})`;
      if (!mpp) { setStatus('⚠ 无法获取比例尺：请在“米/像素”中手动校准。'); return; }

      const W = rect.x2 - rect.x1, H = rect.y2 - rect.y1;
      if (W < 4 || H < 4) { setStatus('⚠ 选区过小。'); return; }

      const g = (1 / cfg.scale) / mpp;          // 每格（1方块）的屏幕像素数（随缩放变化，仅影响显示精度）
      if (!isFinite(g) || g <= 0) { setStatus('⚠ 比例尺参数无效。'); return; }

      const cellTrue = 1 / cfg.scale;           // 每格真实米（世界网格的固定格距）
      const latRad = (view.center ? view.center.latitude : 30.5) * Math.PI / 180;
      const cellW = cellTrue / Math.cos(latRad); // 每格 WebMercator 投影米
      const th = cfg.rotation * Math.PI / 180;
      const cos = Math.cos(th), sin = Math.sin(th);
      const D = GRID_DATUM;

      const vrect = view.container.getBoundingClientRect();
      const aff = getAffine();

      // 框选四角 → 地图坐标 → 相对基准点的旋转坐标，得到候选格范围
      let uMin = 1e18, uMax = -1e18, vMin = 1e18, vMax = -1e18;
      const worldCorners = [];
      for (const [sx, sy] of [[rect.x1, rect.y1], [rect.x2, rect.y1], [rect.x2, rect.y2], [rect.x1, rect.y2]]) {
        const p = view.toMap({ x: sx - vrect.left, y: sy - vrect.top });
        worldCorners.push(p);
        const u = cos * (p.x - D.x) + sin * (p.y - D.y);
        const v = -sin * (p.x - D.x) + cos * (p.y - D.y);
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      const iLo = Math.floor(uMin / cellW) - 1, iHi = Math.floor(uMax / cellW) + 1;
      const jLo = Math.floor(vMin / cellW) - 1, jHi = Math.floor(vMax / cellW) + 1;
      if ((iHi - iLo + 1) * (jHi - jLo + 1) > 4 * MAX_CELLS) {
        setStatus(`⚠ 选区过大（候选格 > ${4 * MAX_CELLS}）。请放大地图或调小比例尺。`);
        return;
      }

        // 候选格中心（世界坐标）→ 屏幕：格中心落在框内才收录（确定性判定，与框外扩吸附无关）
        const included = [];
        for (let j = jLo; j <= jHi; j++) {
          for (let i = iLo; i <= iHi; i++) {
            const u = (i + 0.5) * cellW, v = (j + 0.5) * cellW;
            const wx = D.x + cos * u - sin * v;
            const wy = D.y + sin * u + cos * v;
            const cp = affToClient(aff, wx, wy, vrect);
            if (cp.x >= rect.x1 && cp.x <= rect.x2 && cp.y >= rect.y1 && cp.y <= rect.y2) {
              included.push({ i, j, wx, wy });
            }
          }
        }
      if (!included.length) { setStatus('⚠ 选区内无整格（过小）。'); return; }
      if (included.length > MAX_CELLS) {
        setStatus(`⚠ 选区过大（${included.length} 格 > ${MAX_CELLS}）。请放大地图或调小比例尺。`);
        return;
      }
      let iA = 1e18, iB = -1e18, jA = 1e18, jB = -1e18;
      for (const c of included) {
        if (c.i < iA) iA = c.i; if (c.i > iB) iB = c.i;
        if (c.j < jA) jA = c.j; if (c.j > jB) jB = c.j;
      }
      const cols = iB - iA + 1, rows = jB - jA + 1;

      pixelizing = true;
      setStatus(`采样中… ${included.length} 格（每格 ${g.toFixed(1)}px）`);
      try {
        // 要素查询范围：框选世界包围盒外扩 1.5 格
        let xmin = 1e18, ymin = 1e18, xmax = -1e18, ymax = -1e18;
        for (const p of worldCorners) {
          if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
          if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
        }
        const pad = cellW * 1.5;
        const extent = { xmin: xmin - pad, ymin: ymin - pad, xmax: xmax + pad, ymax: ymax + pad };

        const [feats, ss] = await Promise.all([queryFeaturesInExtent(extent), takeShot()]);

        // 预处理要素：包围盒 + 环 + 渲染器颜色（已按绘制顶层优先排序）
        const items = [];
        for (const { layer, feature } of feats) {
          const geom = feature.geometry;
          if (!geom || geom.type !== 'polygon' || !geom.rings || !geom.rings.length) continue;
          let fxmin = 1e18, fymin = 1e18, fxmax = -1e18, fymax = -1e18;
          for (const ring of geom.rings) for (const p of ring) {
            if (p[0] < fxmin) fxmin = p[0]; if (p[0] > fxmax) fxmax = p[0];
            if (p[1] < fymin) fymin = p[1]; if (p[1] > fymax) fymax = p[1];
          }
          let sym = null;
          try { sym = feature.symbol || (layer.renderer && layer.renderer.getSymbol(feature)); } catch (e) { /* 忽略 */ }
          const col = colorOfSymbol(sym);
          if (col) items.push({ xmin: fxmin, ymin: fymin, xmax: fxmax, ymax: fymax, rings: geom.rings, col });
        }

        // 逐格采样。sampleMode：
        //   point（默认）—— 格中心单点：建筑层矢量命中取渲染器纯色，否则底图截图单像素
        //   mean / median / mode —— 格内 3×3 子点聚合，平滑底图纹理与抗锯齿边缘造成的离散色斑。
        //     子点偏移是格的固定比例且随网格旋转（世界锚定），不破坏分块唯一性；
        //     建筑判定用 3×3 多数表决（>50% 子点命中同一建筑才算建筑格），未达多数退回底图聚合。
        const colors = new Array(cols * rows).fill(null);
        const isPoint = (cfg.sampleMode || 'point') === 'point';
        const SUBS = isPoint ? [[0.5, 0.5]]
          : [[0.25, 0.25], [0.5, 0.25], [0.75, 0.25], [0.25, 0.5], [0.5, 0.5], [0.75, 0.5], [0.25, 0.75], [0.5, 0.75], [0.75, 0.75]];
        for (const c of included) {
          const subWorld = SUBS.map(([fu, fv]) => [
            D.x + cos * ((c.i + fu) * cellW) - sin * ((c.j + fv) * cellW),
            D.y + sin * ((c.i + fu) * cellW) + cos * ((c.j + fv) * cellW),
          ]);
          let colCss = null;
          // 1) 建筑层：point 取中心命中；聚合模式取 3×3 子点多数表决
          if (isPoint) {
            for (const it of items) {
              if (c.wx < it.xmin || c.wx > it.xmax || c.wy < it.ymin || c.wy > it.ymax) continue;
              if (pointInRings(it.rings, c.wx, c.wy)) { colCss = cssColor(it.col); break; }
            }
          } else {
            const votes = {};
            let bestK = -1, bestN = 0;
            for (const [px2, py2] of subWorld) {
              for (let k = 0; k < items.length; k++) {
                const it = items[k];
                if (px2 < it.xmin || px2 > it.xmax || py2 < it.ymin || py2 > it.ymax) continue;
                if (pointInRings(it.rings, px2, py2)) {
                  votes[k] = (votes[k] || 0) + 1;
                  if (votes[k] > bestN) { bestN = votes[k]; bestK = k; }
                  break;
                }
              }
            }
            if (bestN * 2 > subWorld.length) colCss = cssColor(items[bestK].col);
          }
            // 2) 底图：point 取中心单像素；聚合模式取 3×3 子像素按所选方式聚合。
            //    文字/标注过滤：地名文字烙在底图瓦片里，为低饱和偏暗像素
            //    （实测文字亮度 120-190、R≈G≈B，而地面色亮度均 ≥200 且有色彩倾向），
            //    此类子像素剔除后再聚合；全部被剔时回退取最亮子像素（文字笔画细，9 子点必有地面色）。
            if (!colCss && ss) {
              const lum = (sm) => 0.299 * sm[0] + 0.587 * sm[1] + 0.114 * sm[2];
              const samples = [];
              for (const [px2, py2] of subWorld) {
                const cp = affToClient(aff, px2, py2, vrect);
                const sm = sampleShot(ss, cp.x, cp.y);
                if (sm) samples.push(sm);
              }
              if (isPoint) {
                colCss = samples.length ? cssColor(samples[0]) : null;
              } else if (samples.length) {
                let kept = samples.filter((sm) => {
                  const sat = Math.max(sm[0], sm[1], sm[2]) - Math.min(sm[0], sm[1], sm[2]);
                  return lum(sm) >= SAMPLE_TEXT_LUM_MAX || sat >= SAMPLE_LABEL_MAXSAT;
                });
                if (!kept.length) kept = [samples.reduce((a, b) => (lum(b) > lum(a) ? b : a))];
                if (cfg.sampleMode === 'mean') {
                  let r = 0, gg = 0, b = 0;
                  for (const sm of kept) { r += sm[0]; gg += sm[1]; b += sm[2]; }
                  const n = kept.length;
                  colCss = cssColor([Math.round(r / n), Math.round(gg / n), Math.round(b / n), 1]);
                } else if (cfg.sampleMode === 'median') {
                  const med = (arr) => { const t = arr.slice().sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
                  colCss = cssColor([
                    med(kept.map((sm) => sm[0])), med(kept.map((sm) => sm[1])),
                    med(kept.map((sm) => sm[2])), 1,
                  ]);
                } else { // mode 众数：24 级量化分桶取最大桶，桶内取均值
                  const q = 24, bins = {};
                  for (const sm of kept) {
                    const kk = `${Math.round(sm[0] / q)},${Math.round(sm[1] / q)},${Math.round(sm[2] / q)}`;
                    (bins[kk] = bins[kk] || []).push(sm);
                  }
                  const best = Object.values(bins).sort((x, y) => y.length - x.length)[0];
                  let r = 0, gg = 0, b = 0;
                  for (const sm of best) { r += sm[0]; gg += sm[1]; b += sm[2]; }
                  colCss = cssColor([Math.round(r / best.length), Math.round(gg / best.length), Math.round(b / best.length), 1]);
                }
              }
            }
            colors[(rows - 1 - (c.j - jA)) * cols + (c.i - iA)] = colCss;   // 行序翻转：数组第 0 行 = 最北（图像上方），与地图朝向一致
        }

          lastResult = {
            cols, rows, colors, g, i0: iA, j0: jA, mpp,
            scale: cfg.scale, rotation: cfg.rotation,
            cellTrue, cellW, included: included.length,
          };
        overlay.style.display = 'block';   // 确保结果覆盖层可见（即使未经武装直接出结果）
        renderOverlay();
        renderPreview();
        const warn = g < 1.5 ? ' ⚠建议放大地图' : '';
        setStatus(`✔ ${included.length} 格（范围 ${cols}×${rows}）｜ 实地 ${(cols * cellTrue).toFixed(1)} × ${(rows * cellTrue).toFixed(1)} 米`
          + ` ｜ 1方块=${cellTrue.toFixed(3)}米 ｜ 要素${items.length}个 ｜ 全局网格${warn}`);
      } catch (e) {
        setStatus('⚠ 采样失败：' + String(e && e.message || e).slice(0, 80));
      } finally {
        pixelizing = false;
      }
    }

    // 地图上的旋转像素网格覆盖层。
    // 绘制基准与采样完全一致：由“屏幕→世界”仿射反推“格坐标→屏幕”变换（自动兼容视图旋转 view.rotation），
    // 平移/缩放/旋转视图后重跑框选，同一格仍绘制在同一地理位置。
    function renderOverlay() {
      octx.clearRect(0, 0, innerWidth, innerHeight);
      if (!lastResult) return;
      const { cols, rows, colors, g, i0, j0, rotation, cellW } = lastResult;
      if (!cellW) return;
      const vrect = view.container.getBoundingClientRect();
      const aff = getAffine();
      const sD = affToClient(aff, GRID_DATUM.x, GRID_DATUM.y, vrect);

      // 格坐标 (i,j) → 世界 → 屏幕 的线性变换 T = inv(M)·R(θ)·cellW，M=[[bx.x,by.x],[bx.y,by.y]]
      const th = rotation * Math.PI / 180;
      const c = Math.cos(th), s = Math.sin(th);
      const r00 = c * cellW, r01 = -s * cellW, r10 = s * cellW, r11 = c * cellW;
      const m00 = aff.bx.x, m01 = aff.by.x, m10 = aff.bx.y, m11 = aff.by.y;
      const det = m00 * m11 - m01 * m10;
      const n00 = m11 / det, n01 = -m01 / det, n10 = -m10 / det, n11 = m00 / det;
      const T00 = n00 * r00 + n01 * r10, T01 = n00 * r01 + n01 * r11;
      const T10 = n10 * r00 + n11 * r10, T11 = n10 * r01 + n11 * r11;

      octx.save();
      octx.translate(sD.x, sD.y);
      octx.transform(T00, T10, T01, T11, 0, 0);
        octx.globalAlpha = 0.88;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            // 数组行序已翻转（第 0 行 = 最北），此处按格坐标取对应行
            const col = colors[(rows - 1 - j) * cols + i];
            if (!col) continue;
            octx.fillStyle = col;
            octx.fillRect(i0 + i, j0 + j, 1.01, 1.01);
          }
        }
      octx.globalAlpha = 1;
      if (g >= 4) {
        octx.strokeStyle = 'rgba(0,0,0,.35)';
        octx.lineWidth = 1 / g;
        octx.beginPath();
        for (let i = i0; i <= i0 + cols; i++) { octx.moveTo(i, j0); octx.lineTo(i, j0 + rows); }
        for (let j = j0; j <= j0 + rows; j++) { octx.moveTo(i0, j); octx.lineTo(i0 + cols, j); }
        octx.stroke();
      }
      octx.strokeStyle = '#e74c3c'; octx.lineWidth = 1.5 / g;
      octx.strokeRect(i0, j0, cols, rows);
      octx.restore();
    }

    // 面板内预览图（网格空间，无旋转）。
    // 网格线精确落在每格边界上，k>=2 时始终绘制，方便数格；
    // 画布按原始像素尺寸显示，超宽部分在预览容器内滚动查看。
    function renderPreview() {
      if (!lastResult) { previewCv.width = 1; previewCv.height = 1; return; }
      const { cols, rows, colors } = lastResult;
      const k = Math.max(1, Math.min(20, Math.floor(720 / Math.max(cols, rows))));
      previewCv.width = cols * k; previewCv.height = rows * k;
      pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, previewCv.width, previewCv.height);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const c = colors[j * cols + i];
          if (!c) continue;
          pctx.fillStyle = c;
          pctx.fillRect(i * k, j * k, k, k);
        }
      }
      if (k >= 2) {
        pctx.strokeStyle = 'rgba(0,0,0,.22)'; pctx.lineWidth = 1;
        pctx.beginPath();
        for (let i = 0; i <= cols; i++) { pctx.moveTo(i * k + 0.5, 0); pctx.lineTo(i * k + 0.5, rows * k); }
        for (let j = 0; j <= rows; j++) { pctx.moveTo(0, j * k + 0.5); pctx.lineTo(cols * k, j * k + 0.5); }
        pctx.stroke();
      }
    }

    // ================== 导出图片 ==================
    // 按采样结果重新绘制（非面板预览截图）：15px/方块 + 1px 网格线，网格线用浅灰实色，
    // 无数据格留白，保证导出图在任何背景下格线清晰、可直接数格
      const EXPORT_CELL = 15, EXPORT_LINE = 1;
      const EXPORT_LINE_COLOR = '#d9d9d9', EXPORT_EMPTY = '#ffffff';
      const EXPORT_SUPER = 8;            // 每 8×8 格一个大单元格（棋盘底纹周期，便于按 8 计数）
      const EXPORT_CHECKER_ALPHA = 0.03;  // 暗大格叠加的半透明黑强度（3%）

      function buildExportCanvas() {
        if (!lastResult) return null;
        const { cols, rows, colors, i0, j0 } = lastResult;
        const cv = document.createElement('canvas');
        cv.width = cols * (EXPORT_CELL + EXPORT_LINE) + EXPORT_LINE;
        cv.height = rows * (EXPORT_CELL + EXPORT_LINE) + EXPORT_LINE;
        const c = cv.getContext('2d');
        c.fillStyle = EXPORT_LINE_COLOR;
        c.fillRect(0, 0, cv.width, cv.height);          // 先铺网格线色，再挖出方块
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            c.fillStyle = colors[j * cols + i] || EXPORT_EMPTY;
            c.fillRect(EXPORT_LINE + i * (EXPORT_CELL + EXPORT_LINE),
              EXPORT_LINE + j * (EXPORT_CELL + EXPORT_LINE), EXPORT_CELL, EXPORT_CELL);
          }
        }
        // 8×8 大单元格棋盘底纹：相位对齐全局格坐标（相邻大格交替亮暗，暗格叠半透明黑），
        // 多人分别导出的图拼贴时棋盘保持连续
        c.fillStyle = `rgba(0,0,0,${EXPORT_CHECKER_ALPHA})`;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const gi = i0 + i, gj = j0 + j;
            if (((Math.floor(gi / EXPORT_SUPER) + Math.floor(gj / EXPORT_SUPER)) & 1) === 1) {
              c.fillRect(EXPORT_LINE + i * (EXPORT_CELL + EXPORT_LINE),
                EXPORT_LINE + j * (EXPORT_CELL + EXPORT_LINE), EXPORT_CELL, EXPORT_CELL);
            }
          }
        }
        return cv;
      }

      function exportImage() {
        const cv = buildExportCanvas();
        if (!cv) { setStatus('⚠ 尚无结果：请先框选一次再导出。'); return; }
        cv.toBlob((blob) => {
          if (!blob) { setStatus('⚠ 导出失败：无法生成图片数据。'); return; }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `像素化_${lastResult.cols}x${lastResult.rows}_1方块${(1 / cfg.scale).toFixed(3)}米.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
          setStatus(`✔ 已导出图片：${cv.width} × ${cv.height}px（15px/方块 + 1px 网格线 + 8×8 棋盘底纹）`);
        }, 'image/png');
      }

    // 调试/自动化测试钩子
    window.__cmpx = {
      view: () => view, cfg,
      get lastResult() { return lastResult; },
      get status() { return statusEl.textContent; },
      setArmed, pixelize: (r) => pixelize(r),
      buildExportCanvas, exportImage,
      reRun: () => selRect && pixelize(selRect),
    };

    // ================== 启动 ==================
    syncInputs();
    fitOverlay();
    setStatus('就绪。开启框选后在地图上拖拽；Esc 退出框选。');
  }
})();
