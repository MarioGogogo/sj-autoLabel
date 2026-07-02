/**
 * 模型验证页（#stage-eval）前端逻辑
 *
 * 当前为 UI 复刻阶段：
 *  - 「开始验证」按钮：演示动画（进度条递增 + 完成变绿），无后端调用。
 *  - 置信度阈值：支持「全局默认」+「按类别独立覆盖」。类别来自 GET /api/classes
 *    （CATEGORIES 是 image_list.js 的闭包私有变量，未暴露 window，故 eval.js 自取）。
 *  真实业务功能（推理调用 / 指标更新 / 日志推送）后续接入，届时替换本文件。
 */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };

    // ===== 阈值状态 =====
    // defaultConf：全局默认阈值（0~1）；perClass：被单独覆盖的类别 {label: 0~1}；
    // categories：[{label, hex, id}]，来自 /api/classes。
    var state = { defaultConf: 0.5, perClass: {}, categories: [], valImages: [], valSelected: null, valPath: "" };

    // 弹窗内草稿（应用前不落 state，取消即丢弃）
    var thrDraft = {};           // {label: 0~1}
    var thrDefaultDraft = 0.5;   // 0~1

    var inited = false;

    // ===== 工具：HTML 转义（类别名可能含特殊字符） =====
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
        });
    }

    function showDialog(id) { var el = $(id); if (el) el.classList.remove("hidden"); }
    function hideDialog(id) { var el = $(id); if (el) el.classList.add("hidden"); }

    // ===== 类别加载（GET /api/classes，未开项目返回空数组） =====
    function loadCategories() {
        fetch("/api/classes")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.ok) { state.categories = []; refreshClassCount(); return; }
                state.categories = data.categories || [];
                // 清理已不存在的类别的覆盖项
                var valid = {};
                state.categories.forEach(function (c) { if (state.perClass.hasOwnProperty(c.label)) valid[c.label] = state.perClass[c.label]; });
                state.perClass = valid;
                refreshClassCount();
            })
            .catch(function () { state.categories = []; refreshClassCount(); });
    }

    function refreshClassCount() {
        var cntEl = $("evalClassCount");
        if (cntEl) cntEl.textContent = "(" + state.categories.length + ")";
        var modeEl = $("evalConfMode");
        if (modeEl) {
            var overrides = Object.keys(state.perClass).length;
            modeEl.textContent = overrides > 0 ? "按类别 · " + overrides + " 项" : "全局默认";
        }
    }

    // ===== 主区域：全局默认滑块 =====
    function bindMainSlider() {
        var slider = $("evalConfSlider");
        var val = $("evalConfVal");
        if (!slider || !val || slider.dataset.bound === "1") return;
        slider.dataset.bound = "1";
        slider.addEventListener("input", function () {
            var v = parseInt(slider.value, 10) / 100;
            state.defaultConf = v;
            val.textContent = v.toFixed(2);
            refreshClassCount();
        });
    }

    // ===== 「开始验证」演示动画（保留自 check.html） =====
    function bindStartDemo() {
        var startBtn = $("startValidation");
        var progressBar = $("evalProgressBar");
        if (!startBtn || !progressBar || startBtn.dataset.evalBound === "1") return;
        startBtn.dataset.evalBound = "1";
        startBtn.addEventListener("click", function () {
            startBtn.innerHTML =
                '<span class="material-symbols-outlined animate-spin">sync</span>' +
                '<span class="text-md">验证中...</span>';
            startBtn.classList.add("opacity-80");
            var width = 65;
            var interval = setInterval(function () {
                if (width >= 100) {
                    clearInterval(interval);
                    startBtn.innerHTML =
                        '<span class="material-symbols-outlined">check</span>' +
                        '<span class="text-md">验证完成</span>';
                    startBtn.classList.remove("bg-primary");
                    startBtn.classList.add("bg-green-600");
                } else {
                    width += 0.4;
                    if (width > 100) width = 100;
                    progressBar.style.width = width + "%";
                }
            }, 50);
        });
    }

    // ===== 类别阈值弹窗 =====
    function rowVal(label) {
        return thrDraft.hasOwnProperty(label) ? thrDraft[label] : thrDefaultDraft;
    }

    function renderThrList() {
        var list = $("evalThrList");
        var empty = $("evalThrEmpty");
        if (!list) return;
        list.innerHTML = "";
        if (!state.categories.length) {
            list.classList.add("hidden");
            if (empty) empty.classList.remove("hidden");
            return;
        }
        if (empty) empty.classList.add("hidden");
        list.classList.remove("hidden");

        state.categories.forEach(function (c) {
            var label = c.label;
            var hex = c.hex || "#003d9b";
            var overridden = thrDraft.hasOwnProperty(label);
            var cur = rowVal(label);
            var row = document.createElement("div");
            row.className = "flex items-center gap-sm py-xs px-sm rounded-lg" + (overridden ? " bg-primary/5" : "");
            row.innerHTML =
                '<span class="w-3 h-3 rounded-full shrink-0 border border-outline-variant" style="background:' + hex + '"></span>' +
                '<span class="text-xs text-on-surface w-24 truncate" title="' + esc(label) + '">' + esc(label) + '</span>' +
                '<input type="range" min="0" max="100" value="' + Math.round(cur * 100) + '"' +
                ' class="flex-1 accent-primary h-1.5 rounded-lg appearance-none bg-outline-variant" />' +
                '<span class="text-[11px] font-mono w-10 text-right ' + (overridden ? "text-primary font-bold" : "text-on-surface-variant") + '">' + cur.toFixed(2) + '</span>';
            var slider = row.querySelector('input[type="range"]');
            var valEl = row.querySelector("span:last-child");
            slider.addEventListener("input", function () {
                var v = parseInt(slider.value, 10) / 100;
                valEl.textContent = v.toFixed(2);
                thrDraft[label] = v;
                // 标记覆盖态（高亮整行 + 数值染主题色）
                if (!row.classList.contains("bg-primary/5")) row.classList.add("bg-primary/5");
                valEl.classList.remove("text-on-surface-variant");
                valEl.classList.add("text-primary", "font-bold");
            });
            list.appendChild(row);
        });
    }

    function openThrDialog() {
        thrDefaultDraft = state.defaultConf;
        thrDraft = {};
        for (var k in state.perClass) { if (state.perClass.hasOwnProperty(k)) thrDraft[k] = state.perClass[k]; }
        var dSlider = $("evalThrDefaultSlider");
        var dVal = $("evalThrDefaultVal");
        if (dSlider) dSlider.value = Math.round(thrDefaultDraft * 100);
        if (dVal) dVal.textContent = thrDefaultDraft.toFixed(2);
        renderThrList();
        showDialog("evalThresholdDialog");
    }

    function applyThr() {
        state.perClass = {};
        for (var k in thrDraft) { if (thrDraft.hasOwnProperty(k)) state.perClass[k] = thrDraft[k]; }
        state.defaultConf = thrDefaultDraft;
        // 同步主区域滑块
        var mSlider = $("evalConfSlider");
        var mVal = $("evalConfVal");
        if (mSlider) mSlider.value = Math.round(state.defaultConf * 100);
        if (mVal) mVal.textContent = state.defaultConf.toFixed(2);
        refreshClassCount();
        hideDialog("evalThresholdDialog");
    }

    function bindThresholdDialog() {
        var openBtn = $("evalConfPerClassBtn");
        if (openBtn && openBtn.dataset.bound !== "1") {
            openBtn.dataset.bound = "1";
            openBtn.addEventListener("click", openThrDialog);
        }
        var closeBtn = $("evalThrCloseBtn");
        var cancelBtn = $("evalThrCancelBtn");
        if (closeBtn) closeBtn.addEventListener("click", function () { hideDialog("evalThresholdDialog"); });
        if (cancelBtn) cancelBtn.addEventListener("click", function () { hideDialog("evalThresholdDialog"); });

        var applyBtn = $("evalThrApplyBtn");
        if (applyBtn && applyBtn.dataset.bound !== "1") {
            applyBtn.dataset.bound = "1";
            applyBtn.addEventListener("click", applyThr);
        }

        var resetAllBtn = $("evalThrResetAllBtn");
        if (resetAllBtn && resetAllBtn.dataset.bound !== "1") {
            resetAllBtn.dataset.bound = "1";
            resetAllBtn.addEventListener("click", function () { thrDraft = {}; renderThrList(); });
        }

        // 弹窗内「全局默认」滑块：实时刷新未覆盖行的显示
        var dSlider = $("evalThrDefaultSlider");
        var dVal = $("evalThrDefaultVal");
        if (dSlider && dSlider.dataset.bound !== "1") {
            dSlider.dataset.bound = "1";
            dSlider.addEventListener("input", function () {
                thrDefaultDraft = parseInt(dSlider.value, 10) / 100;
                if (dVal) dVal.textContent = thrDefaultDraft.toFixed(2);
                renderThrList();
            });
        }

        var dlg = $("evalThresholdDialog");
        if (dlg && dlg.dataset.bound !== "1") {
            dlg.dataset.bound = "1";
            // 点遮罩关闭
            dlg.addEventListener("click", function (e) {
                if (e.target === dlg) hideDialog("evalThresholdDialog");
            });
            // Esc 关闭
            document.addEventListener("keydown", function (e) {
                if (e.key === "Escape" && !dlg.classList.contains("hidden")) {
                    hideDialog("evalThresholdDialog");
                }
            });
        }
    }

    // ===== 验证集图片列表（项目 val/ 文件夹） =====
    // 列表用缩略图（/api/eval/val_thumb），验证大图区用原图（/api/eval/val_image）。
    function loadValImages(opts) {
        opts = opts || {};
        fetch("/api/eval/val_images")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.ok) {
                    state.valImages = [];
                    state.valSelected = null;
                    renderValThumbs();
                    if (window.showToast) showToast((data && data.error) || "验证图片加载失败");
                    return;
                }
                state.valImages = data.images || [];
                state.valPath = data.valPath || "";
                // 当前选中图已被删 → 清空选中，让下面默认回到第一张
                if (state.valSelected && !state.valImages.some(function (v) { return v.name === state.valSelected; })) {
                    state.valSelected = null;
                }
                var cntEl = $("evalListCount");
                if (cntEl) cntEl.textContent = String(state.valImages.length);
                renderValThumbs();
                // 默认选中第一张 → 大图区加载原图
                if (!state.valSelected && state.valImages[0]) {
                    selectValImage(state.valImages[0].name, state.valImages[0].url);
                }
                // 刚创建 val/ 或为空 → 提示用户放图
                if ((data.created || data.empty) && window.showToast) {
                    showToast("请把验证图片放到项目的 val 文件夹后点刷新");
                }
                if (opts.done && window.showToast) opts.done();
            })
            .catch(function () {
                state.valImages = [];
                renderValThumbs();
                if (window.showToast) showToast("验证图片加载失败");
            });
    }

    function renderValThumbs() {
        var box = $("evalThumbList");
        if (!box) return;
        box.innerHTML = "";
        if (!state.valImages.length) {
            // 空状态提示卡片：引导用户把图片放进 val/
            var hint = document.createElement("div");
            hint.className = "min-w-[100px] h-[100px] border-2 border-dashed border-outline-variant rounded-xl flex flex-col items-center justify-center gap-1 text-on-surface-variant shrink-0 px-2 text-center";
            hint.innerHTML =
                '<span class="material-symbols-outlined">folder_open</span>' +
                '<span class="text-[10px] font-bold leading-tight">将验证图片<br>放入 val 文件夹</span>';
            box.appendChild(hint);
            return;
        }
        state.valImages.forEach(function (img) {
            var isSelected = state.valSelected === img.name;
            var card = document.createElement("div");
            card.className = "relative min-w-[100px] h-[100px] cursor-pointer rounded-lg overflow-hidden shrink-0 border-2 transition-all " +
                (isSelected ? "border-primary" : "border-transparent hover:border-primary-fixed-dim");
            card.title = img.name;
            card.innerHTML =
                '<img class="w-full h-full object-cover" loading="lazy" decoding="async" alt="' + esc(img.name) + '" src="' + img.thumb_url + '" />' +
                (isSelected ? '<div class="absolute inset-0 bg-primary/20 flex items-center justify-center"><span class="material-symbols-outlined text-white scale-75">check_circle</span></div>' : '');
            card.addEventListener("click", function () {
                selectValImage(img.name, img.url);
            });
            box.appendChild(card);
        });
    }

    function selectValImage(name, url) {
        var changed = state.valSelected !== name;
        state.valSelected = name;
        var preview = $("evalPreviewImage");
        if (preview) preview.src = url;  // 验证大图区用原图
        if (changed) renderValThumbs();   // 选中变化才重绘高亮
    }

    function bindValRefresh() {
        var btn = $("evalValRefreshBtn");
        if (!btn || btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", function () {
            loadValImages({ done: function () { if (window.showToast) showToast("已刷新验证数据列表"); } });
        });
    }

    // ===== 初始化（仅绑定一次；每次进入验证阶段刷新类别） =====
    function init() {
        if (!inited) {
            inited = true;
            bindMainSlider();
            bindStartDemo();
            bindThresholdDialog();
            bindValRefresh();
        }
        loadCategories();
        loadValImages();
    }

    window.addEventListener("stage-change", function (e) {
        if (e.detail && e.detail.stage === "eval") init();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
