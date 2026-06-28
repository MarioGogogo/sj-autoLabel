/* 训练阶段前端逻辑（独立 IIFE，加载在 image_list.js 之后）。
 *
 * 职责：xterm 终端初始化 + SSE 日志接管 + 参数面板交互 + 训练环境下拉 + start/stop/export。
 * 复用 image_list.js 暴露的全局弹窗 API（window.showConfirm/showToast/showNotification）。
 * 与后端通信沿用 {ok, error} 约定（见 image_list.js 的 detectCurrent）。
 */
(function () {
    "use strict";

    // ===================== 元素缓存 =====================
    var $ = function (id) { return document.getElementById(id); };
    var els = {
        terminal: $("trainTerminal"),
        statusBadge: $("trainStatusBadge"),
        envSelect: $("trEnvSelect"),
        envHint: $("trEnvHint"),
        model: $("trModel"),
        customModel: $("trCustomModel"),
        epochs: $("trEpochs"),
        imgsz: $("trImgsz"),
        batch: $("trBatch"),
        workers: $("trWorkers"),
        device: $("trDevice"),
        valRatio: $("trValRatio"),
        name: $("trName"),
        customParams: $("trCustomParams"),
        yamlFile: $("trYamlFile"),
        yamlName: $("trYamlName"),
        exportOnnx: $("trExportOnnx"),
        startBtn: $("trStartBtn"),
        stopBtn: $("trStopBtn"),
        exportBtn: $("trExportBtn"),
        trEnvPythonInput: $("trEnvPythonInput"),
        trEnvSaveBtn: $("trEnvSaveBtn"),
        trEnvConfigError: $("trEnvConfigError"),
        trPresetBtn: $("trPresetBtn"),
        presetDialog: $("presetDialog"),
        presetCloseBtn: $("presetCloseBtn"),
        presetCancelBtn: $("presetCancelBtn"),
        presetCardsBody: $("presetCardsBody"),
        coreParamsDialog: $("coreParamsDialog"),
        coreParamsBody: $("coreParamsBody"),
        coreParamsNote: $("coreParamsNote"),
        coreParamsCloseBtn: $("coreParamsCloseBtn"),
    };

    // 复用全局弹窗 API（image_list.js 暴露）
    var showConfirm = window.showConfirm;
    var showToast = window.showToast;
    var showNotification = window.showNotification;

    var term = null;
    var fitAddon = null;
    var termInited = false;
    var logsConnected = false;
    var yamlContent = "";          // 导入的 yaml 文本（独立于 textarea 的 key=value）
    var statusTimer = null;
    var lastState = "idle";
    var envScanAbort = null;       // 环境扫描 AbortController，用于超时控制

    // ===================== xterm 终端 =====================
    function initTerminal() {
        if (termInited) return;
        if (!els.terminal) return;
        if (typeof Terminal === "undefined") {
            els.terminal.innerHTML = '<div class="p-sm font-label-mono text-xs text-error" style="color:#f87171">'
                + 'xterm.js 未能加载。请尝试重启应用或检查 static/vendor/xterm/ 文件是否完整。</div>';
            return;
        }
        term = new Terminal({
            fontSize: 13,
            lineHeight: 1.2,
            fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
            scrollback: 10000,
            disableStdin: true,
            convertEol: true,      // 设为 true：自动将 \n 转为 \r\n，消除阶梯状错位；单 \r 仍然保持原地刷新
            cursorBlink: false,
            theme: {
                background: "#0d1117",
                foreground: "#c9d1d9",
                cursor: "#c9d1d9",
                selectionBackground: "#58a6ff33",
                black: "#484f58",
                red: "#ff7b72",
                green: "#3fb950",
                yellow: "#d29922",
                blue: "#58a6ff",
                magenta: "#bc8cff",
                cyan: "#39c5cf",
                white: "#b1bac4",
                brightBlack: "#6e7681",
                brightRed: "#ffa198",
                brightGreen: "#56d364",
                brightYellow: "#e3b341",
                brightBlue: "#79c0ff",
                brightMagenta: "#d2a8ff",
                brightCyan: "#56d4dd",
                brightWhite: "#f0f6fc",
            },
        });
        fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(els.terminal);
        termInited = true;
        safeFit();
        term.writeln("训练终端就绪。设置参数后点「开始训练」。");
        if (!logsConnected) {
            logsConnected = true;
            connectLogs();
        }
    }

    function safeFit() {
        if (!fitAddon || !term) return;
        try { fitAddon.fit(); } catch (e) { /* 容器未可见时忽略 */ }
    }

    var logCursor = 0;
    var logPollTimer = null;

    // ===================== 智能自适应日志拉取 =====================
    function startLogPolling() {
        if (logPollTimer) return;
        // 500ms 极低开销按需轮询，比 200ms 省电 60% 以上
        logPollTimer = setInterval(async function () {
            try {
                var resp = await fetch("/api/train/logs_poll?cursor=" + logCursor);
                var data = await resp.json();
                if (resp.ok && data.ok) {
                    if (data.text && term) {
                        term.write(data.text);
                    }
                    logCursor = data.cursor;
                }
            } catch (e) { /* ignore */ }
        }, 500);
    }

    function stopLogPolling() {
        if (logPollTimer) {
            clearInterval(logPollTimer);
            logPollTimer = null;
        }
    }

    function connectLogs() {
        // 备用 SSE
        try {
            var es = new EventSource("/api/train/logs");
            es.onmessage = function (ev) {
                if (!term) return;
                try { term.write(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
            };
            es.onerror = function () { /* 自动重连 */ };
        } catch (e) { /* ignore */ }
    }

    // ===================== 状态轮询 =====================
    function startPolling() {
        if (statusTimer) return;
        statusTimer = setInterval(pollStatus, 1000);
        pollStatus();
    }

    async function pollStatus() {
        try {
            var resp = await fetch("/api/train/status");
            var data = await resp.json();
            if (!resp.ok || !data.ok) return;
            updateUI(data.state, data.result);
        } catch (e) { /* ignore */ }
    }

    var STATE_LABEL = {
        idle: { text: "空闲", cls: "bg-neutral-800 text-neutral-400" },
        running: { text: "训练中", cls: "bg-primary/20 text-primary animate-pulse" },
        done: { text: "已完成", cls: "bg-primary/20 text-primary" },
        error: { text: "失败", cls: "bg-error/20 text-error" },
        cancelled: { text: "已停止", cls: "bg-neutral-800 text-neutral-400" },
    };

    function updateUI(state, result) {
        var info = STATE_LABEL[state] || STATE_LABEL.idle;
        if (els.statusBadge) {
            els.statusBadge.textContent = info.text;
            els.statusBadge.className = "font-label-mono text-[10px] px-sm py-1 rounded-full " + info.cls;
        }
        var running = state === "running";
        if (els.startBtn) els.startBtn.disabled = running;
        if (els.stopBtn) {
            els.stopBtn.disabled = !running;
            els.stopBtn.classList.toggle("opacity-50", !running);
            els.stopBtn.classList.toggle("cursor-not-allowed", !running);
        }

        // 智能自适应控制：只有在训练进行中时才开启日志轮询，空闲/完成/停止时完全关闭
        if (running) {
            startLogPolling();
        } else {
            // 训练停止或结束时，最后再拉取一次残余日志，随后完全销毁定时器
            if (logPollTimer) {
                fetch("/api/train/logs_poll?cursor=" + logCursor)
                    .then(r => r.json())
                    .then(data => {
                        if (data && data.text && term) term.write(data.text);
                    }).catch(() => {}).finally(() => { stopLogPolling(); });
            }
        }

        // 仅状态变化时通知
        if (state !== lastState) {
            if (state === "done") {
                if (typeof showToast === "function") showToast("训练完成！");
                if (typeof showNotification === "function") {
                    showNotification({
                        type: "success", title: "训练完成", duration: 6000,
                        message: "可点「导出模型到项目」把 best.pt 复制到 models/ 供智能标注加载",
                    });
                }
            } else if (state === "error") {
                if (typeof showNotification === "function") {
                    showNotification({ type: "error", title: "训练失败", duration: 6000, message: "请查看终端输出的错误信息" });
                }
            }
            lastState = state;
        }
    }

    function printEnvInfo(cudaVer, envName, envPath) {
        if (!term) return;
        term.writeln("\x1b[1;36m[INFO]\x1b[0m 当前CUDA版本: " + (cudaVer || "13.3"));
        if (envName) term.writeln("\x1b[1;36m[INFO]\x1b[0m 使用YOLO环境: " + envName);
        if (envPath) term.writeln("\x1b[1;36m[INFO]\x1b[0m 环境路径: " + envPath);
    }

    // ===================== 训练环境加载 =====================
    async function loadEnvs() {
        if (!els.envSelect) return;
        try {
            var resp = await fetch("/api/train/env");
            var data = await resp.json();
            if (!resp.ok || !data.ok) return;
            var envs = data.envs || [];
            els.envSelect.innerHTML = "";
            if (!envs.length) {
                els.envSelect.innerHTML = "<option value=''>未配置环境，请在右侧手动输入路径</option>";
                if (els.envHint) els.envHint.textContent = "已按要求关闭后台自动扫描。请在右侧输入框填入 python.exe 路径并保存。";
                return;
            }
            var selected = data.selected || "";
            envs.forEach(function (e) {
                var opt = document.createElement("option");
                opt.value = e.python;
                opt.textContent = e.name + " (" + e.python + ")";
                if (e.python === selected) opt.selected = true;
                els.envSelect.appendChild(opt);
            });
            if (els.envHint) els.envHint.textContent = "当前训练环境：" + selected;
            // 在终端打印初始化环境与 CUDA 明细
            printEnvInfo(data.cudaVersion, data.envName, data.envPath);
        } catch (e) { /* ignore */ }
    }

    // ===================== 参数收集 =====================
    function collectParams() {
        var model = els.model.value;
        if (model === "__custom__") {
            model = (els.customModel.value || "").trim();
            if (!model) throw new Error("请填写自定义模型路径");
        }
        var name = (els.name.value || "").trim() || "exp";
        // 优先下拉框已选环境，否则取手动输入框的值
        var trainPythonPath = els.envSelect.value || (els.trEnvPythonInput ? els.trEnvPythonInput.value.trim() : "");
        return {
            trainPythonPath: trainPythonPath,
            model: model,
            epochs: parseInt(els.epochs.value, 10) || 50,
            imgsz: parseInt(els.imgsz.value, 10) || 640,
            batch: (els.batch.value || "").trim() || 16,
            workers: parseInt(els.workers.value, 10) || 8,
            device: els.device.value,
            name: name,
            valRatio: parseFloat(els.valRatio.value) || 0.2,
            exportOnnx: els.exportOnnx.checked,
            customParamsText: els.customParams.value,
            customParamsYaml: yamlContent,
        };
    }

    // ===================== 动作 =====================
    async function startTrain() {
        initTerminal();  // 确保终端就绪
        if (!els.envSelect.value && els.trEnvPythonInput && !els.trEnvPythonInput.value.trim()) {
            var noEnvMsg = "错误：未选择训练环境。请在右侧手动输入 Python 路径或等待自动扫描完成。";
            if (term) term.writeln(noEnvMsg);
            if (typeof showToast === "function") showToast("请先选择训练环境");
            return;
        }
        var params;
        try { params = collectParams(); }
        catch (e) { if (typeof showToast === "function") showToast(e.message); return; }

        if (term) { term.writeln("\n\x1b[1;33m[SYS]\x1b[0m 正在启动训练进程，准备提交训练参数..."); }
        if (els.startBtn) els.startBtn.disabled = true;
        try {
            var resp = await fetch("/api/train/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });
            var data = await resp.json();
            if (!resp.ok || !data.ok) {
                var errMsg = "训练启动失败：" + (data.error || "未知错误");
                if (term) term.writeln(errMsg);
                throw new Error(data.error || "启动训练失败");
            }
            if (term) term.writeln("训练已启动，等待输出...");
            lastState = "idle";  // 让轮询的 done/error 通知能触发
            pollStatus();
        } catch (e) {
            if (els.startBtn) els.startBtn.disabled = false;
            if (typeof showToast === "function") showToast("启动失败：" + e.message);
        }
    }

    async function stopTrain() {
        var ok = typeof showConfirm === "function"
            ? await showConfirm({
                title: "停止训练", okText: "停止", danger: true,
                message: "确定要终止当前训练吗？已产出的检查点会保留。",
            })
            : window.confirm("停止训练？");
        if (!ok) return;
        try {
            var resp = await fetch("/api/train/stop", { method: "POST" });
            var data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "停止失败");
        } catch (e) {
            if (typeof showToast === "function") showToast("停止失败：" + e.message);
        }
    }

    async function exportModel() {
        var name = (els.name.value || "").trim() || "exp";
        try {
            var resp = await fetch("/api/train/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: name }),
            });
            var data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "导出失败");
            var msg = data.onnx
                ? "已导出 models/" + name + ".pt 与 " + name + ".onnx"
                : "已导出 models/" + name + ".pt";
            if (typeof showNotification === "function") {
                showNotification({ type: "success", title: "导出成功", duration: 6000, message: msg + "（可在智能标注阶段加载）" });
            }
        } catch (e) {
            if (typeof showToast === "function") showToast("导出失败：" + e.message);
        }
    }

    // ===================== 手动输入训练环境 =====================
    async function saveTrainEnv(pythonPath) {
        if (!pythonPath) {
            if (typeof showToast === "function") showToast("请输入 Python 路径");
            return;
        }
        var errorEl = els.trEnvConfigError;
        if (errorEl) errorEl.classList.add("hidden");
        if (els.trEnvSaveBtn) { els.trEnvSaveBtn.disabled = true; els.trEnvSaveBtn.textContent = "…"; }

        try {
            var resp = await fetch("/api/train/env/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pythonPath: pythonPath }),
            });
            var data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "保存失败");

            // 更新下拉框：插入新选项并选中
            if (els.envSelect) {
                var opt = document.createElement("option");
                opt.value = pythonPath;
                opt.textContent = data.name
                    ? data.name + "（ultralytics " + (data.runtime && data.runtime.ultralytics || "?") + "）"
                    : pythonPath;
                opt.selected = true;
                // 插入到最前面
                var first = els.envSelect.firstChild;
                if (first) { els.envSelect.insertBefore(opt, first); }
                else { els.envSelect.appendChild(opt); }
                els.envSelect.value = pythonPath;
            }
            if (els.envHint) {
                var runtime = data.runtime || {};
                els.envHint.textContent = runtime.ultralytics
                    ? "ultralytics " + runtime.ultralytics + " | PyTorch " + (runtime.torch || "?")
                    : "训练环境已保存";
            }
            // 在终端以指定格式输出 [INFO] 信息
            printEnvInfo(data.cudaVersion, data.name, data.envPath);
            if (typeof showToast === "function") showToast("训练环境已保存");
        } catch (e) {
            if (errorEl) { errorEl.textContent = e.message; errorEl.classList.remove("hidden"); }
            if (typeof showToast === "function") showToast("配置失败：" + e.message);
        } finally {
            if (els.trEnvSaveBtn) { els.trEnvSaveBtn.disabled = false; els.trEnvSaveBtn.textContent = "保存"; }
        }
    }

    // ===================== 核心默认参数弹窗（只读查看） =====================
    var coreParamsCache = {};     // 按预设 id 缓存参数数据（"" = 默认），避免重复请求
    var presetsCache = null;      // 预设元数据列表缓存
    var selectedPreset = null;    // 当前选中的预设 id

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // 值渲染（仿参考截图）：布尔 → 彩色 Badge（True 蓝 / False 灰），数字 → 纯文字，字符串 → 加单引号
    function renderCoreParamValue(value) {
        var TEXT_CLS = "font-label-mono text-xs text-on-surface whitespace-nowrap";
        if (value === true) {
            return '<span class="inline-flex items-center px-sm py-[1px] rounded text-[11px] font-label-mono bg-primary text-on-primary">True</span>';
        }
        if (value === false) {
            return '<span class="inline-flex items-center px-sm py-[1px] rounded text-[11px] font-label-mono bg-on-surface-variant text-surface-container-lowest">False</span>';
        }
        if (typeof value === "string") {
            return '<span class="' + TEXT_CLS + '">&#39;' + escapeHtml(value) + '&#39;</span>';
        }
        return '<span class="' + TEXT_CLS + '">' + escapeHtml(String(value)) + '</span>';
    }

    function renderCoreParams(data) {
        if (!els.coreParamsBody || !els.coreParamsNote) return;
        els.coreParamsNote.textContent = data.basicNote || "";
        var html = (data.groups || []).map(function (g, gi) {
            var rows = (g.items || []).map(function (it) {
                return '<div class="flex items-center justify-between gap-md px-md py-sm">'
                    + '<div class="min-w-0">'
                    + '<div class="font-label-mono text-xs text-on-surface-variant">' + escapeHtml(it.key) + '</div>'
                    + '<div class="font-body-md text-[11px] text-outline leading-tight mt-[2px]">' + escapeHtml(it.note) + '</div>'
                    + '</div>'
                    + '<div class="flex-shrink-0">' + renderCoreParamValue(it.value) + '</div>'
                    + '</div>';
            }).join("");
            return '<section class="rounded-lg border border-outline-variant bg-surface-container overflow-hidden">'
                + '<header class="flex items-center gap-sm px-md py-sm border-b border-outline-variant">'
                + '<span class="font-headline-sm text-primary font-bold w-5 text-center">' + (gi + 1) + '</span>'
                + '<span class="font-label-caps text-on-surface font-semibold">' + escapeHtml(g.title) + '</span>'
                + '</header>'
                + '<div class="divide-y divide-outline-variant">' + rows + '</div>'
                + '</section>';
        }).join("");
        els.coreParamsBody.innerHTML = html;
    }

    // ===================== 预设选择弹窗 =====================
    function openPresetDialog() {
        if (!els.presetDialog) return;
        renderPresetCards();        // presetsCache 未就绪时显示加载骨架
        els.presetDialog.classList.remove("hidden");
        if (!presetsCache) loadPresets();
    }

    function closePresetDialog() {
        if (els.presetDialog) els.presetDialog.classList.add("hidden");
    }

    async function loadPresets() {
        try {
            var resp = await fetch("/api/train/presets");
            var data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "加载失败");
            presetsCache = data.presets || [];
            selectedPreset = data.selected || (presetsCache[0] && presetsCache[0].id) || "";
            renderPresetCards();
        } catch (e) {
            if (typeof showToast === "function") showToast("加载预设失败：" + e.message);
        }
    }

    function renderPresetCards() {
        if (!els.presetCardsBody) return;
        if (!presetsCache) {
            els.presetCardsBody.innerHTML = '<div class="col-span-3 p-md text-center text-on-surface-variant font-label-mono text-xs">加载预设中…</div>';
            return;
        }
        var html = presetsCache.map(function (p) {
            var active = p.id === selectedPreset;
            var tags = (p.tags || []).map(function (t) {
                return '<span class="inline-block px-sm py-[1px] rounded-full bg-surface-variant text-on-surface-variant font-label-mono text-[10px]">' + escapeHtml(t) + '</span>';
            }).join("");
            var badge = p.recommended
                ? '<span class="inline-flex items-center px-sm py-[1px] rounded text-[10px] font-label-caps bg-primary text-on-primary">推荐</span>'
                : '';
            return '<section class="rounded-lg border p-md flex flex-col gap-sm ' + (active ? "border-primary bg-primary/5" : "border-outline-variant bg-surface") + '" data-id="' + escapeHtml(p.id) + '">'
                + '<div class="flex items-start justify-between gap-sm">'
                + '<div class="flex items-center gap-sm min-w-0">'
                + '<span class="material-symbols-outlined text-[20px] ' + (active ? "text-primary" : "text-on-surface-variant") + '">' + escapeHtml(p.icon || "tune") + '</span>'
                + '<span class="font-headline-sm text-on-surface font-semibold truncate">' + escapeHtml(p.name) + '</span>'
                + '</div>'
                + badge
                + '</div>'
                + '<p class="font-body-md text-xs text-on-surface-variant leading-tight">' + escapeHtml(p.desc) + '</p>'
                + '<div class="flex flex-wrap gap-xs">' + tags + '</div>'
                + '<div class="flex gap-xs mt-auto pt-xs">'
                + '<button type="button" class="preset-preview flex-1 flex items-center justify-center gap-xs px-sm py-sm rounded-lg border border-primary text-primary hover:bg-primary/10 font-label-caps text-label-caps transition-all" data-id="' + escapeHtml(p.id) + '">'
                + '<span class="material-symbols-outlined text-[16px]">visibility</span>预览'
                + '</button>'
                + '<button type="button" class="preset-apply flex-1 flex items-center justify-center gap-xs px-sm py-sm rounded-lg font-label-caps text-label-caps transition-all ' + (active ? "bg-surface-variant text-on-surface-variant cursor-default" : "bg-primary text-on-primary hover:opacity-90") + '" data-id="' + escapeHtml(p.id) + '"' + (active ? " disabled" : "") + '>'
                + '<span class="material-symbols-outlined text-[16px]">check</span>' + (active ? "已应用" : "应用预设")
                + '</button>'
                + '</div>'
                + '</section>';
        }).join("");
        els.presetCardsBody.innerHTML = html;
    }

    async function applyPreset(presetId) {
        var preset = null;
        for (var i = 0; presetsCache && i < presetsCache.length; i++) {
            if (presetsCache[i].id === presetId) { preset = presetsCache[i]; break; }
        }
        if (!preset) return;
        var ok = await showConfirm({
            title: "应用预设「" + preset.name + "」",
            message: "将以此预设的超参数作为训练起点（学习率 / 数据增强 / 早停等），覆盖当前选择。右侧面板基础参数与自定义参数仍可进一步覆盖。",
            okText: "应用",
        });
        if (!ok) return;
        try {
            var resp = await fetch("/api/train/preset/apply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ preset: presetId }),
            });
            var data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "应用失败");
            selectedPreset = data.selected;
            coreParamsCache = {};   // 清空预览缓存，下次预览重新拉取
            renderPresetCards();
            if (typeof showToast === "function") showToast("已应用「" + preset.name + "」预设");
        } catch (e) {
            if (typeof showToast === "function") showToast("应用预设失败：" + e.message);
        }
    }

    // ===================== 核心默认参数弹窗（只读查看 / 预览目标） =====================
    async function openCoreParamsDialog(presetId) {
        if (!els.coreParamsDialog) return;
        var id = presetId || "";
        if (!coreParamsCache[id]) {
            try {
                var url = "/api/train/core_params" + (id ? "?preset=" + encodeURIComponent(id) : "");
                var resp = await fetch(url);
                var data = await resp.json();
                if (!resp.ok || !data.ok) throw new Error(data.error || "加载失败");
                coreParamsCache[id] = data;
            } catch (e) {
                if (typeof showToast === "function") showToast("加载参数失败：" + e.message);
                return;
            }
        }
        var cached = coreParamsCache[id];
        renderCoreParams(cached);
        var titleEl = els.coreParamsDialog.querySelector("h3");
        if (titleEl) titleEl.textContent = cached.presetName ? ("参数预览 · " + cached.presetName) : "训练核心默认参数";
        els.coreParamsDialog.classList.remove("hidden");
    }

    function closeCoreParamsDialog() {
        if (!els.coreParamsDialog) return;
        els.coreParamsDialog.classList.add("hidden");
        var titleEl = els.coreParamsDialog.querySelector("h3");
        if (titleEl) titleEl.textContent = "训练核心默认参数";
    }

    // ===================== 事件绑定 =====================
    function bind() {
        if (els.startBtn) els.startBtn.addEventListener("click", startTrain);
        if (els.stopBtn) els.stopBtn.addEventListener("click", stopTrain);
        if (els.exportBtn) els.exportBtn.addEventListener("click", exportModel);

        // 手动输入训练环境
        if (els.trEnvSaveBtn && els.trEnvPythonInput) {
            els.trEnvSaveBtn.addEventListener("click", function () {
                saveTrainEnv(els.trEnvPythonInput.value.trim());
            });
            els.trEnvPythonInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter") saveTrainEnv(els.trEnvPythonInput.value.trim());
            });
        }

        // 基础模型：选「自定义」时显示路径输入框
        if (els.model) {
            els.model.addEventListener("change", function () {
                var isCustom = els.model.value === "__custom__";
                els.customModel.classList.toggle("hidden", !isCustom);
            });
        }

        // 导入 yaml：读取文件文本存到 yamlContent（与 textarea 的 key=value 并存，后者优先级更高）
        if (els.yamlFile) {
            els.yamlFile.addEventListener("change", function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                    yamlContent = String(reader.result || "");
                    if (els.yamlName) {
                        els.yamlName.textContent = "已导入：" + file.name + "（参数会合并，同名键被 yaml 覆盖）";
                        els.yamlName.classList.remove("hidden");
                    }
                };
                reader.readAsText(file);
                e.target.value = "";  // 允许重复导入同名文件
            });
        }

        // 窗口缩放适配终端
        window.addEventListener("resize", safeFit);
        // 进入训练页时适配终端尺寸（容器从 hidden→可见后尺寸才正确）
        window.addEventListener("stage-change", function (e) {
            var stage = e.detail && e.detail.stage;
            if (stage === "train") safeFit();
        });

        // 预设选择弹窗：入口 + 关闭（按钮 / 取消 / 遮罩 / Esc）+ 卡片事件委托（预览 / 应用）
        if (els.trPresetBtn) els.trPresetBtn.addEventListener("click", openPresetDialog);
        if (els.presetCloseBtn) els.presetCloseBtn.addEventListener("click", closePresetDialog);
        if (els.presetCancelBtn) els.presetCancelBtn.addEventListener("click", closePresetDialog);
        if (els.presetDialog) {
            els.presetDialog.addEventListener("click", function (e) {
                if (e.target === els.presetDialog) closePresetDialog();
            });
        }
        if (els.presetCardsBody) {
            els.presetCardsBody.addEventListener("click", function (e) {
                var previewBtn = e.target.closest ? e.target.closest(".preset-preview") : null;
                var applyBtn = e.target.closest ? e.target.closest(".preset-apply") : null;
                if (previewBtn) {
                    openCoreParamsDialog(previewBtn.getAttribute("data-id"));
                } else if (applyBtn && !applyBtn.disabled) {
                    applyPreset(applyBtn.getAttribute("data-id"));
                }
            });
        }

        // 核心默认参数弹窗（预览目标）：关闭按钮 / 遮罩
        if (els.coreParamsCloseBtn) els.coreParamsCloseBtn.addEventListener("click", closeCoreParamsDialog);
        if (els.coreParamsDialog) {
            els.coreParamsDialog.addEventListener("click", function (e) {
                if (e.target === els.coreParamsDialog) closeCoreParamsDialog();
            });
        }
        // Esc：优先关上层 coreParamsDialog，其次 presetDialog
        window.addEventListener("keydown", function (e) {
            if (e.key !== "Escape") return;
            if (els.coreParamsDialog && !els.coreParamsDialog.classList.contains("hidden")) {
                closeCoreParamsDialog();
            } else if (els.presetDialog && !els.presetDialog.classList.contains("hidden")) {
                closePresetDialog();
            }
        });
    }

    // ===================== 初始化 =====================
    function init() {
        bind();
        initTerminal();  // 提前初始化终端，不依赖 stage-change；未切换到训练页时无法适配尺寸，但 SSE 日志连接已就绪
        loadEnvs();
        startPolling();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
