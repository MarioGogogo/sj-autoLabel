/**
 * 图片列表：导入、渲染、状态标注、计数。
 *
 * 状态语义：
 *   pending  待处理（导入默认）
 *   done     已处理（后续接入模型检测后更新）
 */
(function () {
    "use strict";

    const fileInput = document.getElementById("fileInput");
    const importBtn = document.getElementById("importBtn");
    const imageList = document.getElementById("imageList");
    const emptyHint = document.getElementById("emptyHint");
    const imageCount = document.getElementById("imageCount");

    // ===== 中间展示区元素 =====
    const canvasEmpty = document.getElementById("canvasEmpty");
    const canvasWrapper = document.getElementById("canvasWrapper");
    const canvasStage = document.getElementById("canvasStage");
    const canvasImage = document.getElementById("canvasImage");
    const canvasFrame = document.getElementById("canvasFrame");
    const canvasBoxes = document.getElementById("canvasBoxes");
    const canvasName = document.getElementById("canvasName");
    const canvasSize = document.getElementById("canvasSize");
    const canvasZoom = document.getElementById("canvasZoom");
    const zoomInBtn = document.getElementById("zoomInBtn");
    const zoomOutBtn = document.getElementById("zoomOutBtn");
    const zoomResetBtn = document.getElementById("zoomResetBtn");
    const drawBoxBtn = document.getElementById("drawBoxBtn");
    const ctxMenu = document.getElementById("ctxMenu");
    const categoryList = document.getElementById("categoryList");
    const addCatBtn = document.getElementById("addCatBtn");
    const catDialog = document.getElementById("catDialog");
    const catNameInput = document.getElementById("catNameInput");
    const catColorInput = document.getElementById("catColorInput");
    const catSwatch = document.getElementById("catSwatch");
    const catConfirmBtn = document.getElementById("catConfirmBtn");
    const catCancelBtn = document.getElementById("catCancelBtn");

    // ===== 通用弹窗元素 =====
    const confirmDialog = document.getElementById("confirmDialog");
    const confirmIcon = document.getElementById("confirmIcon");
    const confirmTitle = document.getElementById("confirmTitle");
    const confirmMsg = document.getElementById("confirmMsg");
    const confirmOkBtn = document.getElementById("confirmOkBtn");
    const confirmCancelBtn = document.getElementById("confirmCancelBtn");
    const toastEl = document.getElementById("toast");
    const notifyStack = document.getElementById("notifyStack");

    let selectedId = null; // 当前选中图片 id

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
    let boxSeq = 0; // 新建框序号，保证 id 唯一

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const nextBoxSeq = () => `${Date.now().toString(36)}_${(boxSeq++).toString(36)}`;

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
                `border-color:${hex};`;
            const lbl = document.createElement("div");
            lbl.className = "bbox-label text-white";
            lbl.style.backgroundColor = hex;
            lbl.textContent = `${b.label} ${b.score}%`;
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
        scheduleSaveLabels();
        return true;
    }

    /** 清空当前图片全部标注框。 */
    function clearAllBoxes() {
        if (!currentBoxes.length) return;
        currentBoxes = [];
        selectedBoxId = null;
        renderBoxes();
        scheduleSaveLabels();
    }

    /** 切换画框工具开关。 */
    function setDrawMode(on) {
        drawMode = on;
        if (canvasStage) canvasStage.classList.toggle("drawing-mode", on);
        document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", on));
        if (on) selectBox(null); // 进入绘制时取消选中，避免干扰
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

    /** 渲染右侧类别列表（首屏 + 新增后调用）。 */
    function renderCategoryList() {
        if (!categoryList) return;
        categoryList.innerHTML = "";
        CATEGORIES.forEach((c) => {
            const item = document.createElement("div");
            item.className = "cat-item group flex items-center gap-sm p-sm bg-surface-container-highest rounded-r cursor-pointer transition-all hover:brightness-95";
            item.dataset.cat = c.color;
            item.style.borderLeft = `6px solid ${c.hex}`;
            if (c.color === activeCategory.color) item.classList.add("active");
            item.innerHTML = `
                <span class="cat-dot w-3 h-3 rounded-full flex-shrink-0" style="background:${c.hex}"></span>
                <span class="flex-1 font-label-mono text-xs" style="color:${c.hex}">${escapeHtml(c.label)}</span>
                <span class="text-[10px] font-label-mono text-outline">0 个检测</span>
                <button type="button" title="删除类别"
                    class="cat-del-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-outline hover:text-error hover:bg-error/10 transition-all opacity-0 group-hover:opacity-100">
                    <span class="material-symbols-outlined text-[16px]">close</span>
                </button>
            `;
            categoryList.appendChild(item);
        });
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

        // class_id 重排了，重新从服务端拉取类别 + 当前图标注。
        await loadCategories();
        if (selectedId) {
            currentBoxes = await loadBoxesForImage(selectedId);
            selectedBoxId = null;
            renderBoxes();
        }
        showToast(`已删除类别「${cat.label}」`);
        return true;
    }

    /** 绑定右侧类别区域：点击切换当前类别、删除类别、添加新类别。 */
    function bindCategory() {
        if (!categoryList) return;
        categoryList.addEventListener("click", (e) => {
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
            if (changed) scheduleSaveLabels();
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
                else if (act === "delete") deleteSelectedBox();
                else if (act === "reset") resetView();
                else if (act === "clearBoxes") clearAllBoxes();
            });
        }
    }

    // ===================== 键盘：方向键切换 =====================

    /** 按 DOM 顺序取当前选中项的前一个 / 后一个 id。 */
    function neighborId(dir) {
        const items = Array.from(imageList.querySelectorAll(".img-item"));
        if (!items.length) return null;
        const idx = items.findIndex((n) => n.dataset.id === selectedId);
        if (idx === -1) return items[0].dataset.id;
        const next = items[idx + dir];
        return next ? next.dataset.id : null;
    }

    /** 绑定全局键盘快捷键。 */
    function bindKeys() {
        document.addEventListener("keydown", (e) => {
            // 在输入框内不拦截。
            const tag = (e.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;

            if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                const id = neighborId(-1);
                if (id) { e.preventDefault(); selectById(id); }
            } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                const id = neighborId(1);
                if (id) { e.preventDefault(); selectById(id); }
            } else if (e.key === "Delete" || e.key === "Backspace") {
                // 删除当前选中的标注框。
                if (selectedBoxId) { e.preventDefault(); deleteSelectedBox(); }
            } else if (e.key === "b" || e.key === "B") {
                // B：切换画框工具。
                e.preventDefault(); setDrawMode(!drawMode);
            } else if (e.key === "Escape") {
                // Esc：关闭对话框 / 退出绘制模式 / 取消选中 / 关闭右键菜单。
                if (confirmDialog && !confirmDialog.classList.contains("hidden")) {
                    e.preventDefault(); resolveConfirm(false);
                } else if (catDialog && !catDialog.classList.contains("hidden")) {
                    e.preventDefault(); closeAddCategoryDialog();
                } else if (drawMode) setDrawMode(false);
                else if (selectedBoxId) selectBox(null);
                hideCtxMenu();
            } else if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
                e.preventDefault(); zoomBy(ZOOM_STEP);
            } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
                e.preventDefault(); zoomBy(1 / ZOOM_STEP);
            } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault(); resetView();
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

    /**
     * 生成单张图片卡片节点（与服务端 _image_item.html 结构保持一致）。
     * @param {Object} img { id, name, url, status, size }
     */
    function renderImageItem(img) {
        const isDone = img.status === "done";
        const item = document.createElement("div");
        // 与模板 class 完全对齐。
        const baseClass = "img-item flex items-center gap-sm p-xs rounded transition-all group";
        const stateClass = isDone
            ? "bg-surface-container-highest border border-primary/30"
            : "hover:bg-surface-variant cursor-pointer";
        item.className = `${baseClass} ${stateClass}`;
        item.dataset.id = img.id;
        item.dataset.status = img.status;

        const thumbOpacity = isDone ? "" : "opacity-70 group-hover:opacity-100";
        const nameColor = isDone
            ? "text-primary"
            : "text-on-surface-variant group-hover:text-primary";
        const statusColor = isDone ? "text-on-surface-variant" : "text-outline";
        const statusText = isDone ? "已处理" : "待处理";

        const icon = isDone
            ? `<span class="material-symbols-outlined text-primary text-sm status-icon">check_circle</span>`
            : `<span class="material-symbols-outlined text-outline text-sm status-icon opacity-0 group-hover:opacity-100 transition-opacity">radio_button_unchecked</span>`;

        const sizeTip = img.size ? ` · ${formatSize(img.size)}` : "";
        const thumbSrc = img.thumb_url || img.url;

        item.innerHTML = `
            <div class="w-10 h-10 rounded overflow-hidden flex-shrink-0 ${thumbOpacity}">
                <img class="w-full h-full object-cover" loading="lazy" decoding="async"
                    src="${thumbSrc}" alt="${img.name}" />
            </div>
            <div class="flex-1 min-w-0">
                <p class="truncate text-xs font-label-mono ${nameColor}">${img.name}</p>
                <p class="img-status text-[10px] ${statusColor}">${statusText}${sizeTip}</p>
            </div>
            ${icon}
        `;
        return item;
    }

    /**
     * 切换中间展示区为指定图片。
     * @param {Object} img 选中的图片记录（取 url 原图展示）
     */
    async function selectImage(img) {
        // 切换前：若旧图有未保存改动，强制 flush（防抖不等）。
        if (selectedId && selectedId !== img.id) {
            try { await flushSaveLabels(); } catch (e) { /* 忽略，继续切图 */ }
        }
        selectedId = img.id;

        // 选中态：列表项高亮（与「已处理」区分：用更明显的 primary 背景 + 左描边）。
        let activeNode = null;
        imageList.querySelectorAll(".img-item").forEach((node) => {
            const isSelected = node.dataset.id === img.id;
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
        if (canvasWrapper) canvasWrapper.classList.remove("hidden");

        // 切换图片：重置视图 + 加载该图已有标注（替代演示框）。
        resetView();
        currentBoxes = await loadBoxesForImage(img.id);
        selectedBoxId = null;
        renderBoxes();
        pendingSaveId = null; // 新图刚加载，无需保存
    }

    /** 加载某图已有标注（YOLO txt 经后端转回左上角格式）。无则空。 */
    async function loadBoxesForImage(imageId) {
        try {
            const resp = await fetch(`/api/labels/${imageId}`);
            const data = await resp.json();
            if (!resp.ok || !data.ok) return [];
            return (data.boxes || []).map((b) => ({ ...b, id: "box_" + nextBoxSeq() }));
        } catch (e) {
            return [];
        }
    }

    // ===== 自动保存（防抖 400ms） =====
    let saveTimer = null;
    let pendingSaveId = null; // 正在等待保存的图片 id

    /** 调度一次保存（400ms 内连续操作合并）。 */
    function scheduleSaveLabels() {
        if (!selectedId) return;
        pendingSaveId = selectedId;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSaveLabels, 400);
    }

    /** 立即保存当前 pending 图的标注（快照后 PUT）。 */
    async function flushSaveLabels() {
        clearTimeout(saveTimer);
        const id = pendingSaveId;
        if (!id) return;
        pendingSaveId = null;
        // 快照当前框（label + 左上角坐标），避免保存中途被下一张改动。
        const boxes = currentBoxes.map((b) => ({
            label: b.label, x: b.x, y: b.y, w: b.w, h: b.h,
        }));
        try {
            const resp = await fetch(`/api/labels/${id}`, {
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
            showNotification({
                type: "success",
                title: "坐标保存成功",
                message: `已保存 ${n} 个标注框`,
            });
        } catch (e) {
            showNotification({ type: "error", title: "保存失败", message: e.message });
        }
    }

    /**
     * 根据图片 id 在当前列表中查找记录并选中。
     * （首屏服务端渲染的卡片只带 data-id，需回到节点上取原图地址。）
     */
    function selectById(id) {
        const node = imageList.querySelector(`.img-item[data-id="${id}"]`);
        if (!node) return;
        const imgTag = node.querySelector("img");
        // 动态插入的节点会缓存完整记录；首屏节点则从 DOM 现场取。
        const record = node._img || {
            id: id,
            url: node.dataset.url || (imgTag ? imgTag.getAttribute("src") : ""),
            name: imgTag ? imgTag.getAttribute("alt") : "",
            status: node.dataset.status,
            size: node.dataset.size ? Number(node.dataset.size) : 0,
        };
        selectImage(record);
    }

    /** 刷新顶部计数与空状态显示。 */
    function refreshMeta(total) {
        if (imageCount) imageCount.textContent = total.toLocaleString();
        if (emptyHint) emptyHint.classList.toggle("hidden", total > 0);
    }

    /** 把上传返回的图片逐个插入列表（保持最新在最上）。 */
    function appendImages(images) {
        if (!images || !images.length) return;
        let firstNode = null;
        images.forEach((img) => {
            const node = renderImageItem(img);
            node._img = img; // 缓存完整记录，供选中时取用
            node.dataset.url = img.url;
            node.dataset.size = img.size || "";
            imageList.insertBefore(node, imageList.firstChild);
            if (!firstNode) firstNode = node;
        });
        // 导入后自动聚焦到第一张，便于立即在画布查看。
        if (firstNode) selectById(firstNode.dataset.id);
    }

    /** 上传并刷新。 */
    async function uploadFiles(files) {
        if (!files || !files.length) return;
        const fd = new FormData();
        const imgExt = /\.(png|jpe?g|gif|bmp|webp)$/i;
        let valid = 0;
        for (const f of files) {
            // 文件夹导入时部分文件可能无 MIME，用扩展名兜底。
            const isImage = f.type.startsWith("image/") || imgExt.test(f.name);
            if (!isImage) continue;
            fd.append("files", f);
            valid++;
        }
        if (!valid) {
            showToast("所选内容中没有图片文件");
            return;
        }

        const original = importBtn.innerHTML;
        importBtn.disabled = true;
        importBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>导入中…`;

        try {
            const resp = await fetch("/api/upload", { method: "POST", body: fd });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                throw new Error(data.error || "上传失败");
            }
            appendImages(data.images);
            refreshMeta(data.total);
        } catch (err) {
            showToast("导入失败：" + err.message);
        } finally {
            importBtn.disabled = false;
            importBtn.innerHTML = original;
            fileInput.value = ""; // 允许重复选择同一文件
        }
    }

    /** 一键清空：确认后调接口，清空列表与磁盘文件。 */
    async function clearAll() {
        const total = imageList.querySelectorAll(".img-item").length;
        if (total === 0) return;
        const ok = await showConfirm({
            title: "清空图片",
            message: `确定清空全部 ${total.toLocaleString()} 张图片吗？此操作不可撤销。`,
            okText: "清空",
            danger: true,
        });
        if (!ok) return;

        const clearBtn = document.getElementById("clearBtn");
        const original = clearBtn.innerHTML;
        clearBtn.disabled = true;
        clearBtn.innerHTML = `<span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>`;

        try {
            const resp = await fetch("/api/images", { method: "DELETE" });
            const data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "清空失败");
            imageList.querySelectorAll(".img-item").forEach((n) => n.remove());
            selectedId = null;
            if (canvasWrapper) canvasWrapper.classList.add("hidden");
            if (canvasEmpty) canvasEmpty.classList.remove("hidden");
            if (canvasImage) canvasImage.src = "";
            if (canvasBoxes) canvasBoxes.innerHTML = "";
            currentBoxes = [];
            selectedBoxId = null;
            resetView();
            refreshMeta(0);
        } catch (err) {
            showToast("清空失败：" + err.message);
        } finally {
            clearBtn.disabled = false;
            clearBtn.innerHTML = original;
        }
    }

    /** 绑定事件。 */
    function bind() {
        importBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", (e) => uploadFiles(e.target.files));
        document.getElementById("clearBtn").addEventListener("click", clearAll);

        // 事件委托：点击任意列表项即选中并在中间展示。
        imageList.addEventListener("click", (e) => {
            const item = e.target.closest(".img-item");
            if (item) selectById(item.dataset.id);
        });
        // 支持拖拽到侧边栏导入。
        const aside = document.querySelector("aside.w-sidebar-width");
        if (aside) {
            ["dragenter", "dragover"].forEach((ev) =>
                aside.addEventListener(ev, (e) => {
                    e.preventDefault();
                    aside.classList.add("bg-primary/5");
                })
            );
            ["dragleave", "drop"].forEach((ev) =>
                aside.addEventListener(ev, (e) => {
                    e.preventDefault();
                    aside.classList.remove("bg-primary/5");
                })
            );
            aside.addEventListener("drop", (e) => {
                if (e.dataTransfer && e.dataTransfer.files) {
                    uploadFiles(e.dataTransfer.files);
                }
            });
        }

        // 画布交互（缩放 / 平移）与键盘快捷键。
        bindCanvas();
        bindBoxInteraction();
        bindContextMenu();
        bindDialogs();
        bindCategory();
        bindCategoryDialog();
        bindKeys();

        // 画框工具按钮（工具栏第 4 个）切换绘制模式。
        if (drawBoxBtn) drawBoxBtn.addEventListener("click", () => setDrawMode(!drawMode));
    }

    /** 初始：加载类别 → 同步计数与事件 → 选中首张图。 */
    async function init() {
        await loadCategories(); // 先加载类别（文件为准）
        const items = imageList.querySelectorAll(".img-item");
        refreshMeta(items.length);
        bind();
        // 首屏若已有图片，默认选中第一张并在画布展示。
        if (items.length) selectById(items[0].dataset.id);
    }

    init();
})();
