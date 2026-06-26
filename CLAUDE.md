# CLAUDE.md

本文件为 Claude Code（及开发者）在本仓库工作时的导航与约定。先读这里，再动代码。

## 项目简介

**视界标注专业版** —— 桌面端图像标注工作台。基于 Flask + pywebview，支持打开本地文件夹、手动画框、YOLO/ONNX 模型自动标注。单页应用，三栏布局（左侧图片列表 / 中间画布 / 右侧模型与类别配置）。

## 技术栈

- **后端**：Flask 3.0.3，Python 3.14（见 `venv`）
- **图像处理**：Pillow 10.4.0（缩略图生成）
- **前端**：原生 HTML + Tailwind CSS（预编译静态文件）+ 原生 JS（无框架）
- **字体/图标**：Inter / JetBrains Mono / Material Symbols（本地 woff2，零 CDN 依赖）
- **持久化**：服务端文件系统，所有读写基于用户自选的项目目录

所有静态资源本地化，桌面端启动秒开，无需联网。

### 修改了 Tailwind class / 配置之后

```bash
npm run build:css     # 重新扫描 HTML/JS 并生成 static/css/tailwind.css
```

> `tailwind.config.js` 与模板 `templates/**/*.html` / `static/js/**/*.js` 是 class 扫描源。
> 首次 `npm install` 后即有 tailwindcss CLI，无需全局安装。

## 目录结构

```
app.py                  Flask 入口：路由、项目、模型加载、推理 API
detector.py             检测器模块：环境检测 + Worker 管理 + 进程内推理（全局单例）
worker.py               独立推理 Worker 子进程（stdlib only，供外部 Python 环境运行）
requirements.txt        Flask + Pillow + pywebview
package.json            Tailwind CSS + 字体 npm 依赖
tailwind.config.js      Tailwind 配置
templates/
  index.html            主页面（三栏布局 + 对话框 + 右键菜单 + 环境配置面板)
  _image_item.html      单张图片卡片
static/
  css/
    tailwind-input.css  Tailwind 构建入口
    tailwind.css        预编译 Tailwind（24KB）
    style.css           全部自定义样式
  js/image_list.js      全部前端逻辑（IIFE 单文件）
    → 关键函数：detectCurrent() / autoDetect / saveEnvConfig()
  fonts/                本地字体（Inter + JetBrains Mono + Material Symbols）
venv/                   本地虚拟环境
~/.autolabels/
  config.json           推理环境持久化配置（pythonPath）
```

## 常用命令

```bash
source venv/bin/activate          # 激活虚拟环境
python app.py                     # 桌面模式（pywebview 窗口，默认）
python app.py --browser           # 浏览器模式（http://127.0.0.1:5055）
```

> macOS 上 5000 端口常被「AirPlay 接收器」占用。桌面模式会自动找空闲端口（5055~5074），无需手动处理。
>
> Windows 上桌面模式依赖 Edge WebView2 运行时。若未安装，启动时会提示下载地址：
> https://go.microsoft.com/fwlink/p/?LinkId=2124703

### 桌面模式（pywebview）

- 默认 `python app.py` 即桌面窗口，系统 WebView 包裹前端，无需外部浏览器。
- macOS 使用 WKWebView（系统内置，不可卸载）；Windows 使用 Edge WebView2。
- 传 `--browser` 回退到传统 Flask 开发服务器 + 浏览器模式。
- pywebview 窗口关闭后，Flask 线程自动退出（daemon）。

### 生产跑（多线程，避免批量推理时请求排队）

```bash
pip install waitress
waitress-serve --listen=127.0.0.1:5000 app:app
```

`debug=True` 是单线程 + 热重载，仅用于开发；量产务必用 waitress/gunicorn。

## 架构要点

### 数据流

- 用户本地项目目录结构：`images/`（原图）+ `labels/`（YOLO txt）+ `classes.txt` + `colors.json`
- 项目打开 → `POST /api/project/open` → 扫描 `images/` → 返回图片清单 + 类别列表
- 图片读取 → `GET /api/project/image/<name>` → `send_from_directory`（basename 防穿越）
- 标注保存 → `PUT /api/labels/<name>` → 写 `labels/<stem>.txt`（YOLO 中心点格式）
- 所有路径操作基于 `ACTIVE_PROJECT` 全局变量

### 前端核心（`static/js/image_list.js`）

一个大 IIFE，模块分区：

- **图片列表**：导入、渲染、计数、清空（`renderImageItem` / `appendImages` / `clearAll`）
- **画布视图**：居中缩放 + 拖拽平移（`zoomBy` / `resetView`，`view = {scale,x,y}`）
- **标注框**：数据 `currentBoxes`，每项 `{id, label, score, x, y, w, h, hex}`，**坐标全部 0~1 归一化比例**
- **框交互**：中空穿透架构——`.bbox` 本体 `pointer-events:none`，仅 `.bbox-edge`（4 条边）和 `.handle`（8 个把手）接收事件，便于在大框内框选小目标
- **类别系统**：`CATEGORIES` 数组，每项 `{label, color, hex}`；hex 驱动渲染（内联 style），支持任意颜色；`activeCategory` 决定新画框的颜色与标签
- **对话框**：通用 `showConfirm(opts)→Promise<bool>` 与 `showToast(msg)`（见下），已替换全部原生 `confirm`/`alert`

### 通用弹窗 API（务必复用，别再用原生 confirm/alert）

```js
const ok = await showConfirm({
    title: "标题", message: "正文",
    okText: "删除", danger: true,   // danger → 红色确认键
});
showToast("操作失败：" + err.message);
```

## 约定（改代码前必读）

1. **坐标统一 0~1 归一化**：模型、保存、渲染都用左上角 + 宽高的比例值。像素坐标转换在后端做。
2. **颜色用 hex**：新增类别 / 渲染框一律用 `hex` 内联 style，别依赖 `border-primary` 这类 Tailwind 语义 class（已有类别的 color 字段仅作 id）。
3. **弹窗复用** `showConfirm` / `showToast`，不要引入原生 `confirm`/`alert`。
4. **前端单文件**：逻辑加到 `image_list.js` 对应分区，DOM 加到 `templates/index.html`；保持 `_image_item.html` 与 JS `renderImageItem()` 结构一致。
5. **文件名清洗**：用户输入的文件名拼路径前必须 `os.path.basename()` 防路径穿越（见下「文件读写」）。
6. **响应式与无障碍**：已支持 `prefers-reduced-motion`、键盘快捷键、`scrollIntoView`；新增交互尽量延续。

## 快捷键速查

| 键 | 功能 |
|---|---|
| `B` | 画框工具开关 |
| `Esc` | 关闭对话框 / 退出绘制 / 取消选中 |
| `Del` / `Backspace` | 删除选中框 |
| `←/→/↑/↓` | 切换图片 |
| `Ctrl/Cmd + +/-/0` | 缩放 / 重置 |

---

## 参考章节：AI 模型推理

### 两种推理模式

```
┌─ 进程内模式：当前 venv 有 torch/ultralytics 或 onnxruntime
│    → detector.load() → detector.predict() 直接调用
│
└─ Worker 模式：当前 venv 无推理运行时，配置外部 Python 路径
     → 启动 worker.py 子进程（HTTP server）
     → detector 通过 localhost 调用 Worker
     → 模型在 Worker 进程中只加载一次，常驻内存
```

### 推理环境选择流程

```
app 启动
  ├─ 进程内 import torch/onnx → 直接推理 ✅
  ├─ 没找到 → 读 ~/.autolabels/config.json
  │    └─ 有 pythonPath → _probe_python() 探测
  │         ├─ 该环境有 torch/onnx → 启动 Worker ✅
  │         └─ 没有 → 拒绝保存
  └─ 都没有 → 侧栏展示「推理环境」配置面板
       ├─ 列出扫描到的 conda/venv 环境（可点击选用）
       └─ 手动输入 Python 路径 → 保存 → 后端探测 → 启动 Worker
```

### 关键 API

| 端点 | 用途 |
|---|---|
| `GET /api/env/check` | 环境检测 + 外部扫描 + 当前配置 `{pt, onnx, external, config}` |
| `GET /api/env/config` | 读取持久化配置 `{pythonPath, hasWorker}` |
| `POST /api/env/config` | 保存外部 Python 路径（探测通过后启动 Worker） |
| `POST /api/model/load` | 加载模型（进程内或 Worker 转发 `/load`） |
| `GET /api/model/status` | 返回 `{loaded, model, device, labels}` |
| `POST /api/detect/<image_name>` | 单张推理（进程内或 Worker 转发 `/predict`） |

### Worker 子进程（`worker.py`）

- **零额外依赖**：只使用 Python stdlib（`http.server`），外部环境只需 torch/onnx
- **HTTP 协议**：监听 `127.0.0.1:5090-5120`
- **端点**：`GET /health` / `POST /load` / `POST /predict` / `POST /shutdown`
- **主进程通信**：启动后 stdout 输出 `WORKER_READY:<port>`，主进程解析端口后 HTTP 调用

### 防重复机制

- **服务端**：`detector._detected_images` Set，key = `"image_name@conf"`
- **前端**：`detectedCache` Set + `AbortController` 取消进行中请求
- **强制重检**：手动点「识别」按钮传 `force=true`
- **换模型**：`detectedCache` / `_detected_images` 自动清空

### 环境要求

| 格式 | 需要 | 体积 |
|---|---|---|
| `.pt` | `pip install torch ultralytics` | ~2.5 GB |
| `.onnx` | `pip install onnxruntime` | ~30 MB |

---

## 参考章节：文件读写（标注结果保存/导出）

### 服务端读写 JSON（推荐，配合「保存」按钮）

```python
import json, os
LABEL_DIR = os.path.join(app.static_folder, "labels")

@app.route("/api/save", methods=["POST"])
def save_labels():
    data = request.get_json()            # { name, boxes }
    name = os.path.basename(data["name"])  # ⚠️ 必须清洗，防路径穿越
    os.makedirs(LABEL_DIR, exist_ok=True)
    with open(os.path.join(LABEL_DIR, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(data["boxes"], f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})
```

⚠️ 用户给的文件名拼路径前**必须 `os.path.basename()`**，否则 `../../etc/passwd` 之类能读写任意文件。

### 浏览器端导出（不走服务器）

```js
const blob = new Blob([JSON.stringify(boxes)], {type: "application/json"});
const a = document.createElement("a");
a.href = URL.createObjectURL(blob);
a.download = imageName + ".json";
a.click();
```

### 导出格式（待定）

- **JSON**：直接存 `currentBoxes`（比例坐标）
- **YOLO txt**：每行 `class_id cx cy w h`（归一化中心点格式，需从左上角转换）
- **COCO JSON**：含 `images` / `annotations` / `categories`

---

## 待办 / 已知遗留

- [ ] 批量识别全部图片（`POST /api/detect/batch` + 进度轮询）
- [ ] 撤销/重做栈（工具栏 undo/redo 按钮目前是装饰）
- [ ] 标注框的「双击改标签」「右键改类别」
- [ ] 推理 Worker 目前只支持单张推理，后续可加 batch 接口
- [ ] Material Symbols 字体（3.3MB）后续替换为子集 SVG，进一步缩短启动时间
- [ ] 根目录 `index.html`（旧版）、空文件 `test.py` 可清理
