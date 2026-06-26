<div align="center">

# 🖼️ 视界标注专业版

**AutoLabels** — 桌面端图像标注工作台

打开本地文件夹 · 手动画框 · YOLO / ONNX 模型自动标注

[功能亮点](#-功能亮点) ·
[界面预览](#-界面预览) ·
[快速开始](#-快速开始) ·
[架构](#-架构设计) ·
[快捷键](#-快捷键)

</div>

---

## ✨ 功能亮点

- 📂 **打开本地文件夹** — 直接选择项目目录，原图 / 标注 / 类别全部读写于本地，零上传、零依赖云端。
- 🖱️ **精准画框** — 中空穿透架构，大框内可继续框选小目标；8 把手 + 4 边缘，拖拽缩放丝滑。
- 🤖 **自动标注** — 支持 YOLO（`.pt`）与 ONNX（`.onnx`），模型常驻内存，单张秒级推理。
- 🧩 **双推理模式** — 进程内推理 / Worker 子进程自动切换，外部 Python 环境也能用。
- 🎨 **任意颜色类别** — hex 驱动渲染，新增类别即时配色，告别调色板限制。
- 💾 **YOLO 格式保存** — 中心点归一化坐标，训练即取即用。
- 🖥️ **桌面秒开** — pywebview 包裹，本地字体 + 预编译样式，断网也能流畅工作。

---

## 🖼️ 界面预览

<div align="center">

![视界标注专业版](https://tutu.llove8.dpdns.org/api/rfile/标注助手.png)

*三栏布局：左侧图片列表 · 中间画布 · 右侧模型与类别配置*

</div>

---

## 🚀 快速开始

### 环境要求

- **Python 3.10+**（开发使用 3.14）
- **Node.js**（仅修改 Tailwind 样式时需要）
- Windows 用户需安装 [Edge WebView2 运行时](https://go.microsoft.com/fwlink/p/?LinkId=2124703)

### 安装与运行

```bash
# 1. 克隆仓库
git clone <repo-url>
cd AutoLabels

# 2. 创建并激活虚拟环境
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 3. 安装依赖
pip install -r requirements.txt

# 4. 启动（桌面窗口模式，默认）
python app.py

# 或浏览器模式
python app.py --browser
```

> 💡 macOS 上 5000 端口常被「AirPlay 接收器」占用。桌面模式会自动在 `5055~5074` 之间寻找空闲端口，无需手动处理。

### 启用 AI 自动标注（可选）

自动标注需要额外的推理运行时，二选一：

| 模型格式 | 安装命令 | 体积 |
|---|---|---|
| `.pt` (YOLO) | `pip install torch ultralytics` | ~2.5 GB |
| `.onnx` | `pip install onnxruntime` | ~30 MB |

- 若当前 venv 已安装上述任一，应用启动后会**自动启用进程内推理**。
- 否则可在应用右侧栏「推理环境」面板中配置外部 Python 路径，应用将通过 Worker 子进程调用。

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Flask 3.0.3 |
| 桌面壳 | pywebview 6.2.1（macOS: WKWebView / Windows: WebView2） |
| 图像处理 | Pillow 10.4.0 |
| 前端 | 原生 HTML + Tailwind CSS（预编译）+ 原生 JS（无框架） |
| 字体图标 | Inter / JetBrains Mono / Material Symbols（本地 woff2，零 CDN） |

---

## 🏗️ 架构设计

### 数据流

```
用户项目目录
├── images/          原图
├── labels/          YOLO txt 标注（中心点归一化格式）
├── classes.txt      类别列表
└── colors.json      类别颜色缓存

应用 ←→ 服务端文件系统（所有读写基于用户自选目录）
```

### 推理模式

```
┌─ 进程内模式：当前 venv 有 torch/ultralytics 或 onnxruntime
│    → detector.load() → detector.predict() 直接调用
│
└─ Worker 模式：当前 venv 无推理运行时，配置外部 Python 路径
     → 启动 worker.py 子进程（HTTP server，零额外依赖）
     → detector 通过 localhost 调用 Worker
     → 模型在 Worker 进程中只加载一次，常驻内存
```

### 目录结构

```
app.py              Flask 入口：路由 / 项目 / 模型加载 / 推理 API
detector.py         检测器模块：环境检测 + Worker 管理 + 进程内推理
worker.py           独立推理 Worker 子进程（stdlib only）
templates/          index.html 主页面 + _image_item.html 图片卡片
static/js/          image_list.js 全部前端逻辑（IIFE 单文件）
static/css/         Tailwind 预编译 + 自定义样式
```

---

## ⌨️ 快捷键

| 按键 | 功能 |
|:---:|---|
| `B` | 画框工具开关 |
| `Esc` | 关闭对话框 / 退出绘制 / 取消选中 |
| `Del` / `Backspace` | 删除选中框 |
| `←` `→` `↑` `↓` | 切换图片 |
| `Ctrl/Cmd` + `+/-/0` | 缩放 / 重置视图 |

---

## 📦 生产部署

开发模式（`debug=True`）为单线程 + 热重载，量产请使用多线程服务器：

```bash
pip install waitress
waitress-serve --listen=127.0.0.1:5000 app:app
```

---

## 📝 约定

- **坐标统一 0~1 归一化**：模型、保存、渲染均使用左上角 + 宽高的比例值。
- **颜色用 hex**：新增类别 / 渲染框一律 hex 内联 style。
- **文件名清洗**：用户输入的文件名拼路径前必须 `os.path.basename()`，防路径穿越。

---

<div align="center">

**Made with ❤️ for fast, local-first image annotation**

</div>
