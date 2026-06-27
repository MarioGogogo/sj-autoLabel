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
