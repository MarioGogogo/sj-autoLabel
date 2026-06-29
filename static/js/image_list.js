/**
 * 图片列表：导入、渲染、状态标注、计数。
 *
 * 状态语义：
 *   pending  待处理（导入默认，无 txt）
 *   negative 负样本（空 txt = YOLO 背景图，明确无目标）
 *   done     已处理（有非空标注）
 */
(function () {
    "use strict";

    const imageList = document.getElementById("imageList");
    const emptyHint = document.getElementById("emptyHint");
    const imageCount = document.getElementById("imageCount");

    // ===== 中间展示区元素 =====
    const canvasEmpty = document.getElementById("canvasEmpty");
    const canvasArea = document.getElementById("canvasArea");
    const canvasWrapper = document.getElementById("canvasWrapper");
    const canvasStage = document.getElementById("canvasStage");
    const canvasImage = document.getElementById("canvasImage");
    const canvasFrame = document.getElementById("canvasFrame");
    const canvasBoxes = document.getElementById("canvasBoxes");
    const canvasProgress = document.getElementById("canvasProgress");
    const canvasName = document.getElementById("canvasName");
    const canvasSize = document.getElementById("canvasSize");
    const canvasZoom = document.getElementById("canvasZoom");
    const zoomInBtn = document.getElementById("zoomInBtn");
    const zoomOutBtn = document.getElementById("zoomOutBtn");
    const zoomResetBtn = document.getElementById("zoomResetBtn");
    const drawBoxBtn = document.getElementById("drawBoxBtn");
    const lineWidthGroup = document.getElementById("lineWidthGroup");
    const lineWidthSlider = document.getElementById("lineWidthSlider");
    const lineWidthVal = document.getElementById("lineWidthVal");
    const ctxMenu = document.getElementById("ctxMenu");
    const categoryList = document.getElementById("categoryList");
    const addCatBtn = document.getElementById("addCatBtn");
    const confSlider = document.getElementById("confSlider");
    const confLabel = document.getElementById("confLabel");
    const catDialog = document.getElementById("catDialog");
    const catNameInput = document.getElementById("catNameInput");
    const catColorInput = document.getElementById("catColorInput");
    const catSwatch = document.getElementById("catSwatch");
    const catConfirmBtn = document.getElementById("catConfirmBtn");
    const catCancelBtn = document.getElementById("catCancelBtn");
    const catColorDialog = document.getElementById("catColorDialog");
    const catColorTarget = document.getElementById("catColorTarget");
    const catColorPalette = document.getElementById("catColorPalette");
    const catColorPicker = document.getElementById("catColorPicker");
    const catColorSwatch = document.getElementById("catColorSwatch");
    const catColorHexInput = document.getElementById("catColorHexInput");
    const catColorConfirmBtn = document.getElementById("catColorConfirmBtn");
    const catColorCancelBtn = document.getElementById("catColorCancelBtn");

    // ===== 项目打开 / 目录浏览元素 =====
    const projectTitle = document.getElementById("projectTitle");
    const projectPathEl = document.getElementById("projectPath");
    const refreshBtn = document.getElementById("refreshBtn");
    const refreshTopBtn = document.getElementById("refreshTopBtn");
    const openProjectBtn = document.getElementById("openProjectBtn");
    const openProjectTopBtn = document.getElementById("openProjectTopBtn");
    const normalizeNegBtn = document.getElementById("normalizeNegBtn");
    const browseDialog = document.getElementById("browseDialog");
    const browseCurrentPath = document.getElementById("browseCurrentPath");
    const browseUpBtn = document.getElementById("browseUpBtn");
    const browseDirList = document.getElementById("browseDirList");
    const browseManualPath = document.getElementById("browseManualPath");
    const browseSelectBtn = document.getElementById("browseSelectBtn");
    const browseCancelBtn = document.getElementById("browseCancelBtn");
    const browseRecentSection = document.getElementById("browseRecentSection");
    const browseRecentList = document.getElementById("browseRecentList");

    // ===== 模型加载元素 =====
    const modelPathInput = document.getElementById("modelPathInput");
    const modelBrowseBtn = document.getElementById("modelBrowseBtn");
    const loadModelBtn = document.getElementById("loadModelBtn");
    const modelHint = document.getElementById("modelHint");
    const modelBrowseDialog = document.getElementById("modelBrowseDialog");
    const modelBrowseCurrentPath = document.getElementById("modelBrowseCurrentPath");
    const modelBrowseUpBtn = document.getElementById("modelBrowseUpBtn");
    const modelBrowseList = document.getElementById("modelBrowseList");
    const modelBrowseManualPath = document.getElementById("modelBrowseManualPath");
    const modelBrowseSelectBtn = document.getElementById("modelBrowseSelectBtn");
    const modelBrowseCancelBtn = document.getElementById("modelBrowseCancelBtn");
    // 状态栏
    const modelStatusDot = document.getElementById("modelStatusDot");
    const modelStatusText = document.getElementById("modelStatusText");
    const modelLatency = document.getElementById("modelLatency");
    const modelGpu = document.getElementById("modelGpu");
    // SAM 2 分割
    const samBtn = document.getElementById("samBtn");
    const samVariantSelect = document.getElementById("samVariantSelect");
    const samCheckpointInput = document.getElementById("samCheckpointInput");
    const loadSamBtn = document.getElementById("loadSamBtn");
    const unloadSamBtn = document.getElementById("unloadSamBtn");
    const samStatusDot = document.getElementById("samStatusDot");
    const samStatusText = document.getElementById("samStatusText");
    // 检测按钮 + 自动标注
    const detectBtn = document.getElementById("detectBtn");
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");
    const autoLabelToggle = document.getElementById("autoLabelToggle");
    const autoLabelKnob = document.getElementById("autoLabelKnob");
    const autoLabelHint = document.getElementById("autoLabelHint");
    // 推理环境配置
    const envConfigPanel = document.getElementById("envConfigPanel");
    const envConfigContent = document.getElementById("envConfigContent");

    // ===== 通用弹窗元素 =====
    const confirmDialog = document.getElementById("confirmDialog");
    const confirmIcon = document.getElementById("confirmIcon");
    const confirmTitle = document.getElementById("confirmTitle");
    const confirmMsg = document.getElementById("confirmMsg");
    const confirmOkBtn = document.getElementById("confirmOkBtn");
    const confirmCancelBtn = document.getElementById("confirmCancelBtn");
    const toastEl = document.getElementById("toast");
    const notifyStack = document.getElementById("notifyStack");

    let selectedName = null; // 当前选中图片的物理文件名（唯一标识）
    let currentProject = null; // 当前打开的项目元信息
    let autoDetect = false; // 自动标注开关
    let detectAbort = null; // AbortController，取消进行中的检测
    let detectedCache = new Set(); // 客户端已检测图片 name 集合（去重）

    // ===== 画布视图状态（缩放 / 平移） =====
    const view = { scale: 1, x: 0, y: 0 };
    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 8;
    const ZOOM_STEP = 1.25; // 每次缩放倍率

    // ===================== 画布：缩放 / 平移 =====================

    /** 把当前 view 状态写回舞台 transform，并刷新缩放百分比提示。 */
    function applyTransform() {
        if (!canvasStage) return;
        canvasStage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
        // 边缘条、标注框线条、标签和把手逆缩放：绝对保持物理视觉尺寸恒定，不随画布缩放而放大缩小。
        const inv = 1 / view.scale;
        canvasBoxes.style.setProperty('--bs', inv);
        if (canvasZoom) {
            canvasZoom.textContent = `${Math.round(view.scale * 100)}%`;
            // 非 100% 时显示缩放指示。
            canvasZoom.style.opacity = Math.abs(view.scale - 1) > 0.001 || view.x || view.y ? "1" : "0";
        }
    }

    /** 重置视图到 100% / 居中。 */
    function resetView() {
        view.scale = 1;
        view.x = 0;
        view.y = 0;
        applyTransform();
    }

    /**
     * 缩放：始终以图片中心为锚点，缩放后图片保持居中（不产生平移偏移）。
     * @param {number} factor 缩放因子（>1 放大，<1 缩小）
     */
    function zoomBy(factor) {
        const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.scale * factor));
        if (newScale === view.scale) return;
        view.scale = newScale;
        view.x = 0;
        view.y = 0;
        applyTransform();
    }

    /** 绑定画布的缩放 / 平移交互。 */
    function bindCanvas() {
        if (!canvasStage) return;

        // 滚轮缩放（始终居中，不偏移）。
        canvasWrapper.addEventListener("wheel", (e) => {
            if (canvasWrapper.classList.contains("hidden")) return;
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
        }, { passive: false });

        // 双击重置视图。
        canvasWrapper.addEventListener("dblclick", resetView);

        // 拖拽平移：在舞台上按住鼠标拖动。
        let dragging = false;
        let start = null;
        canvasStage.addEventListener("mousedown", (e) => {
            // 仅主键触发拖拽。
            if (e.button !== 0) return;
            dragging = true;
            start = { x: e.clientX - view.x, y: e.clientY - view.y };
            canvasStage.classList.add("dragging");
            e.preventDefault();
        });
        window.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            view.x = e.clientX - start.x;
            view.y = e.clientY - start.y;
            applyTransform();
        });
        window.addEventListener("mouseup", () => {
            if (!dragging) return;
            dragging = false;
            canvasStage.classList.remove("dragging");
        });

        // 工具栏按钮。
        if (zoomInBtn) zoomInBtn.addEventListener("click", () => zoomBy(ZOOM_STEP));
        if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
        if (zoomResetBtn) zoomResetBtn.addEventListener("click", resetView);
    }

    // ===== 类别 → 颜色映射（与右侧类别区域一致） =====
    // 数据源：服务端 classes.txt + 颜色缓存.json（文件为准，启动读、改类别写回）。
    // color: 内部唯一 key（cid_<行号>）；hex: 实际显示色（支持任意颜色）。
    let CATEGORIES = [];
    const catByColor = (color) => CATEGORIES.find((c) => c.color === color) || null;
    const hexOfLabel = (label) => (CATEGORIES.find((c) => c.label === label) || {}).hex || "#003d9b";

    // 当前选中类别（决定新画框的颜色与标签）。无类别时为空壳。
    let activeCategory = { label: "", color: "", hex: "#003d9b" };

    /** 从服务端加载全部类别（启动 / 删除后刷新调用）。 */
    async function loadCategories() {
        try {
            const resp = await fetch("/api/classes");
            const data = await resp.json();
            if (!resp.ok || !data.ok) return;
            CATEGORIES = (data.categories || []).map((c) => ({
                label: c.label,
                hex: c.hex,
                color: "cid_" + c.id,
            }));
        } catch (e) {
            CATEGORIES = [];
        }
        activeCategory = CATEGORIES[0] || activeCategory;
        renderCategoryList();
        if (CATEGORIES.length) selectCategory(activeCategory.color);
    }

    // 当前图片的检测框数据与选中态。
    let currentBoxes = [];
    let selectedBoxId = null;
    let drawMode = false; // 画框工具是否开启
    let samMode = false;  // SAM 点击分割工具是否开启
    let samLoaded = false; // SAM 模型是否已加载
    let samAbort = null;  // AbortController，取消进行中的 SAM 分割
    let lineWidth = 1;    // 画框粗细（px）
    let confThreshold = 50; // 置信度阈值（0-100），后续接入模型检测时使用
    let boxSeq = 0; // 新建框序号，保证 id 唯一

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const nextBoxSeq = () => `${Date.now().toString(36)}_${(boxSeq++).toString(36)}`;

    // ===================== 撤销 / 重做（快照式，按图片维度） =====================
    // 设计要点：
    //   - 快照式整体替换：每次改动后把 currentBoxes 深拷贝入栈。
    //   - 按图片独立分栈：切换图片时该图的栈重建（初始快照 = 刚加载的标注），
    //     撤销只影响当前图片，不跨图混乱。
    //   - 每图上限 HISTORY_LIMIT 步，超出淘汰最旧。
    //   - 程序写入（加载/自动识别等）通过 suppressHistory 标记，避免误入栈。
    const HISTORY_LIMIT = 60;
    const undoStack = new Map();   // imageName -> 快照数组（初始态作为栈底）
    const redoStack = new Map();   // imageName -> 快照数组
    let suppressHistory = false;   // true 期间 pushHistory 不入栈

    /** 深拷贝当前框为可快照对象（仅标注字段，丢弃 DOM / 选中态）。 */
    function snapshot() {
        return currentBoxes.map((b) => ({
            id: b.id, label: b.label, score: b.score,
            x: b.x, y: b.y, w: b.w, h: b.h, hex: b.hex,
        }));
    }

    /** 用快照恢复 currentBoxes（不重新入栈；undo/redo 也算改动，照常落盘）。 */
    function restoreSnapshot(snap) {
        suppressHistory = true;
        currentBoxes = snap.map((b) => ({ ...b }));
        selectedBoxId = null;
        renderBoxes();
        scheduleSaveLabels();
        suppressHistory = false;
        updateUndoRedoButtons();
    }

    /**
     * 当前图片加载完成 / 切换图片时调用：以当前标注作为该图撤销栈的初始快照，
     * 清空 redo。suppressed：调用方应已设 suppressHistory 避免重复入栈。
     */
    function resetHistoryForCurrent() {
        const name = selectedName;
        if (!name) return;
        undoStack.set(name, [snapshot()]);
        redoStack.set(name, []);
        updateUndoRedoButtons();
    }

    /** 每个产生变更的动作完成后调用：推当前态进 undo 栈、清空 redo。 */
    function pushHistory() {
        if (suppressHistory) return;
        const name = selectedName;
        if (!name) return;
        const u = undoStack.get(name) || [];
        u.push(snapshot());
        if (u.length > HISTORY_LIMIT) u.shift();  // 超出上限淘汰最旧
        undoStack.set(name, u);
        redoStack.set(name, []);                    // 新动作发生，redo 作废
        updateUndoRedoButtons();
    }

    /** 撤销一步：当前态进 redo，回到 undo 栈顶。 */
    function undo() {
        const name = selectedName;
        const u = undoStack.get(name) || [];
        if (u.length <= 1) return;                  // 只剩初始态，无可撤销
        const r = redoStack.get(name) || [];
        r.push(snapshot());
        redoStack.set(name, r);
        u.pop();                                    // 弹出当前态
        restoreSnapshot(u[u.length - 1]);           // 回到上一步
    }

    /** 重做一步：当前态进 undo，回到 redo 栈顶。 */
    function redo() {
        const name = selectedName;
        const r = redoStack.get(name) || [];
        if (!r.length) return;
        const u = undoStack.get(name) || [];
        u.push(snapshot());
        undoStack.set(name, u);
        restoreSnapshot(r.pop());
    }

    /** 根据「当前图」栈状态刷新按钮可用 / 禁用。 */
    function updateUndoRedoButtons() {
        const name = selectedName;
        const uLen = (undoStack.get(name) || []).length;
        const rLen = (redoStack.get(name) || []).length;
        if (undoBtn) undoBtn.disabled = uLen <= 1;
        if (redoBtn) redoBtn.disabled = rLen === 0;
    }

    /** 查找指定 id 的框数据。 */
    function findBox(id) {
        return currentBoxes.find((b) => b.id === id) || null;
    }

    /** 把检测框渲染到 #canvasBoxes（百分比定位，随舞台缩放）。 */
    function renderBoxes() {
        if (!canvasBoxes) return;
        canvasBoxes.innerHTML = "";
        currentBoxes.forEach((b) => {
            const box = document.createElement("div");
            box.className = "bbox" + (b.id === selectedBoxId ? " selected" : "");
            box.dataset.boxId = b.id;
            const hex = b.hex || "#003d9b";
            box.style.cssText =
                `left:${(b.x * 100).toFixed(2)}%;top:${(b.y * 100).toFixed(2)}%;` +
                `width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%;` +
                `--bw:${lineWidth};border-color:${hex};--hc:${hex};`;
            const lbl = document.createElement("div");
            lbl.className = "bbox-label text-white";
            lbl.style.backgroundColor = hex;
            const scoreText = (b.score !== undefined && b.score !== null && b.score < 100) ? ` ${Math.round(b.score)}%` : "";
            lbl.textContent = `${b.label}${scoreText}`;
            box.appendChild(lbl);
            // 4 条边缘命中条（中央穿透，便于框选内部小目标 / 绘制穿透）。
            ["top", "right", "bottom", "left"].forEach((side) => {
                const edge = document.createElement("div");
                edge.className = `bbox-edge ${side}`;
                edge.dataset.boxId = b.id;
                box.appendChild(edge);
            });
            // 选中框追加 8 个尺寸调整把手。
            if (b.id === selectedBoxId) appendHandles(box);
            canvasBoxes.appendChild(box);
        });
        refreshCategoryCounts();
    }

    /** 给框元素追加 8 个调整把手（nw/n/ne/e/se/s/sw/w）。 */
    function appendHandles(boxEl) {
        ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach((dir) => {
            const h = document.createElement("div");
            h.className = `handle ${dir}`;
            h.dataset.handle = dir;
            boxEl.appendChild(h);
        });
    }

    /** 选中某个框（传 null 表示取消选中）。重渲染以增删把手。 */
    function selectBox(id) {
        selectedBoxId = id;
        renderBoxes();
    }

    /** 删除当前选中的框。 */
    function deleteSelectedBox() {
        if (!selectedBoxId) return false;
        currentBoxes = currentBoxes.filter((b) => b.id !== selectedBoxId);
        selectedBoxId = null;
        renderBoxes();
        pushHistory();
        scheduleSaveLabels();
        return true;
    }

    /** 清空当前图片全部标注框。 */
    function clearAllBoxes() {
        if (!currentBoxes.length) return;
        currentBoxes = [];
        selectedBoxId = null;
        renderBoxes();
        pushHistory();
        scheduleSaveLabels();
    }

    /** 切换画框工具开关。 */
    function setDrawMode(on) {
        drawMode = on;
        if (canvasStage) canvasStage.classList.toggle("drawing-mode", on);
        document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", on));
        if (lineWidthGroup) lineWidthGroup.classList.toggle("hidden", !on);
        if (on) {
            selectBox(null); // 进入绘制时取消选中，避免干扰
            // 关闭 SAM 模式，并确保 samBtn 不被上面的 forEach 点亮。
            samMode = false;
            if (canvasStage) canvasStage.classList.remove("sam-mode");
            if (samBtn) samBtn.classList.remove("active");
        }
    }

    /** 切换 SAM 点击分割工具开关（与画框互斥）。 */
    function setSamMode(on) {
        samMode = on;
        if (on) {
            // 关闭画框模式。
            if (drawMode) {
                drawMode = false;
                if (canvasStage) canvasStage.classList.remove("drawing-mode");
                if (lineWidthGroup) lineWidthGroup.classList.add("hidden");
            }
            // 清掉所有 tool-btn 的 active，只点亮 samBtn。
            document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
            if (samBtn) samBtn.classList.add("active");
            selectBox(null);
        } else {
            if (samBtn) samBtn.classList.remove("active");
        }
        if (canvasStage) canvasStage.classList.toggle("sam-mode", on);
    }

    /** 选中某个类别（决定新画框的颜色与标签）。 */
    function selectCategory(color) {
        const cat = catByColor(color);
        if (!cat) return;
        activeCategory = cat;
        if (categoryList) {
            categoryList.querySelectorAll(".cat-item").forEach((el) => {
                el.classList.toggle("active", el.dataset.cat === color);
            });
        }
    }

    /** 刷新右侧类别计数（全项目统计，数据由后端接口提供）。 */
    let categoryCounts = {}; // { label: 全项目框数 }

    function refreshCategoryCounts() {
        if (!categoryList) return;
        const total = Object.values(categoryCounts).reduce((s, n) => s + (n || 0), 0);
        categoryList.querySelectorAll(".cat-item").forEach((item) => {
            const cat = catByColor(item.dataset.cat);
            const n = cat ? (categoryCounts[cat.label] || 0) : 0;
            const pct = total ? Math.round((n / total) * 100) : 0;
            const countEl = item.querySelector(".cat-count");
            if (countEl) countEl.textContent = n + "框";
            const fill = item.querySelector(".cat-bar-fill");
            if (fill) {
                fill.style.width = pct + "%";
                if (cat) fill.style.background = cat.hex;
            }
            const pctEl = item.querySelector(".cat-pct");
            if (pctEl) pctEl.textContent = pct + "%";
        });
    }

    function setCategoryCounts(counts) {
        categoryCounts = counts || {};
        refreshCategoryCounts();
    }

    /** 调接口拉取全项目类别统计并刷新 UI。 */
    async function fetchStats() {
        try {
            const resp = await fetch("/api/project/stats");
            const data = await resp.json();
            if (data.ok) setCategoryCounts(data.categoryCounts);
        } catch (e) { /* 静默，统计非关键路径 */ }
    }

    /** 渲染右侧类别列表（首屏 + 新增后调用）。 */
    function renderCategoryList() {
        if (!categoryList) return;
        categoryList.innerHTML = "";
        CATEGORIES.forEach((c) => {
            const item = document.createElement("div");
            item.className = "cat-item group flex flex-col gap-xs pl-sm pr-xs py-sm bg-surface-container-highest rounded-lg cursor-pointer transition-all hover:brightness-95";
            item.dataset.cat = c.color;
            item.style.borderLeft = `5px solid ${c.hex}`;
            if (c.color === activeCategory.color) item.classList.add("active");
            item.innerHTML = `
                <div class="flex items-center gap-sm">
                    <span class="cat-dot w-3 h-3 rounded-full flex-shrink-0 ring-2 ring-white/50 cursor-pointer hover:scale-110 transition-transform" style="background:${c.hex}" title="点击修改颜色"></span>
                    <span class="cat-label flex-1 font-label-mono text-xs text-on-surface truncate">${escapeHtml(c.label)}</span>
                    <span class="cat-count text-[11px] font-label-mono text-on-surface-variant whitespace-nowrap">0框</span>
                    <button type="button" title="修改颜色"
                        class="cat-edit-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-outline hover:text-primary hover:bg-primary/10 transition-all opacity-0 group-hover:opacity-100">
                        <span class="material-symbols-outlined text-[16px]">palette</span>
                    </button>
                    <button type="button" title="删除类别"
                        class="cat-del-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-outline hover:text-error hover:bg-error/10 transition-all opacity-0 group-hover:opacity-100">
                        <span class="material-symbols-outlined text-[16px]">close</span>
                    </button>
                </div>
                <div class="flex items-center gap-xs pl-[20px]">
                    <div class="cat-bar-track flex-1 h-1.5 rounded-full bg-surface-variant overflow-hidden">
                        <div class="cat-bar-fill h-full rounded-full transition-all" style="width:0%;background:${c.hex}"></div>
                    </div>
                    <span class="cat-pct text-[10px] font-label-mono text-outline w-8 text-right">0%</span>
                </div>
            `;
            categoryList.appendChild(item);
        });
        refreshCategoryCounts(); // 重绘后立即同步计数与占比
    }

    /** 简易 HTML 转义，防止类别名含特殊字符破坏 DOM。 */
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (ch) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[ch]));
    }

    /**
     * 新增类别。
     * @param {string} label 类别名
     * @param {string} hex 颜色（#rrggbb）
     * @returns {boolean} 是否成功
     */
    async function addCategory(label, hex) {
        label = (label || "").trim();
        if (!label) { showToast("类别名不能为空"); return false; }
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) { showToast("颜色格式非法"); return false; }
        if (CATEGORIES.some((c) => c.label === label)) { showToast("类别已存在"); return false; }
        try {
            const resp = await fetch("/api/classes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label, hex }),
            });
            const data = await resp.json();
            if (!resp.ok) { showToast(data.error || "新增失败"); return false; }
            CATEGORIES.push({ label, hex, color: "cid_" + data.id });
            renderCategoryList();
            selectCategory("cid_" + data.id); // 新增后自动选中
            return true;
        } catch (e) {
            showToast("新增失败：" + e.message);
            return false;
        }
    }

    /**
     * 删除类别（走后端）。若类别已被标注使用，后端返回 409，二次确认后强制删除
     * 并重写所有标注文件。
     * @param {string} color 类别 color 标识
     * @returns {boolean} 是否成功
     */
    async function deleteCategory(color) {
        const cat = catByColor(color);
        if (!cat) return false;
        // 先弹常规确认（防误触）。
        const ok = await showConfirm({
            title: "删除类别",
            message: `确定删除类别「${cat.label}」吗？`,
            okText: "删除",
            danger: true,
        });
        if (!ok) return false;

        // 第一次尝试删除（不带 force）。
        let resp = await fetch(`/api/classes/${encodeURIComponent(cat.label)}`, { method: "DELETE" });
        let data = await resp.json();

        // 被使用 → 二次确认后强制删除。
        if (resp.status === 409 && data.in_use) {
            const force = await showConfirm({
                title: "类别已被使用",
                message: `${data.error} 仍要删除吗？`,
                okText: "强制删除",
                danger: true,
            });
            if (!force) return false;
            resp = await fetch(`/api/classes/${encodeURIComponent(cat.label)}?force=1`, { method: "DELETE" });
            data = await resp.json();
        }
        if (!resp.ok || !data.ok) { showToast(data.error || "删除失败"); return false; }

        // class_id 重排了，重新从服务端拉取类别 + 当前图标注 + 统计。
        await loadCategories();
        fetchStats();
        if (selectedName) {
            currentBoxes = await loadBoxesForImage(selectedName);
            selectedBoxId = null;
            renderBoxes();
            resetHistoryForCurrent(); // 类别删除后重拉标注，重建撤销栈
        }
        showToast(`已删除类别「${cat.label}」`);
        return true;
    }

    // ===================== 类别颜色编辑 =====================
    const COLOR_PALETTE = [
        "#0c56d0", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f",
        "#c62828", "#455a64", "#f9a825", "#5e35b1", "#00897b",
    ];
    let colorEditing = null; // 正在编辑颜色的类别 color 标识

    /** 填充预设色板（首次打开时渲染一次）。 */
    function ensureColorPalette() {
        if (!catColorPalette || catColorPalette.childElementCount) return;
        catColorPalette.innerHTML = COLOR_PALETTE.map((hex) =>
            `<button type="button" class="cat-preset-swatch w-7 h-7 rounded-full border border-outline-variant hover:scale-110 transition-transform" data-hex="${hex}" style="background:${hex}" title="${hex}"></button>`
        ).join("");
    }

    /** 同步选色器三控件（picker / swatch / hex 输入）到指定 hex，并高亮命中的预设色。 */
    function syncColorUI(hex) {
        const h = hex.toLowerCase();
        if (catColorPicker) catColorPicker.value = h;
        if (catColorSwatch) catColorSwatch.style.background = h;
        if (catColorHexInput) catColorHexInput.value = h.toUpperCase();
        if (catColorPalette) {
            catColorPalette.querySelectorAll(".cat-preset-swatch").forEach((b) => {
                const on = b.dataset.hex.toLowerCase() === h;
                b.classList.toggle("ring-2", on);
                b.classList.toggle("ring-offset-1", on);
            });
        }
    }

    /** 打开颜色编辑弹窗（圆点 / 编辑按钮入口）。 */
    function openColorDialog(color) {
        const cat = catByColor(color);
        if (!cat || !catColorDialog) return;
        colorEditing = color;
        ensureColorPalette();
        if (catColorTarget) catColorTarget.textContent = cat.label;
        syncColorUI(cat.hex);
        catColorDialog.classList.remove("hidden");
    }

    function closeColorDialog() {
        if (catColorDialog) catColorDialog.classList.add("hidden");
        colorEditing = null;
    }

    /** 确认：把当前 hex 写回后端（colors.json），再前端联动。 */
    async function confirmColorEdit() {
        if (!colorEditing) return;
        const cat = catByColor(colorEditing);
        if (!cat) { closeColorDialog(); return; }
        let hex = ((catColorHexInput && catColorHexInput.value) || (catColorPicker && catColorPicker.value) || "").trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) { showToast("颜色格式非法（需 #rrggbb）"); return; }
        hex = hex.toLowerCase();
        if (hex === (cat.hex || "").toLowerCase()) { closeColorDialog(); return; } // 未变化
        try {
            const resp = await fetch(`/api/classes/${encodeURIComponent(cat.label)}/color`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hex }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) { showToast(data.error || "修改失败"); return; }
            updateCategoryColor(colorEditing, hex);
            closeColorDialog();
            showToast(`已更新「${cat.label}」颜色`);
        } catch (e) {
            showToast("修改失败：" + e.message);
        }
    }

    /**
     * 颜色更新后的前端联动：
     *  - CATEGORIES 该项 hex
     *  - 画布上该类别已有框 hex + 重绘
     *  - 列表重绘（色条 / 圆点 / 进度条 全用新 hex；active 由 renderCategoryList 自动恢复）
     */
    function updateCategoryColor(color, hex) {
        const cat = catByColor(color);
        if (!cat) return;
        cat.hex = hex;
        if (activeCategory.color === color) activeCategory.hex = hex;
        let changed = false;
        currentBoxes.forEach((b) => {
            if (b.label === cat.label && (b.hex || "").toLowerCase() !== hex) {
                b.hex = hex; changed = true;
            }
        });
        if (changed) renderBoxes();
        renderCategoryList();
    }

    /** 绑定右侧类别区域：点击切换当前类别、改色、删除类别、添加新类别。 */
    function bindCategory() {
        if (!categoryList) return;
        categoryList.addEventListener("click", (e) => {
            // 圆点 / 编辑按钮：改色（阻止冒泡，不触发选中）。
            const editBtn = e.target.closest(".cat-edit-btn");
            const dot = e.target.closest(".cat-dot");
            if (editBtn || dot) {
                e.stopPropagation();
                const item = (editBtn || dot).closest(".cat-item");
                if (item) openColorDialog(item.dataset.cat);
                return;
            }
            // 删除按钮：阻止冒泡，不触发选中。
            const delBtn = e.target.closest(".cat-del-btn");
            if (delBtn) {
                e.stopPropagation();
                const item = delBtn.closest(".cat-item");
                if (item) deleteCategory(item.dataset.cat);
                return;
            }
            const item = e.target.closest(".cat-item");
            if (item) selectCategory(item.dataset.cat);
        });

        // 「添加新类别」按钮。
        if (addCatBtn) addCatBtn.addEventListener("click", openAddCategoryDialog);
    }

    // ===================== 添加类别对话框 =====================

    /** 打开「添加新类别」对话框。 */
    function openAddCategoryDialog() {
        if (!catDialog) return;
        // 随机一个起始颜色，避免都默认同一个。
        const palette = ["#0c56d0", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f", "#c62828", "#455a64"];
        const initColor = palette[Math.floor(Math.random() * palette.length)];
        catNameInput.value = "";
        catColorInput.value = initColor;
        updateSwatch(initColor);
        catDialog.classList.remove("hidden");
        setTimeout(() => catNameInput.focus(), 0);
    }

    function closeAddCategoryDialog() {
        if (catDialog) catDialog.classList.add("hidden");
    }

    /** 同步色块预览。 */
    function updateSwatch(hex) {
        if (catSwatch) catSwatch.style.background = hex;
    }

    /** 绑定添加类别对话框交互。 */
    function bindCategoryDialog() {
        if (!catDialog) return;
        // 颜色选择器变化 → 更新预览色块。
        catColorInput.addEventListener("input", () => updateSwatch(catColorInput.value));
        // 确认：校验并新增。
        catConfirmBtn.addEventListener("click", () => {
            const ok = addCategory(catNameInput.value, catColorInput.value);
            if (!ok) {
                catNameInput.classList.add("border-error");
                setTimeout(() => catNameInput.classList.remove("border-error"), 1200);
                return;
            }
            closeAddCategoryDialog();
        });
        // 取消 / 点遮罩 / Esc 关闭。
        catCancelBtn.addEventListener("click", closeAddCategoryDialog);
        catDialog.addEventListener("click", (e) => {
            if (e.target === catDialog) closeAddCategoryDialog();
        });
        // 回车确认。
        catNameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); catConfirmBtn.click(); }
        });
    }

    /** 绑定颜色编辑弹窗交互：色板 / 原生色盘 / hex 输入联动 + 确认 / 取消 / 遮罩。 */
    function bindColorDialog() {
        if (!catColorDialog) return;
        if (catColorPalette) {
            catColorPalette.addEventListener("click", (e) => {
                const sw = e.target.closest(".cat-preset-swatch");
                if (sw) syncColorUI(sw.dataset.hex);
            });
        }
        if (catColorPicker) {
            catColorPicker.addEventListener("input", () => syncColorUI(catColorPicker.value));
        }
        if (catColorHexInput) {
            catColorHexInput.addEventListener("input", () => {
                const v = catColorHexInput.value.trim();
                if (/^#[0-9a-fA-F]{6}$/.test(v)) syncColorUI(v);
            });
        }
        if (catColorConfirmBtn) catColorConfirmBtn.addEventListener("click", confirmColorEdit);
        if (catColorCancelBtn) catColorCancelBtn.addEventListener("click", closeColorDialog);
        catColorDialog.addEventListener("click", (e) => {
            if (e.target === catColorDialog) closeColorDialog();
        });
    }

    /**
     * 绑定检测框交互：点击选中、按住拖动。
     * 拖动位移需除以 view.scale 还原到框本地坐标（舞台有缩放变换）。
     */
    function bindBoxInteraction() {
        if (!canvasBoxes || !canvasFrame) return;

        // 像素位移 → frame 比例（除以 scale 还原到本地坐标）。
        const pxToRatio = (dx, dy) => ({
            x: (dx / canvasFrame.clientWidth) / view.scale,
            y: (dy / canvasFrame.clientHeight) / view.scale,
        });
        const updateBoxEl = (id, b) => {
            const el = canvasBoxes.querySelector(`.bbox[data-box-id="${CSS.escape(id)}"]`);
            if (el) {
                el.style.left = (b.x * 100).toFixed(2) + "%";
                el.style.top = (b.y * 100).toFixed(2) + "%";
                el.style.width = (b.w * 100).toFixed(2) + "%";
                el.style.height = (b.h * 100).toFixed(2) + "%";
            }
        };

        // 统一交互状态：move=拖动整框，resize=调整尺寸，draw=绘制新框。
        let action = null;

        canvasFrame.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            const handleEl = e.target.closest(".handle");
            const edgeEl = e.target.closest(".bbox-edge");

            // SAM 点击分割模式：任意位置点击即触发分割（坐标转换与画框一致）。
            if (samMode) {
                e.stopPropagation();
                e.preventDefault();
                if (!samLoaded) { showToast("请先加载 SAM 模型"); return; }
                if (!activeCategory.label) { showToast("请先选择类别"); return; }
                const r = pxToRatio(
                    e.clientX - canvasFrame.getBoundingClientRect().left,
                    e.clientY - canvasFrame.getBoundingClientRect().top
                );
                segmentAtPoint(clamp(r.x, 0, 1), clamp(r.y, 0, 1));
                return;
            }

            // 绘制模式：任意位置（含已有框内部）都画新框，便于在大目标里框选小目标。
            if (drawMode) {
                e.stopPropagation();
                e.preventDefault();
                // 无类别时不建框，提示先添加类别。
                if (!activeCategory.label) {
                    showToast("请先添加类别");
                    return;
                }
                const r = pxToRatio(
                    e.clientX - canvasFrame.getBoundingClientRect().left,
                    e.clientY - canvasFrame.getBoundingClientRect().top
                );
                const newBox = {
                    id: `box_${nextBoxSeq()}`,
                    label: activeCategory.label, // 当前选中类别的名称
                    score: 100,
                    x: clamp(r.x, 0, 1), y: clamp(r.y, 0, 1),
                    w: 0, h: 0,
                    hex: activeCategory.hex, // 当前选中类别的颜色
                };
                currentBoxes.push(newBox);
                selectedBoxId = newBox.id;
                renderBoxes();
                const el = canvasBoxes.querySelector(`.bbox[data-box-id="${CSS.escape(newBox.id)}"]`);
                if (el) el.classList.add("drawing");
                action = { type: "draw", id: newBox.id, origin: { x: newBox.x, y: newBox.y } };
                return;
            }

            // 普通模式：.bbox 本体中空穿透，只靠 .handle 与 .bbox-edge 命中。
            // 1) 命中调整把手 → resize；
            // 2) 命中边缘条 → 选中并拖动整框；
            // 3) 其余（含框体内部）→ 穿透到下层 / 取消选中。
            if (handleEl) {
                const boxEl = handleEl.closest(".bbox");
                e.stopPropagation();
                e.preventDefault();
                const id = boxEl.dataset.boxId;
                const box = findBox(id);
                if (!box) return;
                selectBox(id);
                action = {
                    type: "resize",
                    id, dir: handleEl.dataset.handle,
                    startBox: { x: box.x, y: box.y, w: box.w, h: box.h },
                    startPx: { x: e.clientX, y: e.clientY },
                };
                return;
            }

            if (edgeEl) {
                e.stopPropagation();
                e.preventDefault();
                const id = edgeEl.dataset.boxId;
                const box = findBox(id);
                if (!box) return;
                selectBox(id);
                action = {
                    type: "move", id,
                    startBox: { x: box.x, y: box.y },
                    startPx: { x: e.clientX, y: e.clientY },
                };
                return;
            }

            if (selectedBoxId) selectBox(null);
        });

        window.addEventListener("mousemove", (e) => {
            if (!action) return;
            const box = findBox(action.id);
            if (!box) return;

            if (action.type === "move") {
                const d = pxToRatio(e.clientX - action.startPx.x, e.clientY - action.startPx.y);
                box.x = clamp(action.startBox.x + d.x, -box.w * 0.8, 1 - box.w * 0.2);
                box.y = clamp(action.startBox.y + d.y, -box.h * 0.8, 1 - box.h * 0.2);
                updateBoxEl(action.id, box);
            } else if (action.type === "resize") {
                const d = pxToRatio(e.clientX - action.startPx.x, e.clientY - action.startPx.y);
                const s = action.startBox;
                let x = s.x, y = s.y, w = s.w, h = s.h;
                const dir = action.dir;
                if (dir.includes("e")) w = s.w + d.x;
                if (dir.includes("s")) h = s.h + d.y;
                if (dir.includes("w")) { x = s.x + d.x; w = s.w - d.x; }
                if (dir.includes("n")) { y = s.y + d.y; h = s.h - d.y; }
                // 处理反向拖拽（宽高变负）：交换边。
                if (w < 0) { x = x + w; w = -w; }
                if (h < 0) { y = y + h; h = -h; }
                box.x = clamp(x, 0, 1); box.y = clamp(y, 0, 1);
                box.w = clamp(w, 0, 1 - box.x); box.h = clamp(h, 0, 1 - box.y);
                updateBoxEl(action.id, box);
            } else if (action.type === "draw") {
                const r = pxToRatio(
                    e.clientX - canvasFrame.getBoundingClientRect().left,
                    e.clientY - canvasFrame.getBoundingClientRect().top
                );
                const cx = clamp(r.x, 0, 1), cy = clamp(r.y, 0, 1);
                box.x = Math.min(action.origin.x, cx);
                box.y = Math.min(action.origin.y, cy);
                box.w = Math.abs(cx - action.origin.x);
                box.h = Math.abs(cy - action.origin.y);
                updateBoxEl(action.id, box);
            }
        });

        window.addEventListener("mouseup", () => {
            let changed = false;
            if (action && action.type === "draw") {
                const box = findBox(action.id);
                // 太小的框（误触）丢弃。
                if (box && (box.w < 0.01 || box.h < 0.01)) {
                    currentBoxes = currentBoxes.filter((b) => b.id !== action.id);
                    selectedBoxId = null;
                } else {
                    changed = true; // 有效新框
                }
                renderBoxes();
            } else if (action && (action.type === "move" || action.type === "resize")) {
                changed = true; // 拖动 / 调尺寸完成
            }
            action = null;
            if (changed) { pushHistory(); scheduleSaveLabels(); }
        });
    }

    // ===================== 通用弹窗（确认框 / Toast，可复用） =====================
    // 用法：
    //   const ok = await showConfirm({ title, message, okText, danger });
    //   showToast("导入失败：xxx");

    let confirmResolver = null; // 当前确认框的 resolve
    let toastTimer = null;

    /**
     * 显示确认对话框，返回用户选择（Promise<boolean>）。
     * @param {Object} opts { title, message, okText, danger, icon }
     * @returns {Promise<boolean>}
     */
    function showConfirm(opts = {}) {
        return new Promise((resolve) => {
            if (!confirmDialog) { resolve(window.confirm(opts.message || "")); return; }
            confirmResolver = resolve;
            confirmTitle.textContent = opts.title || "请确认";
            confirmMsg.textContent = opts.message || "";
            confirmOkBtn.textContent = opts.okText || "确认";
            // 危险动作（如删除）用红色确认键。
            const danger = !!opts.danger;
            confirmIcon.textContent = opts.icon || (danger ? "warning" : "help");
            confirmIcon.className =
                `material-symbols-outlined text-[28px] flex-shrink-0 ${danger ? "text-error" : "text-primary"}`;
            confirmOkBtn.className =
                "flex-1 py-sm text-on-primary hover:opacity-90 font-label-caps text-label-caps rounded-lg transition-all shadow-sm " +
                (danger ? "bg-error" : "bg-primary");
            confirmDialog.classList.remove("hidden");
            setTimeout(() => confirmOkBtn.focus(), 0);
        });
    }

    /** 关闭确认框并回传结果。 */
    function resolveConfirm(ok) {
        if (!confirmDialog) return;
        confirmDialog.classList.add("hidden");
        if (confirmResolver) { confirmResolver(ok); confirmResolver = null; }
    }

    /**
     * 显示轻提示 Toast（自动消失）。
     * @param {string} msg
     * @param {number} [duration=2400] 毫秒
     */
    function showToast(msg, duration = 2400) {
        if (!toastEl) { window.alert(msg); return; }
        toastEl.textContent = msg;
        toastEl.classList.remove("hidden");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.add("hidden"), duration);
    }

    // 通知卡片配置：类型 → 图标名。
    const NOTIFY_ICONS = {
        success: "check",
        info: "info",
        warning: "warning",
        error: "close",
    };

    /**
     * 显示通知卡片（右侧滑入，自动消失，可堆叠）。
     * @param {Object} opts { type, title, message, duration }
     */
    function showNotification(opts = {}) {
        const type = NOTIFY_ICONS[opts.type] ? opts.type : "info";
        const duration = opts.duration || 3000;
        if (!notifyStack) { showToast(opts.title + (opts.message ? "：" + opts.message : "")); return; }

        const card = document.createElement("div");
        card.className = `notify-card ${type}`;
        card.innerHTML = `
            <span class="notify-icon"><span class="material-symbols-outlined">${NOTIFY_ICONS[type]}</span></span>
            <div class="notify-body">
                <div class="notify-title">${escapeHtml(opts.title || "")}</div>
                ${opts.message ? `<div class="notify-message">${escapeHtml(opts.message)}</div>` : ""}
            </div>
            <span class="notify-close" role="button" aria-label="关闭"><span class="material-symbols-outlined">close</span></span>
        `;
        notifyStack.appendChild(card);

        const close = () => {
            card.classList.add("leaving");
            card.addEventListener("animationend", () => card.remove(), { once: true });
        };
        card.querySelector(".notify-close").addEventListener("click", close);
        const timer = setTimeout(close, duration);
        // 悬停时暂停自动消失。
        card.addEventListener("mouseenter", () => clearTimeout(timer));
    }

    /** 绑定通用弹窗交互。 */
    function bindDialogs() {
        if (confirmOkBtn) confirmOkBtn.addEventListener("click", () => resolveConfirm(true));
        if (confirmCancelBtn) confirmCancelBtn.addEventListener("click", () => resolveConfirm(false));
        if (confirmDialog) {
            // 点遮罩 = 取消。
            confirmDialog.addEventListener("click", (e) => {
                if (e.target === confirmDialog) resolveConfirm(false);
            });
        }
    }

    // 暴露通用弹窗 API 到 window，供独立模块（如 train.js）复用，避免重复造轮子或回退原生 confirm/alert。
    window.showConfirm = showConfirm;
    window.showToast = showToast;
    window.showNotification = showNotification;

    // ===================== 自定义右键菜单（按区域分发） =====================
    // 设计：每个可右键区域用 data-ctx-target="<scope>" 标记；对应的菜单 DOM 用
    //       data-ctx="<scope>" 标识。右键时按「最近的 data-ctx-target 祖先」
    //       决定显示哪个菜单。新增区域只需加标记 + 注册菜单，无需改本逻辑。

    // 当前打开的菜单（用于全局关闭）。
    let activeCtxMenu = null;

    /** 显示指定菜单于屏幕坐标。 */
    function showCtxMenu(menuEl, x, y) {
        if (!menuEl) return;
        hideCtxMenu();
        activeCtxMenu = menuEl;
        menuEl.classList.remove("hidden");
        const rect = menuEl.getBoundingClientRect();
        const px = Math.min(x, window.innerWidth - rect.width - 8);
        const py = Math.min(y, window.innerHeight - rect.height - 8);
        menuEl.style.left = Math.max(8, px) + "px";
        menuEl.style.top = Math.max(8, py) + "px";
    }

    function hideCtxMenu() {
        if (activeCtxMenu) {
            activeCtxMenu.classList.add("hidden");
            activeCtxMenu = null;
        }
    }

    /** 绑定右键菜单：按区域分发，未注册区域恢复系统默认菜单。 */
    function bindContextMenu() {
        document.addEventListener("contextmenu", (e) => {
            // 输入框内始终保留系统菜单。
            const tag = (e.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

            // 找最近的「右键区域」祖先，决定显示哪个菜单。
            const zone = e.target.closest("[data-ctx-target]");
            if (!zone) return; // 非注册区域：不拦截，恢复系统菜单

            const scope = zone.dataset.ctxTarget;
            const menuEl = document.querySelector(`[data-ctx="${scope}"]`);
            if (!menuEl) return;

            e.preventDefault();
            if (scope === "canvas") updateNegativeMenuItem(); // 按当前图状态切换「负样本」项文案
            showCtxMenu(menuEl, e.clientX, e.clientY);
        });

        // 点击菜单外或滚动时关闭。
        document.addEventListener("click", (e) => {
            if (activeCtxMenu && !activeCtxMenu.contains(e.target)) hideCtxMenu();
        });
        document.addEventListener("scroll", hideCtxMenu, true);

        // 画布菜单项动作。
        if (ctxMenu) {
            ctxMenu.addEventListener("click", (e) => {
                const item = e.target.closest(".ctx-item");
                if (!item) return;
                const act = item.dataset.act;
                hideCtxMenu();
                if (act === "draw") setDrawMode(!drawMode);
                else if (act === "sam") setSamMode(!samMode);
                else if (act === "delete") deleteSelectedBox();
                else if (act === "reset") resetView();
                else if (act === "clearBoxes") clearAllBoxes();
                else if (act === "negative") toggleNegative();
            });
        }
    }

    // ===================== 键盘：方向键切换 =====================

    /** 按 DOM 顺序取当前选中项的前一个 / 后一个文件名。 */
    function neighborName(dir) {
        const items = Array.from(imageList.querySelectorAll(".img-item"));
        if (!items.length) return null;
        const idx = items.findIndex((n) => n.dataset.name === selectedName);
        if (idx === -1) return items[0].dataset.name;
        const next = items[idx + dir];
        return next ? next.dataset.name : null;
    }

    /** 绑定全局键盘快捷键。 */
    function bindKeys() {
        document.addEventListener("keydown", (e) => {
            // 在输入框内不拦截。
            const tag = (e.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

            if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                const name = neighborName(-1);
                if (name) { e.preventDefault(); selectByName(name); }
            } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                const name = neighborName(1);
                if (name) { e.preventDefault(); selectByName(name); }
            } else if (e.key === "Delete" || e.key === "Backspace") {
                // 删除当前选中的标注框。
                if (selectedBoxId) { e.preventDefault(); deleteSelectedBox(); }
            } else if (e.key === "b" || e.key === "B") {
                // B：切换画框工具。
                e.preventDefault(); setDrawMode(!drawMode);
            } else if (e.key === "s" || e.key === "S") {
                // S：切换 SAM 点击分割。
                e.preventDefault(); setSamMode(!samMode);
            } else if (e.key === "n" || e.key === "N") {
                // N：切换当前图为「负样本」标记。
                e.preventDefault(); toggleNegative();
            } else if (e.key === "Escape") {
                // Esc：关闭对话框 / 退出绘制模式 / 取消选中 / 关闭右键菜单。
                if (confirmDialog && !confirmDialog.classList.contains("hidden")) {
                    e.preventDefault(); resolveConfirm(false);
                } else if (catColorDialog && !catColorDialog.classList.contains("hidden")) {
                    e.preventDefault(); closeColorDialog();
                } else if (catDialog && !catDialog.classList.contains("hidden")) {
                    e.preventDefault(); closeAddCategoryDialog();
                } else if (samMode) setSamMode(false);
                else if (drawMode) setDrawMode(false);
                else if (selectedBoxId) selectBox(null);
                hideCtxMenu();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
                e.preventDefault(); zoomBy(ZOOM_STEP);
            } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
                e.preventDefault(); zoomBy(1 / ZOOM_STEP);
            } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault(); resetView();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
                e.preventDefault();
                e.shiftKey ? redo() : undo();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
                e.preventDefault(); redo();
            }
        });
    }

    /** 将字节数格式化为友好显示。 */
    function formatSize(bytes) {
        if (!bytes && bytes !== 0) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    // 三态视觉配置：pending 待处理（灰）/ negative 负样本（紫）/ done 已处理（绿）。
    // negative 用内联 hex（见 applyItemStatus），其余走 Tailwind class。
    const STATUS_THEMES = {
        pending: {
            state: "hover:bg-surface-variant cursor-pointer",
            thumb: "opacity-70 group-hover:opacity-100",
            name: "text-on-surface-variant group-hover:text-primary",
            statusText: "待处理", statusClass: "text-outline", statusColor: "",
            icon: "radio_button_unchecked",
            iconClass: "text-outline opacity-0 group-hover:opacity-100 transition-opacity", iconColor: "",
        },
        negative: {
            state: "cursor-pointer",
            thumb: "opacity-70 group-hover:opacity-100",
            name: "text-on-surface-variant group-hover:text-primary",
            statusText: "负样本", statusClass: "", statusColor: "#7c6ff0",
            icon: "image_not_supported", iconClass: "", iconColor: "#7c6ff0",
        },
        done: {
            state: "bg-surface-container-highest border border-primary/30",
            thumb: "",
            name: "text-primary",
            statusText: "已处理", statusClass: "text-on-surface-variant", statusColor: "",
            icon: "check_circle", iconClass: "text-primary", iconColor: "",
        },
    };

    /**
     * 统一应用图片卡片的「状态视觉」。可重复调用：每次全量覆盖目标态的 class/style，
     * 并从 dataset.size 重算大小提示。renderImageItem 初始化、保存后状态更新、
     * 标记/取消负样本都走这里，避免分散的 classList 操作。
     */
    function applyItemStatus(node, status) {
        if (!node) return;
        const t = STATUS_THEMES[status] || STATUS_THEMES.pending;
        node.dataset.status = status;

        // 卡片整体：状态 class 全量覆盖；negative 额外用内联淡紫底 + 紫色左边线。
        node.className = `img-item flex items-center gap-sm p-xs rounded transition-all group ${t.state}`;
        if (status === "negative") {
            node.style.backgroundColor = "rgba(124,111,240,0.07)";
            node.style.borderLeft = "2px solid #7c6ff0";
        } else {
            node.style.backgroundColor = "";
            node.style.borderLeft = "";
        }

        const thumb = node.querySelector(".w-10.h-10");
        if (thumb) thumb.className = `w-10 h-10 rounded overflow-hidden flex-shrink-0 ${t.thumb}`;

        const nameEl = node.querySelector("p.truncate");
        if (nameEl) nameEl.className = `truncate text-xs font-label-mono ${t.name}`;

        const sizeTip = node.dataset.size ? ` · ${formatSize(Number(node.dataset.size))}` : "";
        const statusEl = node.querySelector(".img-status");
        if (statusEl) {
            statusEl.className = `img-status text-[10px] ${t.statusClass}`;
            statusEl.style.color = t.statusColor;
            statusEl.textContent = t.statusText + sizeTip;
        }

        const icon = node.querySelector(".status-icon");
        if (icon) {
            icon.className = `material-symbols-outlined text-sm status-icon ${t.iconClass}`;
            icon.style.color = t.iconColor;
            icon.textContent = t.icon;
        }
    }

    /**
     * 渲染单张图片卡片（结构 + 交由 applyItemStatus 上状态视觉）。
     * @param {Object} img { name, url, status, size }
     */
    function renderImageItem(img) {
        const item = document.createElement("div");
        item.dataset.name = img.name;
        item.dataset.size = img.size || ""; // 供 applyItemStatus 重算大小提示
        const thumbSrc = img.thumb_url || img.url;

        item.innerHTML = `
            <div class="w-10 h-10 rounded overflow-hidden flex-shrink-0">
                <img class="w-full h-full object-cover" loading="lazy" decoding="async"
                    src="${thumbSrc}" alt="${img.name}" />
            </div>
            <div class="flex-1 min-w-0">
                <p class="truncate text-xs font-label-mono">${img.name}</p>
                <p class="img-status text-[10px]"></p>
            </div>
            <span class="material-symbols-outlined text-sm status-icon"></span>
            <button type="button" title="删除图片"
                class="img-del-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-outline hover:text-error hover:bg-error/10 transition-all opacity-0 group-hover:opacity-100">
                <span class="material-symbols-outlined text-[16px]">close</span>
            </button>
        `;
        applyItemStatus(item, img.status);
        return item;
    }

    /**
     * 删除单张图片（走后端）。联动删除原图 + 同名标注 txt + 缩略图；
     * 删除当前选中图则切到相邻图，列表空则回到画布空状态。
     * @param {string} name 图片文件名
     * @returns {boolean} 是否成功删除
     */
    async function deleteImage(name) {
        const node = imageList.querySelector(`.img-item[data-name="${CSS.escape(name)}"]`);
        if (!node) return false;
        const hasLabel = node.dataset.status !== "pending";
        const ok = await showConfirm({
            title: "删除图片",
            message: hasLabel
                ? `确定删除图片「${name}」吗？其标注文件将一并删除，此操作不可撤销。`
                : `确定删除图片「${name}」吗？此操作不可撤销。`,
            okText: "删除",
            danger: true,
        });
        if (!ok) return false;

        const wasSelected = selectedName === name;
        // 删除前先取好相邻图（删除后 DOM 变化），优先后一张。
        const nextName = wasSelected ? (neighborName(1) || neighborName(-1)) : null;
        // 若该图正等待保存，取消挂起的保存（避免删后 PUT 已不存在的图）。
        if (pendingSaveName === name) { clearTimeout(saveTimer); pendingSaveName = null; }

        try {
            const resp = await fetch(`/api/project/image/${encodeURIComponent(name)}`, { method: "DELETE" });
            const data = await resp.json();
            if (!resp.ok || !data.ok) { showToast(data.error || "删除失败"); return false; }
        } catch (e) {
            showToast("删除失败：" + e.message);
            return false;
        }

        // 清理前端缓存：DOM 节点 + 撤销/重做栈 + 检测去重缓存。
        node.remove();
        undoStack.delete(name);
        redoStack.delete(name);
        for (const key of [...detectedCache]) {
            if (key.startsWith(name + "@")) detectedCache.delete(key);
        }
        // 刷新计数；删了带标注的图才需重拉类别统计。
        updateProgress();
        refreshMeta(imageList.querySelectorAll(".img-item").length);
        if (hasLabel) fetchStats();

        if (wasSelected) {
            if (nextName) {
                selectByName(nextName);
            } else {
                // 列表空 → 回到画布空状态。
                selectedName = null;
                selectedBoxId = null;
                currentBoxes = [];
                renderBoxes();
                if (canvasEmpty) canvasEmpty.classList.remove("hidden");
                if (canvasArea) canvasArea.classList.add("hidden");
            }
        }
        showToast(`已删除「${name}」`);
        return true;
    }

    /** 刷新画布右键菜单「负样本」项的文案/图标（按当前选中图状态）。 */
    function updateNegativeMenuItem() {
        if (!ctxMenu) return;
        const btn = ctxMenu.querySelector('[data-act="negative"]');
        if (!btn) return;
        const node = selectedName && imageList.querySelector(`.img-item[data-name="${CSS.escape(selectedName)}"]`);
        const isNegative = !!(node && node.dataset.status === "negative");
        const label = btn.querySelector(".ctx-label");
        const icon = btn.querySelector("span.material-symbols-outlined");
        if (label) label.textContent = isNegative ? "取消负样本标记" : "标记为负样本";
        if (icon) icon.textContent = isNegative ? "undo" : "image_not_supported";
    }

    /**
     * 切换当前选中图的「负样本」标记。
     * 非负样本 → 写空 txt + 清空画布框；负样本 → 删空 txt 回待处理。
     */
    async function toggleNegative() {
        if (!selectedName) return;
        const node = imageList.querySelector(`.img-item[data-name="${CSS.escape(selectedName)}"]`);
        if (!node) return;
        const isNegative = node.dataset.status === "negative";

        // 从非负样本标记时，若已有标注框，先确认清空（避免误丢标注）。
        if (!isNegative && currentBoxes.length > 0) {
            const ok = await showConfirm({
                title: "标记为负样本",
                message: "标记为负样本将清空当前所有标注框，确定？",
                okText: "标记负样本",
                danger: true,
            });
            if (!ok) return;
        }

        try {
            const resp = await fetch(`/api/labels/${encodeURIComponent(selectedName)}/negative`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ negative: !isNegative }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                showNotification({ type: "error", title: "操作失败", message: data.error || "" });
                return;
            }
            if (!isNegative) {
                // 标记为负样本：清空画布框 + 重建撤销栈。
                currentBoxes = [];
                selectedBoxId = null;
                renderBoxes();
                resetHistoryForCurrent();
                applyItemStatus(node, "negative");
                if (node._img) node._img.status = "negative";
            } else {
                applyItemStatus(node, "pending");
                if (node._img) node._img.status = "pending";
            }
            // 清掉挂起的保存，避免随后误存空标注把负样本空 txt 删掉。
            pendingSaveName = null;
            clearTimeout(saveTimer);
            updateProgress();
            fetchStats();
            updateNegativeMenuItem();
        } catch (e) {
            showNotification({ type: "error", title: "操作失败", message: e.message || "" });
        }
    }

    /**
     * 批量标准化负样本：把所有 _bad.txt 标记转为空 <stem>.txt（YOLO 负样本）并删除 _bad.txt。
     * 用于导入带 _bad 约定的外部数据集后，让负样本真正参与 YOLO 训练（否则 YOLO 会忽略它们）。
     */
    async function normalizeNegatives() {
        const ok = await showConfirm({
            title: "标准化负样本",
            message: "将把所有 _bad 标记的负样本转为标准空 txt（供 YOLO 训练当背景图），并删除 _bad 文件。已标注的图不受影响。确定？",
            okText: "标准化",
        });
        if (!ok) return;
        try {
            const resp = await fetch("/api/project/normalize_negatives", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                showNotification({ type: "error", title: "标准化失败", message: data.error || "" });
                return;
            }
            const normalized = data.normalized || 0;
            const cleaned = data.cleaned || 0;
            if (cleaned === 0) {
                showToast("没有需要标准化的 _bad 负样本");
            } else {
                showNotification({
                    type: "success",
                    title: "标准化完成",
                    message: `已转换 ${normalized} 张为空 txt，清理 ${cleaned} 个 _bad 文件`,
                });
            }
            fetchStats();
        } catch (e) {
            showNotification({ type: "error", title: "标准化失败", message: e.message || "" });
        }
    }

    /**
     * 切换中间展示区为指定图片。
     * @param {Object} img 选中的图片记录（取 url 原图展示）
     */
    async function selectImage(img) {
        // 切换前：若旧图有未保存改动，强制 flush（防抖不等）。
        if (selectedName && selectedName !== img.name) {
            try { await flushSaveLabels(); } catch (e) { /* 忽略，继续切图 */ }
        }
        selectedName = img.name;

        // 选中态：列表项高亮（与「已处理」区分：用更明显的 primary 背景 + 左描边）。
        let activeNode = null;
        imageList.querySelectorAll(".img-item").forEach((node) => {
            const isSelected = node.dataset.name === img.name;
            node.classList.toggle("ring-2", isSelected);
            node.classList.toggle("ring-primary", isSelected);
            node.classList.toggle("bg-primary/5", isSelected);
            node.classList.toggle("border-primary/40", isSelected);
            if (isSelected) activeNode = node;
        });
        // 让选中项滚动进入可视区（键盘连续切换时尤其重要）。
        if (activeNode) activeNode.scrollIntoView({ block: "nearest", behavior: "smooth" });

        // 画布显示原图。
        if (canvasImage) canvasImage.src = img.url;
        if (canvasImage) canvasImage.alt = img.name;
        if (canvasName) canvasName.textContent = img.name;
        if (canvasSize) canvasSize.textContent = img.size ? formatSize(img.size) : "";
        if (canvasEmpty) canvasEmpty.classList.add("hidden");
        if (canvasArea) canvasArea.classList.remove("hidden");

        // 切换图片：重置视图 + 加载该图已有标注（替代演示框）。
        resetView();
        currentBoxes = await loadBoxesForImage(img.name);
        selectedBoxId = null;
        renderBoxes();
        pendingSaveName = null; // 新图刚加载，无需保存
        resetHistoryForCurrent(); // 切图重建撤销栈：以当前标注为初始快照

        // 自动标注模式：切换图片时自动触发检测（去重保护在 detectCurrent 内）
        if (autoDetect) detectCurrent(false);
    }

    /** 加载某图已有标注（YOLO txt 经后端转回左上角格式）。无则空。 */
    async function loadBoxesForImage(imageName) {
        try {
            const resp = await fetch(`/api/labels/${encodeURIComponent(imageName)}`);
            const data = await resp.json();
            if (!resp.ok || !data.ok) return [];
            return (data.boxes || []).map((b) => ({ ...b, id: "box_" + nextBoxSeq() }));
        } catch (e) {
            return [];
        }
    }

    // ===== 自动保存（防抖 400ms） =====
    let saveTimer = null;
    let pendingSaveName = null; // 正在等待保存的图片文件名

    /** 调度一次保存（400ms 内连续操作合并）。 */
    function scheduleSaveLabels() {
        if (!selectedName) return;
        pendingSaveName = selectedName;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSaveLabels, 400);
    }

    /** 立即保存当前 pending 图的标注（快照后 PUT）。 */
    async function flushSaveLabels() {
        clearTimeout(saveTimer);
        const name = pendingSaveName;
        if (!name) return;
        pendingSaveName = null;
        // 快照当前框（label + class_id + 左上角坐标），避免保存中途被下一张改动。
        const boxes = currentBoxes.map((b) => ({
            label: b.label, class_id: b.class_id, x: b.x, y: b.y, w: b.w, h: b.h,
        }));
        try {
            const resp = await fetch(`/api/labels/${encodeURIComponent(name)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ boxes }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                showNotification({ type: "error", title: "保存失败", message: data.error || "" });
                return;
            }
            const n = data.count || 0;
            // 标注变更后刷新全项目类别统计。
            fetchStats();
            // 根据框数更新当前图片状态。
            if (selectedName) {
                const node = imageList.querySelector(`.img-item[data-name="${CSS.escape(selectedName)}"]`);
                if (node) {
                    if (n > 0) {
                        if (node.dataset.status !== "done") {
                            applyItemStatus(node, "done");
                            if (node._img) node._img.status = "done";
                        }
                    } else {
                        // n === 0：仅把「已处理(done)被清空」降为 pending；
                        // 负样本(negative)的空 txt 是合法落盘状态，保持不变，
                        // 避免自动标注空识别等空保存把负样本误降级为 pending。
                        if (node.dataset.status === "done") {
                            applyItemStatus(node, "pending");
                            if (node._img) node._img.status = "pending";
                        }
                    }
                    updateProgress();
                }
            }
            showNotification({
                type: "success",
                title: "坐标保存成功",
                message: n > 0 ? `已保存 ${n} 个标注框` : "标注已清空",
            });
        } catch (e) {
            showNotification({ type: "error", title: "保存失败", message: e.message });
        }
    }

    /**
     * 根据图片文件名在当前列表中查找记录并选中。
     * （首屏服务端渲染的卡片只带 data-name，需回到节点上取原图地址。）
     */
    function selectByName(name) {
        const node = imageList.querySelector(`.img-item[data-name="${CSS.escape(name)}"]`);
        if (!node) return;
        const imgTag = node.querySelector("img");
        // 动态插入的节点会缓存完整记录；首屏节点则从 DOM 现场取。
        const record = node._img || {
            name: name,
            url: node.dataset.url || (imgTag ? imgTag.getAttribute("src") : ""),
            status: node.dataset.status,
            size: node.dataset.size ? Number(node.dataset.size) : 0,
        };
        selectImage(record);
    }

    /** 刷新顶部计数（已处理 / 总图片数）与空状态显示。 */
    function refreshMeta(total) {
        if (imageCount) {
            const items = imageList.querySelectorAll(".img-item");
            const done = Array.from(items).filter((n) => n.dataset.status === "done" || n.dataset.status === "negative").length;
            imageCount.textContent = `已处理 ${total ? done : 0} / ${total || 0}`;
        }
        if (emptyHint) emptyHint.classList.toggle("hidden", total > 0);
    }

    /** 更新画布上方进度条（已处理 / 未处理 / 总计）。已与 refreshMeta 同步。 */
    function updateProgress() {
        if (!canvasProgress) return;
        const items = imageList.querySelectorAll(".img-item");
        const total = items.length;
        const done = Array.from(items).filter((n) => n.dataset.status === "done" || n.dataset.status === "negative").length;
        const pending = total - done;
        canvasProgress.textContent = total
            ? `已处理 ${done} / ${total} 张 · 未处理 ${pending} 张`
            : "-";
        // 同步左侧计数
        if (imageCount) imageCount.textContent = `已处理 ${total ? done : 0} / ${total || 0}`;
    }

    /** 渲染项目图片列表（替换当前列表全部内容）。 */
    function renderImageList(images) {
        imageList.innerHTML = "";
        if (!images || !images.length) {
            refreshMeta(0);
            return;
        }
        images.forEach((img) => {
            const node = renderImageItem(img);
            node._img = img; // 缓存完整记录，供选中时取用
            node.dataset.url = img.url;
            node.dataset.size = img.size || "";
            imageList.appendChild(node);
        });
        refreshMeta(images.length);
        updateProgress();
        // 默认选中第一张并在画布展示。
        const first = imageList.querySelector(".img-item");
        if (first) selectByName(first.dataset.name);
    }

    /** 调接口刷新并重渲染图片列表。 */
    async function loadProjectImages() {
        try {
            const resp = await fetch("/api/project/refresh");
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "刷新失败");
            renderImageList(data.images);
            fetchStats();
        } catch (e) {
            showToast("加载图片失败：" + e.message);
        }
    }

    // ===================== 目录浏览对话框 =====================

    let browseParentPath = null; // 当前浏览目录的上级路径（由 API 返回）

    /** 打开目录浏览对话框。 */
    async function openBrowseDialog() {
        if (!browseDialog) return;
        browseDialog.classList.remove("hidden");
        browseManualPath.value = "";
        loadBrowseRecent(); // 拉取最新历史项目列表
        await loadBrowseDir("");
    }

    /** 加载并渲染历史项目列表（无历史则隐藏区块）。 */
    async function loadBrowseRecent() {
        if (!browseRecentList || !browseRecentSection) return;
        try {
            const resp = await fetch("/api/project/recent");
            const data = await resp.json();
            const items = (data.items || []).filter(Boolean);
            if (!items.length) {
                browseRecentSection.classList.add("hidden");
                browseRecentList.innerHTML = "";
                return;
            }
            browseRecentSection.classList.remove("hidden");
            browseRecentList.innerHTML = "";
            items.forEach((it) => {
                const missing = !it.exists;
                const row = document.createElement("div");
                row.className = "group flex items-center gap-sm px-sm py-[6px] rounded-lg hover:bg-primary/5 transition-all" + (missing ? " cursor-not-allowed" : " cursor-pointer");
                row.innerHTML = `
                    <span class="material-symbols-outlined ${missing ? "text-outline" : "text-primary"} text-[18px] flex-shrink-0">${missing ? "folder_off" : "folder"}</span>
                    <div class="min-w-0 flex-1">
                        <div class="font-label-mono text-xs ${missing ? "text-outline line-through" : "text-on-surface"} truncate">${escapeHtml(it.name)}</div>
                        <div class="font-label-mono text-[10px] text-outline truncate">${escapeHtml(it.path)}</div>
                    </div>
                    <span class="font-label-mono text-[10px] ${missing ? "text-error" : "text-outline"} flex-shrink-0">${missing ? "已缺失" : it.imageCount + " 张"}</span>
                    <button type="button" title="移出历史"
                        class="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-outline hover:text-error hover:bg-error/10 transition-all flex-shrink-0">
                        <span class="material-symbols-outlined text-[16px]">close</span>
                    </button>
                `;
                // 点击行 → 打开项目（仅当存在）。
                row.addEventListener("click", async (e) => {
                    if (e.target.closest("button")) return; // 移除按钮单独处理
                    if (missing) {
                        showToast("该路径已不存在，可点击右侧 × 移出历史");
                        return;
                    }
                    await openProject(it.path);
                    closeBrowseDialog();
                });
                // 移除按钮：删除该历史项后刷新列表（不关对话框，方便连删）。
                row.querySelector("button").addEventListener("click", async (e) => {
                    e.stopPropagation();
                    await removeRecentProject(it.path);
                });
                browseRecentList.appendChild(row);
            });
        } catch (e) { /* 静默：历史列表加载失败不影响目录浏览 */ }
    }

    /** 从历史列表移除一条。 */
    async function removeRecentProject(path) {
        try {
            const resp = await fetch("/api/project/recent", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "移除失败");
            await loadBrowseRecent();
        } catch (e) {
            showToast("移除失败：" + e.message);
        }
    }

    function closeBrowseDialog() {
        if (browseDialog) browseDialog.classList.add("hidden");
    }

    /** 加载指定路径的子目录列表。 */
    async function loadBrowseDir(path) {
        if (!browseDirList || !browseCurrentPath) return;
        browseDirList.innerHTML = `<div class="p-md text-center text-outline text-xs">加载中…</div>`;
        try {
            const params = path ? `?path=${encodeURIComponent(path)}` : "";
            const resp = await fetch(`/api/browse${params}`);
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "浏览失败");
            browseCurrentPath.textContent = data.current || "根目录";
            browseParentPath = data.parent || null;
            if (browseUpBtn) browseUpBtn.disabled = !browseParentPath;
            browseDirList.innerHTML = "";
            if (data.dirs && data.dirs.length) {
                data.dirs.forEach((d) => {
                    const item = document.createElement("div");
                    item.className = "flex items-center gap-sm p-sm rounded cursor-pointer hover:bg-surface-variant transition-all";
                    item.innerHTML = `
                        <span class="material-symbols-outlined text-primary text-lg">folder</span>
                        <span class="text-xs font-label-mono truncate">${escapeHtml(d.name)}</span>
                    `;
                    item.addEventListener("click", () => loadBrowseDir(d.path));
                    browseDirList.appendChild(item);
                });
            } else {
                // 无子目录：提示可选择当前目录（含 images/ 子目录的项目）
                const info = document.createElement("div");
                info.className = "p-md text-center text-outline text-xs";
                info.textContent = "此目录下无子目录，可直接选择当前目录";
                browseDirList.appendChild(info);
            }
        } catch (e) {
            browseDirList.innerHTML = `<div class="p-md text-center text-error text-xs">加载失败：${escapeHtml(e.message)}</div>`;
        }
    }

    /** 确认选择当前浏览目录作为项目根（手动输入优先）。 */
    async function selectBrowseDir() {
        const manual = (browseManualPath.value || "").trim();
        const path = manual || browseCurrentPath.textContent;
        if (!path || path === "根目录") {
            showToast("请先选择或输入一个目录");
            return;
        }
        await openProject(path);
        closeBrowseDialog();
    }

    /** 手动输入路径打开项目。 */
    async function openManualPath() {
        const path = (browseManualPath.value || "").trim();
        if (!path) { showToast("请输入项目路径"); return; }
        await openProject(path);
        closeBrowseDialog();
    }

    // ===================== 项目打开 / 刷新 =====================

    /** 打开项目并加载全部数据（图片 + 类别 + 颜色）。 */
    async function openProject(path) {
        try {
            const resp = await fetch("/api/project/open", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "打开失败");

            currentProject = { path: data.projectPath, isNew: data.isNew };
            // 更新顶部信息。
            if (projectTitle) projectTitle.textContent = data.isNew ? "新项目（已初始化）" : "项目已打开";
            if (projectPathEl) projectPathEl.textContent = data.projectPath;
            if (refreshTopBtn) refreshTopBtn.classList.remove("hidden");

            // 加载类别与颜色。
            CATEGORIES = (data.categories || []).map((c) => ({
                label: c.label,
                hex: c.hex,
                color: "cid_" + c.id,
            }));
            activeCategory = CATEGORIES[0] || activeCategory;
            renderCategoryList();
            if (CATEGORIES.length) selectCategory(activeCategory.color);

            // 渲染图片列表 + 拉取全项目统计。
            renderImageList(data.images);
            fetchStats();

            showNotification({
                type: "success",
                title: data.isNew ? "新项目已创建" : "项目已打开",
                message: `${data.images.length} 张图片`,
            });
        } catch (e) {
            showToast("打开项目失败：" + e.message);
        }
    }

    /** 刷新当前项目图片列表。 */
    async function refreshProject() {
        if (!currentProject) {
            showToast("请先打开项目");
            return;
        }
        await loadProjectImages();
    }

    // ===================== 模型文件浏览与加载 =====================

    let modelBrowseParentPath = null;

    /** 支持的模型文件扩展名（传参给 /api/browse?files=...）。 */
    const MODEL_EXTS = ".pt,.onnx";

    /** 打开模型文件浏览对话框。 */
    async function openModelBrowseDialog() {
        if (!modelBrowseDialog) return;
        modelBrowseDialog.classList.remove("hidden");
        if (modelBrowseManualPath) modelBrowseManualPath.value = "";
        await loadModelBrowseDir("");
    }

    function closeModelBrowseDialog() {
        if (modelBrowseDialog) modelBrowseDialog.classList.add("hidden");
    }

    /** 加载指定路径的目录 + 模型文件列表。 */
    async function loadModelBrowseDir(path) {
        if (!modelBrowseList || !modelBrowseCurrentPath) return;
        modelBrowseList.innerHTML = `<div class="p-md text-center text-outline text-xs">加载中…</div>`;
        try {
            const params = path ? `?path=${encodeURIComponent(path)}&files=${encodeURIComponent(MODEL_EXTS)}` : `?files=${encodeURIComponent(MODEL_EXTS)}`;
            const resp = await fetch(`/api/browse${params}`);
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "浏览失败");
            modelBrowseCurrentPath.textContent = data.current || "根目录";
            modelBrowseParentPath = data.parent || null;
            if (modelBrowseUpBtn) modelBrowseUpBtn.disabled = !modelBrowseParentPath;
            modelBrowseList.innerHTML = "";

            // 渲染子目录
            if (data.dirs && data.dirs.length) {
                data.dirs.forEach((d) => {
                    const item = document.createElement("div");
                    item.className = "flex items-center gap-sm p-sm rounded cursor-pointer hover:bg-surface-variant transition-all";
                    item.innerHTML = `<span class="material-symbols-outlined text-primary text-lg">folder</span><span class="text-xs font-label-mono truncate">${escapeHtml(d.name)}</span>`;
                    item.addEventListener("click", () => loadModelBrowseDir(d.path));
                    modelBrowseList.appendChild(item);
                });
            }
            // 渲染模型文件
            if (data.files && data.files.length) {
                data.files.forEach((f) => {
                    const item = document.createElement("div");
                    item.className = "flex items-center gap-sm p-sm rounded cursor-pointer hover:bg-primary/10 transition-all border border-primary/20";
                    item.innerHTML = `
                        <span class="material-symbols-outlined text-primary text-lg">memory</span>
                        <span class="text-xs font-label-mono text-primary truncate flex-1">${escapeHtml(f.name)}</span>
                        <span class="text-[10px] text-outline font-label-mono">${formatSize(f.size)}</span>
                    `;
                    item.addEventListener("click", () => {
                        if (modelBrowseManualPath) modelBrowseManualPath.value = f.path;
                    });
                    // 双击直接选择
                    item.addEventListener("dblclick", () => {
                        if (modelBrowseManualPath) modelBrowseManualPath.value = f.path;
                        selectModelBrowseFile();
                    });
                    modelBrowseList.appendChild(item);
                });
            }
            if ((!data.dirs || !data.dirs.length) && (!data.files || !data.files.length)) {
                const info = document.createElement("div");
                info.className = "p-md text-center text-outline text-xs";
                info.textContent = "此目录下无子目录和模型文件";
                modelBrowseList.appendChild(info);
            }
        } catch (e) {
            modelBrowseList.innerHTML = `<div class="p-md text-center text-error text-xs">加载失败：${escapeHtml(e.message)}</div>`;
        }
    }

    /** 确认选择当前浏览的模型文件（手动输入优先）。 */
    async function selectModelBrowseFile() {
        const manual = (modelBrowseManualPath ? modelBrowseManualPath.value.trim() : "");
        const dirPath = modelBrowseCurrentPath ? modelBrowseCurrentPath.textContent : "";
        const path = manual || dirPath;
        if (!path || path === "根目录") {
            showToast("请先选择或输入一个模型文件路径");
            return;
        }
        // 如果 path 是目录，提示选具体文件
        if (!manual && path === dirPath) {
            showToast("请选择一个模型文件（单击选中后双击确认，或手动输入完整路径）");
            return;
        }
        // 后缀校验：仅 .pt / .onnx
        const ext = "." + path.split(".").pop().toLowerCase();
        if (ext !== ".pt" && ext !== ".onnx") {
            await showConfirm({
                title: "模型格式不支持",
                message: `仅支持 .pt（PyTorch）或 .onnx（ONNX）格式的模型文件。\n\n当前路径后缀：${ext}`,
                okText: "知道了",
                danger: false,
            });
            return;
        }
        if (modelPathInput) modelPathInput.value = path;
        closeModelBrowseDialog();
    }

    /** 手动输入路径后直接使用。 */
    async function openModelManualPath() {
        const path = (modelBrowseManualPath ? modelBrowseManualPath.value.trim() : "");
        if (!path) { showToast("请输入模型文件路径"); return; }
        // 后缀校验：仅 .pt / .onnx
        const ext = "." + path.split(".").pop().toLowerCase();
        if (ext !== ".pt" && ext !== ".onnx") {
            await showConfirm({
                title: "模型格式不支持",
                message: `仅支持 .pt（PyTorch）或 .onnx（ONNX）格式的模型文件。\n\n当前路径后缀：${ext}`,
                okText: "知道了",
                danger: false,
            });
            return;
        }
        if (modelPathInput) modelPathInput.value = path;
        closeModelBrowseDialog();
    }

    /** 加载模型：先校验后缀，再调用 /api/model/load，更新状态栏。 */
    async function loadModel() {
        const path = (modelPathInput ? modelPathInput.value.trim() : "");
        if (!path) { showToast("请先输入或选择模型文件路径"); return; }

        // 客户端后缀校验：仅 .pt / .onnx。
        const ext = "." + path.split(".").pop().toLowerCase();
        if (ext !== ".pt" && ext !== ".onnx") {
            const ok = await showConfirm({
                title: "模型格式不支持",
                message: `仅支持 .pt（PyTorch）或 .onnx（ONNX）格式的模型文件。\n\n当前文件后缀：${ext}`,
                okText: "重新选择",
                danger: false,
            });
            return;
        }
        if (loadModelBtn) {
            loadModelBtn.disabled = true;
            loadModelBtn.textContent = "加载中…";
        }
        try {
            const resp = await fetch("/api/model/load", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "加载失败");

            // 更新状态栏。
            if (modelStatusDot) {
                modelStatusDot.className = "w-2 h-2 rounded-full bg-emerald-500 animate-pulse";
            }
            if (modelStatusText) {
                modelStatusText.textContent = `模型：${data.model.name}`;
            }
            if (modelLatency) modelLatency.textContent = "延迟：--";
            if (modelGpu) {
                const dev = data.device || "cpu";
                modelGpu.textContent = `设备：${dev}`;
            }
            if (modelHint) {
                const labels = data.labels && data.labels.length ? `（类别：${data.labels.join("、")}）` : "";
                modelHint.textContent = `✓ 已加载 ${data.model.name}（${data.model.format}）${labels}`;
                modelHint.classList.remove("hidden");
            }
            // 清空检测缓存（换了模型）
            detectedCache.clear();

            showNotification({
                type: "success",
                title: "模型已加载",
                message: `${data.model.name}（${data.model.format}）→ ${data.device || "cpu"}`,
            });
        } catch (e) {
            showToast("加载模型失败：" + e.message);
            if (modelStatusDot) modelStatusDot.className = "w-2 h-2 rounded-full bg-error";
            if (modelStatusText) modelStatusText.textContent = "模型：加载失败";
            if (modelHint) {
                modelHint.textContent = "✗ " + e.message;
                modelHint.classList.remove("hidden");
            }
        } finally {
            if (loadModelBtn) {
                loadModelBtn.disabled = false;
                loadModelBtn.textContent = "加载模型";
            }
        }
    }

    // ===================== 目标检测 =====================

    /** 对当前选中图片执行目标检测。自动标注模式下在切换图片时调用。 */
    async function detectCurrent(force = false) {
        if (!selectedName) return;
        if (!detectorLoaded()) { showToast("请先加载模型文件"); return; }

        // 取消上一次未完成的请求
        if (detectAbort) { detectAbort.abort(); detectAbort = null; }

        // 去重：已检测过且非强制
        const cacheKey = `${selectedName}@${confThreshold}`;
        if (!force && detectedCache.has(cacheKey)) return;

        detectAbort = new AbortController();
        if (detectBtn) {
            detectBtn.classList.add("animate-pulse");
            detectBtn.style.color = "var(--color-primary, #003d9b)";
        }
        if (canvasProgress) canvasProgress.classList.remove("hidden");

        try {
            const resp = await fetch(`/api/detect/${encodeURIComponent(selectedName)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conf: confThreshold / 100, force }),
                signal: detectAbort.signal,
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "检测失败");

            if (data.cached) {
                // 服务端返回 cached=true，说明已经检测过（但客户端 cache 丢了）
                detectedCache.add(cacheKey);
                return;
            }

            // 转换框数据到 currentBoxes 格式（整批替换，先记录一次便于撤销整批识别）
            suppressHistory = true; // 替换过程本身不入栈
            currentBoxes = (data.boxes || []).map((b, i) => ({
                id: `${selectedName}_det_${i}`,
                label: b.label,
                class_id: b.class_id,
                score: b.score || 100,
                x: b.x, y: b.y, w: b.w, h: b.h,
                hex: b.hex || hexOfLabel(b.label) || "#003d9b",
            }));
            selectedBoxId = null;
            renderBoxes();
            detectedCache.add(cacheKey);
            suppressHistory = false;
            pushHistory();          // 识别结果作为一次可撤销的改动入栈
            scheduleSaveLabels();   // 自动识别出的框也要落盘

            // 更新状态栏
            if (modelLatency) modelLatency.textContent = `延迟：${data.elapsed_ms ?? "--"}ms`;
            if (modelGpu) modelGpu.textContent = `设备：${data.device || "--"}`;

            const count = data.boxes.length;
            const label = autoDetect ? `自动标注：${count} 个目标` : `识别完成：${count} 个目标`;
            showNotification({ type: count ? "success" : "info", title: label, message: selectedName });

        } catch (e) {
            if (e.name === "AbortError") return; // 被取消，忽略
            // 自动模式下静默失败
            if (!autoDetect) showToast("识别失败：" + e.message);
        } finally {
            detectAbort = null;
            if (detectBtn) {
                detectBtn.classList.remove("animate-pulse");
                detectBtn.style.color = "";
            }
            if (canvasProgress) canvasProgress.classList.add("hidden");
        }
    }

    /** 检查模型是否已加载。 */
    function detectorLoaded() {
        // 通过状态栏文本判断（HACK：也可以维护一个 JS 变量）
        return modelStatusDot && modelStatusDot.classList.contains("bg-emerald-500");
    }

    // ===================== SAM 2 分割（独立引擎，与 YOLO 并列） =====================

    /** 加载 SAM 2 模型。 */
    async function loadSam() {
        const variant = samVariantSelect ? samVariantSelect.value : "large";
        const checkpoint = samCheckpointInput ? samCheckpointInput.value.trim() : "";
        if (loadSamBtn) { loadSamBtn.disabled = true; loadSamBtn.textContent = "加载中…"; }
        try {
            const resp = await fetch("/api/sam/load", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ variant, checkpoint }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "加载失败");
            samLoaded = true;
            if (samStatusDot) samStatusDot.className = "w-2 h-2 rounded-full bg-emerald-500 animate-pulse";
            if (samStatusText) samStatusText.textContent = `SAM：${data.variant}`;
            showNotification({
                type: "success",
                title: "SAM 模型已加载",
                message: `${data.variant} → ${data.device || "cpu"}`,
            });
        } catch (e) {
            showToast("SAM 加载失败：" + e.message);
            if (samStatusDot) samStatusDot.className = "w-2 h-2 rounded-full bg-error";
            if (samStatusText) samStatusText.textContent = "SAM：加载失败";
        } finally {
            if (loadSamBtn) { loadSamBtn.disabled = false; loadSamBtn.textContent = "加载 SAM"; }
        }
    }

    /** 卸载 SAM 模型，释放显存（不影响 YOLO）。 */
    async function unloadSam() {
        try {
            const resp = await fetch("/api/sam/unload", { method: "POST" });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "卸载失败");
        } catch (e) {
            showToast("SAM 卸载失败：" + e.message);
            return;
        }
        samLoaded = false;
        if (samMode) setSamMode(false); // 模型没了，退出分割模式
        if (samStatusDot) samStatusDot.className = "w-2 h-2 rounded-full bg-outline-variant";
        if (samStatusText) samStatusText.textContent = "SAM：未加载";
        showToast("SAM 已卸载，显存已释放");
    }

    /** 对当前图片的指定归一化点做 SAM 分割，成功则追加外接框并落盘。 */
    async function segmentAtPoint(nx, ny) {
        if (!selectedName) return;
        if (!samLoaded) { showToast("请先加载 SAM 模型"); return; }
        if (!activeCategory.label) { showToast("请先选择类别"); return; }
        if (samAbort) { samAbort.abort(); samAbort = null; }
        samAbort = new AbortController();
        if (samBtn) samBtn.classList.add("animate-pulse");
        try {
            const resp = await fetch("/api/sam/predict", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image_name: selectedName,
                    points: [[nx, ny]],
                    labels: [1],
                }),
                signal: samAbort.signal,
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "分割失败");
            if (!data.box) { showToast("未分割出目标，换个位置试试"); return; }
            const b = data.box;
            currentBoxes.push({
                id: `box_${nextBoxSeq()}`,
                label: activeCategory.label,
                score: b.score || 100,
                x: b.x, y: b.y, w: b.w, h: b.h,
                hex: activeCategory.hex,
            });
            selectedBoxId = null;
            renderBoxes();
            pushHistory();
            scheduleSaveLabels();
            if (modelLatency) modelLatency.textContent = `延迟：${data.elapsed_ms ?? "--"}ms`;
            if (modelGpu) modelGpu.textContent = `设备：${data.device || "--"}`;
        } catch (e) {
            if (e.name === "AbortError") return;
            showToast("分割失败：" + e.message);
        } finally {
            samAbort = null;
            if (samBtn) samBtn.classList.remove("animate-pulse");
        }
    }

    // ===================== 事件绑定 =====================

    /** 绑定事件。 */
    function bind() {
        // 打开项目按钮（侧栏 + 顶部）。
        if (openProjectBtn) openProjectBtn.addEventListener("click", openBrowseDialog);
        if (openProjectTopBtn) openProjectTopBtn.addEventListener("click", openBrowseDialog);

        // 刷新按钮（侧栏 + 顶部）。
        if (refreshBtn) refreshBtn.addEventListener("click", refreshProject);
        if (refreshTopBtn) refreshTopBtn.addEventListener("click", refreshProject);

        // 标准化 _bad 负样本（_bad.txt → 空 txt，供 YOLO 训练）。
        if (normalizeNegBtn) normalizeNegBtn.addEventListener("click", normalizeNegatives);

        // 目录浏览对话框：返回上级。
        if (browseUpBtn) browseUpBtn.addEventListener("click", () => loadBrowseDir(browseParentPath || ""));
        if (browseSelectBtn) browseSelectBtn.addEventListener("click", selectBrowseDir);
        if (browseCancelBtn) browseCancelBtn.addEventListener("click", closeBrowseDialog);
        if (browseDialog) {
            browseDialog.addEventListener("click", (e) => {
                if (e.target === browseDialog) closeBrowseDialog();
            });
        }
        // 手动路径输入：回车确认。
        if (browseManualPath) {
            browseManualPath.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); openManualPath(); }
            });
        }

        // ===== 模型文件浏览对话框 =====
        if (modelBrowseBtn) modelBrowseBtn.addEventListener("click", openModelBrowseDialog);
        if (modelPathInput) modelPathInput.addEventListener("click", openModelBrowseDialog);
        if (loadModelBtn) loadModelBtn.addEventListener("click", loadModel);
        if (modelBrowseUpBtn) modelBrowseUpBtn.addEventListener("click", () => loadModelBrowseDir(modelBrowseParentPath || ""));
        if (modelBrowseSelectBtn) modelBrowseSelectBtn.addEventListener("click", selectModelBrowseFile);
        if (modelBrowseCancelBtn) modelBrowseCancelBtn.addEventListener("click", closeModelBrowseDialog);
        if (modelBrowseDialog) {
            modelBrowseDialog.addEventListener("click", (e) => {
                if (e.target === modelBrowseDialog) closeModelBrowseDialog();
            });
        }
        if (modelBrowseManualPath) {
            modelBrowseManualPath.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); openModelManualPath(); }
            });
        }
        // 回车键在模型路径输入框也可直接触发加载
        if (modelPathInput) {
            modelPathInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); loadModel(); }
            });
        }

        // ===== 目标检测按钮 + 自动标注开关 =====
        if (detectBtn) detectBtn.addEventListener("click", () => detectCurrent(true));
        if (undoBtn) undoBtn.addEventListener("click", undo);
        if (redoBtn) redoBtn.addEventListener("click", redo);
        if (autoLabelToggle) {
            autoLabelToggle.addEventListener("click", () => {
                autoDetect = !autoDetect;
                if (autoDetect) {
                    autoLabelToggle.classList.add("bg-primary");
                    autoLabelToggle.classList.remove("bg-outline-variant/30");
                    if (autoLabelKnob) autoLabelKnob.classList.add("translate-x-4");
                    if (autoLabelHint) { autoLabelHint.textContent = "切换图片时将自动识别"; autoLabelHint.classList.remove("hidden"); }
                    // 立即对当前图片识别
                    detectCurrent(false);
                } else {
                    autoLabelToggle.classList.remove("bg-primary");
                    autoLabelToggle.classList.add("bg-outline-variant/30");
                    if (autoLabelKnob) autoLabelKnob.classList.remove("translate-x-4");
                    if (autoLabelHint) autoLabelHint.classList.add("hidden");
                }
            });
        }

        // 事件委托：点击任意列表项即选中并在中间展示。
        imageList.addEventListener("click", (e) => {
            // 删除按钮：阻止冒泡，不触发选中。
            const delBtn = e.target.closest(".img-del-btn");
            if (delBtn) {
                e.stopPropagation();
                const item = delBtn.closest(".img-item");
                if (item) deleteImage(item.dataset.name);
                return;
            }
            const item = e.target.closest(".img-item");
            if (item) selectByName(item.dataset.name);
        });

        // 画布交互（缩放 / 平移）与键盘快捷键。
        bindCanvas();
        bindBoxInteraction();
        bindContextMenu();
        bindDialogs();
        bindCategory();
        bindCategoryDialog();
        bindColorDialog();
        bindKeys();

        // 置信度阈值滑块。
        if (confSlider && confLabel) {
            confSlider.addEventListener("input", () => {
                confThreshold = parseInt(confSlider.value, 10);
                confLabel.textContent = `置信度阈值 (${confThreshold}%)`;
            });
        }

        // 画框工具按钮切换绘制模式。
        if (drawBoxBtn) drawBoxBtn.addEventListener("click", () => setDrawMode(!drawMode));
        // SAM 点击分割工具按钮 + 加载按钮。
        if (samBtn) samBtn.addEventListener("click", () => setSamMode(!samMode));
        if (loadSamBtn) loadSamBtn.addEventListener("click", loadSam);
        if (unloadSamBtn) unloadSamBtn.addEventListener("click", unloadSam);

        // 画框粗细滑块。
        if (lineWidthSlider) {
            lineWidthSlider.addEventListener("input", () => {
                lineWidth = parseInt(lineWidthSlider.value, 10);
                if (lineWidthVal) lineWidthVal.textContent = lineWidth;
                renderBoxes(); // 实时更新已有框的粗细
            });
            // 松手后自动失焦，避免阻挡 B 快捷键。
            lineWidthSlider.addEventListener("change", () => {
                lineWidthSlider.blur();
            });
        }

        // 顶部阶段时间线 stepper（智能标注 / 数据集训练 / 模型验证）。
        bindStageNav();
    }

    // ===================== 顶部阶段时间线 stepper =====================
    // 三个阶段（智能标注 → 数据集训练 → 模型验证）以圆形节点 + 连接线呈现。
    // 点击节点切换主视图：智能标注=现有三栏工作台；另两个为占位页（即将上线）。
    // 进度语义：当前阶段=进行中（呼吸放大），其前者=已完成（打勾），其后者=未到达（置灰）。
    function bindStageNav() {
        const nav = document.getElementById("stageNav");
        if (!nav) return;
        const steps = Array.from(nav.querySelectorAll(".step"));
        const connectors = Array.from(nav.querySelectorAll(".step-connector"));
        const STAGE_KEYS = ["annotate", "train", "eval"];

        function setStage(activeIdx) {
            if (activeIdx < 0 || activeIdx >= steps.length) return;
            // 节点状态 + 内容：已完成→勾，进行中/未到→序号。
            steps.forEach((s, i) => {
                s.classList.remove("active", "completed");
                const node = s.querySelector(".step-node");
                if (i < activeIdx) {
                    s.classList.add("completed");
                    node.innerHTML = '<span class="material-symbols-outlined">check</span>';
                } else {
                    if (i === activeIdx) s.classList.add("active");
                    node.textContent = String(i + 1);
                }
            });
            // 当前阶段之前的连线变蓝，体现「已推进」。
            connectors.forEach((c, i) => c.classList.toggle("passed", i < activeIdx));
            // 视图切换。
            const stageKey = steps[activeIdx].dataset.stage;
            STAGE_KEYS.forEach((key) => {
                const el = document.getElementById("stage-" + key);
                if (el) el.classList.toggle("hidden", key !== stageKey);
            });
            // 通知目标阶段（训练页据此初始化/适配 xterm 尺寸）。
            window.dispatchEvent(new CustomEvent("stage-change", { detail: { stage: stageKey } }));
            // 离开标注阶段时退出绘制 / 分割模式，避免状态遗留到切回时。
            if (stageKey !== "annotate") {
                if (drawMode) setDrawMode(false);
                if (samMode) setSamMode(false);
            }
        }

        // 点击阶段节点切换。
        steps.forEach((s, i) => s.addEventListener("click", () => setStage(i)));
        // 占位页「返回智能标注」按钮。
        document.querySelectorAll("[data-back-stage]").forEach((b) => {
            b.addEventListener("click", () => {
                const idx = steps.findIndex((s) => s.dataset.stage === b.dataset.backStage);
                if (idx >= 0) setStage(idx);
            });
        });

        setStage(0); // 默认停留在「智能标注」。
    }

    /** 初始：检查环境 → 绑定事件 → 恢复项目。 */
    async function init() {
        bind();

        // 启动时检测环境，更新模型提示
        try {
            const envResp = await fetch("/api/env/check");
            const envData = await envResp.json();
            if (envData.ok) {
                const hasRuntime = envData.pt || envData.onnx;
                const cfg = envData.config || {};
                const hasConfig = cfg.hasWorker || !!cfg.pythonPath;

                // 模型提示
                if (modelHint) {
                    if (hasRuntime) {
                        const parts = [];
                        if (envData.pt) parts.push(".pt（PyTorch）");
                        if (envData.onnx) parts.push(".onnx（ONNX）");
                        modelHint.textContent = `✓ 环境支持：${parts.join("、")}`;
                    } else if (hasConfig) {
                        modelHint.textContent = `🔗 推理环境已配置（外部 Python）`;
                    } else {
                        modelHint.textContent = "⚠ 未检测到推理环境，请在下方配置";
                    }
                    modelHint.classList.remove("hidden");
                }

                // 推理环境配置面板：始终显示
                if (envConfigPanel && envConfigContent) {
                    envConfigPanel.classList.remove("hidden");
                    renderEnvConfigPanel(envData);
                }
            }
        } catch (e) { /* 静默 */ }

        // 检查是否已有打开的项目（页面刷新恢复），并自动恢复缓存的项目和模型路径。
        try {
            const resp = await fetch("/api/project/status");
            const data = await resp.json();

            // 预填缓存的模型路径
            if (data.lastModelPath && modelPathInput) {
                modelPathInput.value = data.lastModelPath;
            }

            if (data.opened) {
                currentProject = { path: data.projectPath };
                if (projectPathEl) projectPathEl.textContent = data.projectPath;
                if (refreshTopBtn) refreshTopBtn.classList.remove("hidden");
                await loadCategories();
                await loadProjectImages();
                if (projectTitle) projectTitle.textContent = "项目已恢复";
            } else if (data.lastProjectPath) {
                // 有缓存的项目路径但未打开，自动恢复
                await openProject(data.lastProjectPath);
            } else {
                await loadCategories(); // 无项目时也加载类别（可能为空）
                refreshMeta(0);
            }
        } catch (e) {
            refreshMeta(0);
        }
    }

    /** 渲染推理环境配置面板。 */
    function renderEnvConfigPanel(envData) {
        if (!envConfigContent) return;
        let html = "";

        const ext = envData.external || [];
        if (ext.length) {
            html += `<p class="font-label-mono text-[10px] text-on-surface-variant mb-sm">已检测到以下可用环境，点击选用：</p>`;
            ext.forEach((e) => {
                const rtLabel = e.ultralytics ? "PyTorch" : e.onnxruntime ? "ONNX" : "";
                html += `
                <div class="flex items-center gap-sm p-sm bg-surface rounded-lg border border-outline-variant cursor-pointer hover:border-primary transition-colors"
                     data-env-path="${escapeHtml(e.python || "")}">
                    <span class="material-symbols-outlined text-primary text-lg">memory</span>
                    <div class="flex-1 min-w-0">
                        <p class="font-label-mono text-xs text-on-surface truncate">${escapeHtml(e.name || "未知")}</p>
                        <p class="font-label-mono text-[10px] text-outline">${escapeHtml(e.python || "")} · ${rtLabel}</p>
                    </div>
                    <span class="material-symbols-outlined text-outline text-sm">chevron_right</span>
                </div>`;
            });
            html += `<div class="h-px bg-outline-variant my-sm"></div>`;
        }

        html += `
            <p class="font-label-mono text-[10px] text-on-surface-variant mb-xs">或手动输入 Python 路径：</p>
            <div class="flex gap-xs">
                <input id="envPythonInput" type="text" placeholder="/opt/conda/envs/pytorch/bin/python"
                    class="flex-1 bg-surface border border-outline-variant focus:border-primary transition-colors rounded px-xs py-2 font-label-mono text-xs text-on-surface outline-none" />
                <button id="envSaveBtn"
                    class="py-2 px-md bg-primary text-on-primary font-label-caps text-label-caps rounded-lg hover:opacity-90 transition-all shadow-sm whitespace-nowrap">保存</button>
            </div>
            <p id="envConfigError" class="font-label-mono text-[10px] text-error hidden mt-xs"></p>
        `;

        envConfigContent.innerHTML = html;

        // 绑定事件
        const saveBtn = document.getElementById("envSaveBtn");
        const pythonInput = document.getElementById("envPythonInput");
        const errorEl = document.getElementById("envConfigError");

        if (saveBtn && pythonInput) {
            saveBtn.addEventListener("click", () => saveEnvConfig(pythonInput.value.trim()));
            pythonInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") saveEnvConfig(pythonInput.value.trim());
            });
        }

        // 外部环境点击
        envConfigContent.querySelectorAll("[data-env-path]").forEach((el) => {
            el.addEventListener("click", () => saveEnvConfig(el.dataset.envPath));
        });
    }

    /** 保存推理环境配置（外部 Python 路径）。 */
    async function saveEnvConfig(pythonPath) {
        if (!pythonPath) { showToast("请输入 Python 路径或选择一个外部环境"); return; }

        const errorEl = document.getElementById("envConfigError");
        if (errorEl) errorEl.classList.add("hidden");

        const saveBtn = document.getElementById("envSaveBtn");
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "…"; }

        try {
            const resp = await fetch("/api/env/config", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pythonPath }),
            });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "保存失败");

            // 更新状态栏
            if (modelStatusDot) {
                modelStatusDot.className = "w-2 h-2 rounded-full bg-emerald-500";
            }
            if (modelStatusText) {
                modelStatusText.textContent = "推理环境已配置（Worker）";
            }
            if (modelGpu) {
                const rt = data.runtime || {};
                const info = rt.ultralytics ? `PyTorch ${rt.torch || ""}` : rt.onnxruntime ? `ONNX ${rt.onnxruntime || ""}` : "";
                modelGpu.textContent = `外部：${info}`;
            }
            if (modelHint) {
                modelHint.textContent = `🔗 已连接外部推理环境（Worker 模式）`;
                modelHint.classList.remove("hidden");
            }

            showNotification({
                type: "success",
                title: "推理环境已配置",
                message: pythonPath,
            });
        } catch (e) {
            if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove("hidden"); }
            showToast("配置失败：" + e.message);
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "保存"; }
        }
    }

    init();
})();
