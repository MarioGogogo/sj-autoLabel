# CLAUDE.md

本文件为 Claude Code（及开发者）在本仓库工作时的导航与约定。先读这里，再动代码。

## 项目简介

**视界标注专业版** —— 基于 Flask 的图像标注工作台，支持图片导入、AI 自动标注（规划中）、手动画框/编辑/删除、类别管理。当前为单页应用，三栏布局（左侧图片列表 / 中间画布 / 右侧模型与类别配置）。

## 技术栈

- **后端**：Flask 3.0.3，Python 3.14（见 `venv`）
- **图像处理**：Pillow 10.4.0（缩略图生成）
- **前端**：原生 HTML + Tailwind CSS（CDN）+ 原生 JS（无构建步骤、无框架）
- **字体/图标**：Inter / JetBrains Mono / Material Symbols（Google Fonts CDN）
- **持久化**：服务端文件系统 + Flask `session`（按浏览器会话隔离图片清单）

无数据库、无前端构建。改了文件直接刷新浏览器即可（开发期）。

## 目录结构

```
app.py                  Flask 入口：路由、上传、缩略图、session 管理
requirements.txt        Flask + Pillow
templates/
  index.html            主页面（三栏布局 + 所有对话框/右键菜单 DOM）
  _image_item.html      单张图片卡片（服务端首屏渲染，JS 动态插入时复用同结构）
static/
  css/style.css         全部样式（Tailwind 之外的自定义类）
  js/image_list.js      几乎所有前端逻辑（IIFE 单文件）
  uploads/              原图（运行时生成）
  thumbnails/           缩略图（运行时生成）
index.html              ⚠️ 遗留的旧版首页（27KB），已被 templates/index.html 取代，可删
test.py                 空文件，可删
venv/                   本地虚拟环境
```

## 常用命令

```bash
source venv/bin/activate          # 激活虚拟环境
python app.py                     # 开发服务器 http://127.0.0.1:5000
```

> macOS 上 5000 端口常被「AirPlay 接收器」占用。若启动报 `Address already in use`，关掉 AirPlay Receiver 或换端口：
> `app.app.run(port=5055)`（见 `__main__`，或临时 `FLASK_RUN_PORT=5055`）。

### 生产跑（多线程，避免批量推理时请求排队）

```bash
pip install waitress
waitress-serve --listen=127.0.0.1:5000 app:app
```

`debug=True` 是单线程 + 热重载，仅用于开发；量产务必用 waitress/gunicorn。

## 架构要点

### 数据流

- 图片上传 → 存 `static/uploads/<uuid>.<ext>`，生成缩略图到 `static/thumbnails/<uuid>.jpg`
- 每张图记录存入 `session["images"]`：`{id, name, url, thumb_url, size, status, created_at}`
- 前端通过 `/api/*` 接口读写；首屏由 Jinja 渲染已有图片，之后动态操作

### URL → 本地路径的转换（关键，多处复用）

`img["url"]` 形如 `/static/uploads/xxx.png`。转本地绝对路径：

```python
rel = url.lstrip("/").replace("static/", "", 1)
abs_path = os.path.join(app.static_folder, rel)
```

`app.py` 的 `_remove()`、未来 `/api/detect` 都用这个模式。

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

## 参考章节：接入 AI 模型（规划中）

> 当前画框是手动 + 演示数据（`genDemoBoxes(id)` 按图片 id 稳定生成假框）。
> 接真实模型时，按此章节落地。坐标系统已就绪，前端 `renderBoxes()` 直接收 0~1 比例框即可。

### 推理流程（端到端）

```
浏览器 → POST /api/detect/<image_id> → Flask 读图 → GPU 推理 → 返回 0~1 归一化框 → 前端 renderBoxes()
```

### 后端建议：`detector.py` + 两个接口

模型**全局只加载一次**，别每次请求 `torch.load`（重载一次几秒起步）。

```python
# detector.py
import torch
from PIL import Image

class Detector:
    def __init__(self):
        self.model = None
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.labels = ["行人", "车辆", "红绿灯", "犬只"]

    def load(self, model_path):
        # YOLO:  from ultralytics import YOLO; self.model = YOLO(model_path)
        self.model = torch.load(model_path, map_location=self.device)
        self.model.to(self.device).half()   # FP16 提速
        self.model.eval()

    def predict(self, image_path, conf=0.5):
        img = Image.open(image_path).convert("RGB")
        W, H = img.size
        results = []
        for box in raw_boxes:               # 按实际模型输出改写
            results.append({
                "label": self.labels[box.cls],
                "score": float(box.conf),
                "x": box.x / W, "y": box.y / H,   # 归一化（左上角）
                "w": box.w / W, "h": box.h / H,
            })
        return results

detector = Detector()
```

```python
# app.py 新增
from detector import detector

@app.route("/api/model/load", methods=["POST"])
def load_model():
    path = (request.get_json() or {}).get("path")
    try:
        detector.load(path); return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/detect/<image_id>", methods=["POST"])
def detect(image_id):
    if detector.model is None:
        return jsonify({"ok": False, "error": "模型未加载"}), 400
    img = next((i for i in _ensure_session_images() if i["id"] == image_id), None)
    if not img:
        return jsonify({"ok": False, "error": "图片不存在"}), 404
    rel = img["url"].lstrip("/").replace("static/", "", 1)
    abs_path = os.path.join(app.static_folder, rel)
    conf = (request.get_json() or {}).get("conf", 0.5)
    return jsonify({"ok": True, "boxes": detector.predict(abs_path, conf)})
```

### 前端：把演示框换成真框

替换 `genDemoBoxes` 的调用点为 `await detectCurrent()`：

```js
async function detectCurrent() {
    if (!selectedId) { showToast("请先选择图片"); return; }
    showToast("识别中…", 6000);
    try {
        const r = await fetch(`/api/detect/${selectedId}`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ conf: 0.5 }),
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error);
        currentBoxes = data.boxes.map((b, i) => ({
            id: `${selectedId}_det_${i}`,
            label: b.label,
            score: Math.round((b.score || 1) * 100),
            x: b.x, y: b.y, w: b.w, h: b.h,
            hex: hexOfLabel(b.label) || "#003d9b",
        }));
        selectedBoxId = null;
        renderBoxes();
        showToast(`识别完成：${data.boxes.length} 个目标`);
    } catch (e) { showToast("识别失败：" + e.message); }
}
```

### 性能（本地 RTX 5070）

单张端到端延迟主要由「读图+解码+CPU↔GPU 搬运+推理+NMS」相加，5070 上：

- YOLOv8n/v8s：单张 **5–15 ms**，体感「点哪框哪」
- YOLOv8m/x：**15–40 ms**，仍流畅
- 批量自动标注：**50–150 张/秒**（含 IO），几百张几秒跑完

**真正的瓶颈不在 GPU，在这几个坑**：

1. 模型重复加载 → 全局只 load 一次（见上）
2. Flask 单线程 + `debug=True` → 批量请求排队，用 waitress
3. 磁盘读图 + JPEG 解码（CPU 5–50ms，可能比推理还慢）→ 预解码/并发
4. CPU↔GPU 搬运 → `pin_memory`、FP16、批量推理摊薄

坐标格式务必在后端统一成「左上角 + 宽高 + 0~1 比例」：

| 模型输出 | 转换 |
|---|---|
| 像素 `[x1,y1,x2,y2]` | `x=x1/W, y=y1/H, w=(x2-x1)/W, h=(y2-y1)/H` |
| YOLO `[cx,cy,w,h]` 归一化 | `x=cx-w/2, y=cy-h/2` |

### 模型形式

- **ultralytics YOLO**：最省事，`model = YOLO("best.pt")` 自动用 GPU + FP16 + 自动 batch
- **自定义 PyTorch 网络**：按你的网络前处理/输出格式写 `predict`（如 `vgg16_detector.pt`）
- **ONNX Runtime**：不想装 PyTorch 时，`ort.InferenceSession` 部署轻量

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

- [ ] 接入真实模型，替换 `genDemoBoxes`（见上）
- [ ] 「保存」「导出」按钮目前无后端实现（见「文件读写」章节）
- [ ] 「自动标注」开关、置信度滑块尚未接线
- [ ] 撤销/重做栈（工具栏 undo/redo 按钮目前是装饰）
- [ ] 类别删除时，当前图片里该类别的框未联动清理（演示数据特性）
- [ ] 根目录 `index.html`（旧版）、空文件 `test.py` 可清理
- [ ] 标注框的「双击改标签」「右键改类别」未实现
