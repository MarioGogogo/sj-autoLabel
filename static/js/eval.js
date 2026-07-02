/**
 * 模型验证页（#stage-eval）前端逻辑
 *
 * 真实业务流程（视频验证本次不接入，tab 禁用 + 提示开发中）：
 *  - 进入页：GET /api/eval/model → 定位 best.pt + 读 results.csv 指标 → 填顶部 mAP/P/R 与右侧模型名。
 *  - 「开始验证」：定位 best.pt → POST /api/model/load 加载 → 串行 POST /api/eval/detect 逐张推理，
 *    预览大图叠加真实检测框、进度条从 0 递增、运行日志实时输出。
 *  - 「停止验证」：abort 串行循环 + POST /api/model/unload 卸载模型。
 *  - 置信度阈值：支持「全局默认」+「按类别独立覆盖」（沿用既有实现）。
 */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };

    // ===== 状态 =====
    // defaultConf：全局默认阈值（0~1）；perClass：被单独覆盖的类别 {label: 0~1}；
    // categories：[{label, hex, id}]，来自 /api/classes。
    // evalModel：/api/eval/model 缓存（bestPath/bestName/metrics/loaded）；running/aborted：验证流程态。
    var state = {
        defaultConf: 0.5, perClass: {}, categories: [],
        valImages: [], valSelected: null, valPath: "",
        evalModel: null, running: false, aborted: false,
    };

    // 弹窗内草稿（应用前不落 state，取消即丢弃）
    var thrDraft = {};           // {label: 0~1}
    var thrDefaultDraft = 0.5;   // 0~1

    var inited = false;

    // ===== 工具 =====
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
        });
    }
    function showDialog(id) { var el = $(id); if (el) el.classList.remove("hidden"); }
    function hideDialog(id) { var el = $(id); if (el) el.classList.add("hidden"); }

    // ===== 运行日志 =====
    function log(msg, type) {
        var box = $("evalLogBox");
        if (!box) return;
        var cls = {
            info: "text-on-surface-variant",
            load: "text-on-surface-variant",
            detect: "text-primary-container bg-primary/5 rounded px-1 font-medium",
            success: "text-green-600 font-bold",
            error: "text-error font-bold",
            stop: "text-on-surface-variant italic",
        }[type || "info"];
        var p = document.createElement("p");
        p.className = cls || "text-on-surface-variant";
        p.textContent = msg;
        box.appendChild(p);
        box.scrollTop = box.scrollHeight;
    }
    function clearLog() { var box = $("evalLogBox"); if (box) box.innerHTML = ""; }

    // ===== 指标格式化与渲染 =====
    function fmtMap(v) { return (v == null || isNaN(v)) ? "—" : Number(v).toFixed(3); }
    function fmtPct(v) { return (v == null || isNaN(v)) ? "—" : (Number(v) * 100).toFixed(1) + "%"; }

    function updateMetrics(m) {
        var mapEl = $("evalMap"), pEl = $("evalPrecision"), rEl = $("evalRecall");
        if (!m) {
            if (mapEl) mapEl.textContent = "—";
            if (pEl) pEl.textContent = "—";
            if (rEl) rEl.textContent = "—";
            return;
        }
        if (mapEl) mapEl.textContent = fmtMap(m.map50);
        if (pEl) pEl.textContent = fmtPct(m.precision);
        if (rEl) rEl.textContent = fmtPct(m.recall);
    }

    // ===== 模型定位 + 训练指标（GET /api/eval/model） =====
    function refreshEvalModel() {
        return fetch("/api/eval/model")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.ok) {
                    state.evalModel = null;
                    var mn0 = $("evalModelName");
                    if (mn0) mn0.textContent = "未定位到训练产物";
                    updateMetrics(null);
                    var gs0 = $("evalGpuStatus");
                    if (gs0) gs0.textContent = "未找到训练产物";
                    return;
                }
                state.evalModel = data;
                var mn = $("evalModelName");
                if (mn) mn.textContent = data.bestName ? (data.bestName + (data.bestSource === "scan" ? "  (扫描)" : "")) : "未定位到训练产物";
                updateMetrics(data.metrics || null);
                var gs = $("evalGpuStatus");
                if (gs) gs.textContent = data.loaded ? "模型已加载" : (data.bestPath ? "模型待加载" : "未找到训练产物");
            })
            .catch(function () {
                state.evalModel = null;
                updateMetrics(null);
            });
    }

    // ===== 检测框 overlay 渲染（归一化坐标 → 百分比定位） =====
    function renderBoxes(boxes) {
        var overlay = $("evalBoxOverlay");
        if (!overlay) return;
        overlay.innerHTML = "";
        if (!boxes || !boxes.length) return;
        boxes.forEach(function (b) {
            var hex = b.hex || "#003d9b";
            var label = b.label || ("class_" + (b.class_id != null ? b.class_id : "?"));
            // 后端 score 已是 0~100；兼容 0~1
            var s = (b.score != null) ? (b.score >= 1 ? b.score : b.score * 100) : 0;
            var div = document.createElement("div");
            div.className = "bounding-box";
            div.style.cssText =
                "top:" + (b.y * 100).toFixed(2) + "%;" +
                "left:" + (b.x * 100).toFixed(2) + "%;" +
                "width:" + (b.w * 100).toFixed(2) + "%;" +
                "height:" + (b.h * 100).toFixed(2) + "%;" +
                "border-color:" + hex + ";";
            var lbl = document.createElement("div");
            lbl.className = "box-label";
            lbl.style.background = hex;
            lbl.textContent = label + " " + s.toFixed(2);
            div.appendChild(lbl);
            overlay.appendChild(div);
        });
    }

    // ===== 进度条 =====
    function setProgress(done, total) {
        var bar = $("evalProgressBar"), txt = $("evalProgressText"), pct = $("evalProgressPct");
        var p = total > 0 ? (done / total * 100) : 0;
        if (bar) bar.style.width = p + "%";
        if (txt) txt.textContent = done + "/" + total + " 张";
        if (pct) pct.textContent = Math.round(p) + "%";
    }

    // ===== 运行态切换 =====
    function setRunning(running) {
        state.running = running;
        var startBtn = $("startValidation"), stopBtn = $("stopValidation");
        if (startBtn) {
            startBtn.disabled = running;
            if (running) {
                startBtn.innerHTML = '<span class="material-symbols-outlined animate-spin">sync</span><span class="text-md">验证中...</span>';
                startBtn.classList.add("opacity-80");
            } else {
                startBtn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span><span class="text-md">开始验证</span>';
                startBtn.classList.remove("opacity-80");
            }
        }
        if (stopBtn) {
            // 未运行时也允许点（用于手动卸载已加载模型）；但视觉上不强禁用
            stopBtn.disabled = false;
        }
    }

    // ===== 「开始验证」 =====
    function bindStart() {
        var btn = $("startValidation");
        if (!btn || btn.dataset.evalBound === "1") return;
        btn.dataset.evalBound = "1";
        btn.addEventListener("click", runValidation);
    }

    async function runValidation() {
        if (state.running) return;
        if (!state.valImages.length) {
            if (window.showToast) showToast("请先把验证图片放入项目的 val 文件夹");
            log("[错误] 无验证图片：请把图片放入 val 文件夹后点刷新", "error");
            return;
        }
        setRunning(true);
        state.aborted = false;
        clearLog();
        setProgress(0, state.valImages.length);
        renderBoxes([]);
        log("[加载] 定位训练产物...", "load");

        // 1. 定位 best.pt（重新拉一次，防过期；refreshEvalModel 会更新 state.evalModel）
        await refreshEvalModel();
        if (state.aborted) { finishStop("已取消"); return; }
        var model = state.evalModel;
        if (!model || !model.bestPath) {
            log("[错误] 未找到训练产物 best.pt，请先完成一次训练", "error");
            if (window.showToast) showToast("未找到训练产物 best.pt");
            setRunning(false);
            return;
        }
        log("[加载] 模型：" + (model.bestName || model.bestPath), "load");

        // 2. 加载模型（已加载则复用）
        if (!model.loaded) {
            log("[加载] 模型加载中...", "load");
            try {
                var lr = await fetch("/api/model/load", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: model.bestPath })
                }).then(function (r) { return r.json(); });
                if (!lr || !lr.ok) throw new Error((lr && lr.error) || "加载失败");
                log("[加载] ✓ device=" + (lr.device || "?") + "，类别数=" + (lr.labels ? lr.labels.length : 0), "success");
                var gsL = $("evalGpuStatus");
                if (gsL) gsL.textContent = "device=" + (lr.device || "?");
            } catch (e) {
                log("[错误] 模型加载失败：" + e.message, "error");
                if (window.showToast) showToast("模型加载失败");
                setRunning(false);
                return;
            }
        } else {
            log("[加载] 模型已加载，复用", "load");
        }

        // 3. 指标（来自 results.csv）
        var m = model.metrics;
        if (m) {
            log("[指标] mAP@0.5=" + fmtMap(m.map50) + "  P=" + fmtPct(m.precision) + "  R=" + fmtPct(m.recall) +
                "  (epoch " + (m.epoch != null ? m.epoch : "?") + ")", "info");
        } else {
            log("[指标] 未找到 results.csv，顶部指标留空", "info");
        }

        // 4. 串行逐张推理
        var total = state.valImages.length, sumMs = 0;
        for (var i = 0; i < total; i++) {
            if (state.aborted) { finishStop("用户中断"); return; }
            var img = state.valImages[i];
            selectValImage(img.name, img.url, true);   // keepBoxes=true：切换图时不清框（推理完会重绘）
            log("[推理] " + img.name + "...", "info");
            var dr;
            try {
                dr = await fetch("/api/eval/detect/" + encodeURIComponent(img.name), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ conf: state.defaultConf })
                }).then(function (r) { return r.json(); });
            } catch (e) {
                log("[错误] " + img.name + " 请求失败：" + e.message, "error");
                setProgress(i + 1, total);
                continue;
            }
            if (state.aborted) { finishStop("用户中断"); return; }
            if (!dr || !dr.ok) {
                log("[错误] " + img.name + "：" + ((dr && dr.error) || "推理失败"), "error");
                setProgress(i + 1, total);
                continue;
            }
            var boxes = dr.boxes || [];
            renderBoxes(boxes);
            var ms = dr.elapsed_ms || 0;
            sumMs += ms;
            var lat = $("evalLatency");
            if (lat) lat.textContent = ms + " ms";
            var cnt = {};
            boxes.forEach(function (b) { cnt[b.label] = (cnt[b.label] || 0) + 1; });
            var parts = Object.keys(cnt).map(function (k) { return cnt[k] + "x " + k; });
            log("[检出] " + img.name + "：" + (parts.length ? parts.join(", ") : "无目标") + " (" + ms + " ms)", "detect");
            setProgress(i + 1, total);
        }

        // 5. 完成
        var avg = total > 0 ? Math.round(sumMs / total) : 0;
        log("[完成] 共 " + total + " 张，平均 " + avg + " ms", "success");
        setRunning(false);
        if (window.showToast) showToast("验证完成");
    }

    // ===== 「停止验证」 =====
    function bindStop() {
        var btn = $("stopValidation");
        if (!btn || btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", function () {
            if (state.running) {
                state.aborted = true;
                log("[停止] 已请求中断...", "stop");
                // 串行循环下一轮跳出；模型卸载由 finishStop 触发
                unloadModel();
            } else {
                // 未在运行：作为「手动卸载已加载模型」入口
                unloadModel();
            }
        });
    }

    async function unloadModel() {
        try {
            var r = await fetch("/api/model/unload", { method: "POST" }).then(function (x) { return x.json(); });
            if (r && r.ok) {
                log("[停止] 已卸载模型", "stop");
                if (window.showToast) showToast("已卸载模型");
            } else {
                log("[停止] 卸载失败：" + ((r && r.error) || "未知"), "error");
            }
        } catch (e) {
            log("[停止] 卸载失败：" + e.message, "error");
        }
        var gs = $("evalGpuStatus");
        if (gs) gs.textContent = "模型未加载";
        var lat = $("evalLatency");
        if (lat) lat.textContent = "—";
    }

    function finishStop(reason) {
        log("[停止] " + reason, "stop");
        setRunning(false);
        unloadModel();
    }

    // ===== 视频 tab（本次不接入：禁用 + 提示） =====
    function bindVideoTab() {
        var btn = $("evalModeVideo");
        if (!btn || btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", function (e) {
            e.preventDefault();
            if (window.showToast) showToast("视频验证开发中");
        });
    }

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
        return fetch("/api/eval/val_images")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || !data.ok) {
                    state.valImages = [];
                    state.valSelected = null;
                    renderValThumbs();
                    togglePreviewEmpty(true);
                    if (window.showToast) showToast((data && data.error) || "验证图片加载失败");
                    return;
                }
                state.valImages = data.images || [];
                state.valPath = data.valPath || "";
                // 当前选中图已被删 → 清空选中
                if (state.valSelected && !state.valImages.some(function (v) { return v.name === state.valSelected; })) {
                    state.valSelected = null;
                }
                var cntEl = $("evalListCount");
                if (cntEl) cntEl.textContent = String(state.valImages.length);
                renderValThumbs();
                if (!state.valImages.length) {
                    // 空：预览区留空（需求 1：没有则留空）
                    togglePreviewEmpty(true);
                    if ((data.created || data.empty) && window.showToast) {
                        showToast("请把验证图片放到项目的 val 文件夹后点刷新");
                    }
                } else {
                    togglePreviewEmpty(false);
                    // 默认选中第一张 → 大图区加载原图
                    if (!state.valSelected && state.valImages[0]) {
                        selectValImage(state.valImages[0].name, state.valImages[0].url);
                    }
                }
                if (opts.done && window.showToast) opts.done();
            })
            .catch(function () {
                state.valImages = [];
                renderValThumbs();
                togglePreviewEmpty(true);
                if (window.showToast) showToast("验证图片加载失败");
            });
    }

    // 预览区空状态切换：empty=true 显示空状态层、隐藏预览图；false 反之（由 selectValImage 控制预览图本身）
    function togglePreviewEmpty(empty) {
        var e = $("evalPreviewEmpty");
        var preview = $("evalPreviewImage");
        if (empty) {
            if (e) e.classList.remove("hidden");
            if (preview) preview.classList.add("hidden");
        } else {
            if (e) e.classList.add("hidden");
        }
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

    // keepBoxes=true：推理流程切换图时不清检测框（框由推理结果重绘）
    function selectValImage(name, url, keepBoxes) {
        var changed = state.valSelected !== name;
        state.valSelected = name;
        var preview = $("evalPreviewImage");
        if (preview && name && url) {
            preview.src = url;
            preview.classList.remove("hidden");
        }
        togglePreviewEmpty(false);
        if (changed) renderValThumbs();
        // 手动切图（非推理流程）→ 清空旧检测框
        if (!keepBoxes) renderBoxes([]);
    }

    function bindValRefresh() {
        var btn = $("evalValRefreshBtn");
        if (!btn || btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", function () {
            loadValImages({ done: function () { if (window.showToast) showToast("已刷新验证数据列表"); } });
        });
    }

    // ===== 初始化（仅绑定一次；每次进入验证阶段刷新类别 / 模型 / val 列表） =====
    function init() {
        if (!inited) {
            inited = true;
            bindMainSlider();
            bindStart();
            bindStop();
            bindVideoTab();
            bindThresholdDialog();
            bindValRefresh();
        }
        loadCategories();
        loadValImages();
        refreshEvalModel();
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
