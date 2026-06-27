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

    // ===================== xterm 终端 =====================
    function initTerminal() {
        if (termInited) return;
        if (!els.terminal || typeof Terminal === "undefined") return;
        term = new Terminal({
            fontSize: 12,
            fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
            scrollback: 5000,
            disableStdin: true,
            convertEol: false,     // 保留 \r，让 ultralytics 进度条原地刷新
            cursorBlink: false,
            theme: { background: "#0b0b0b", foreground: "#d4d4d4", cursor: "#d4d4d4" },
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

    // ===================== SSE 日志接管 =====================
    function connectLogs() {
        try {
            var es = new EventSource("/api/train/logs");
            es.onmessage = function (ev) {
                if (!term) return;
                try { term.write(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
            };
            // 心跳行（": heartbeat"）是 SSE 注释，不会触发 onmessage；onerror 时 EventSource 自动重连。
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

    // ===================== 训练环境下拉 =====================
    async function loadEnvs() {
        if (!els.envSelect) return;
        try {
            var resp = await fetch("/api/train/env");
            var data = await resp.json();
            if (!resp.ok || !data.ok) return;
            var envs = data.envs || [];
            els.envSelect.innerHTML = "";
            if (!envs.length) {
                els.envSelect.innerHTML = "<option value=''>未发现含 ultralytics 的环境</option>";
                if (els.envHint) els.envHint.textContent = "请先在含 ultralytics 的环境启动，或检查 conda 环境";
                return;
            }
            var selected = data.selected || "";
            envs.forEach(function (e) {
                var opt = document.createElement("option");
                opt.value = e.python;
                opt.textContent = e.name + "（ultralytics " + (e.ultralytics || "?") + ")";
                if (e.python === selected) opt.selected = true;
                els.envSelect.appendChild(opt);
            });
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
        return {
            trainPythonPath: els.envSelect.value,
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
        if (!els.envSelect.value) {
            if (typeof showToast === "function") showToast("请先选择训练环境");
            return;
        }
        var params;
        try { params = collectParams(); }
        catch (e) { if (typeof showToast === "function") showToast(e.message); return; }

        if (term) term.clear();  // 清屏，准备接收新训练输出
        if (els.startBtn) els.startBtn.disabled = true;
        try {
            var resp = await fetch("/api/train/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });
            var data = await resp.json();
            if (!resp.ok || !data.ok) throw new Error(data.error || "启动训练失败");
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

    // ===================== 事件绑定 =====================
    function bind() {
        if (els.startBtn) els.startBtn.addEventListener("click", startTrain);
        if (els.stopBtn) els.stopBtn.addEventListener("click", stopTrain);
        if (els.exportBtn) els.exportBtn.addEventListener("click", exportModel);

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
        // 进入训练页时初始化终端 + 适配尺寸（容器从 hidden→可见后尺寸才正确）
        window.addEventListener("stage-change", function (e) {
            var stage = e.detail && e.detail.stage;
            if (stage === "train") {
                initTerminal();
                safeFit();
            }
        });
    }

    // ===================== 初始化 =====================
    function init() {
        bind();
        loadEnvs();
        startPolling();
        // 终端 + SSE 延迟到进入训练页时初始化（见 stage-change 监听）
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
