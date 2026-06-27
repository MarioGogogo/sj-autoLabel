"""视界标注专业版 | AI 自动标注 —— Flask 应用入口。

工作模式：打开本地文件夹作为项目根，就地读写 images/ labels/ classes.txt colors.json。
（类 LabelImg 桌面工具工作流，非浏览器上传。）

运行方式：
    pip install -r requirements.txt
    python app.py
然后在浏览器打开 http://127.0.0.1:5000
"""

import json
import os
import platform
import queue

# PyTorch/MKL 在 Windows + conda 环境常出现 OpenMP 运行时冲突（libiomp5md.dll 重复初始化），
# 导致 import torch 时 OMP Error #15 直接 abort 进程。设此变量放行（须在任何 torch import 之前；
# 同时会随 os.environ 传给 Worker 子进程）。
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
import re
import string

from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    send_from_directory,
    stream_with_context,
)

import threading
from detector import check_environment, detector, read_config, write_config
from train_manager import train_manager

app = Flask(__name__)
app.secret_key = "dev-secret-autolabels"

# 启动时跑一次环境检测（结果缓存）
_env_result = check_environment()

# 从配置恢复推理 Worker：pythonPath 已持久化到 config.json，但 detector 的运行时状态
# （_worker_python）是内存态，重启即丢。此处重建，使 YOLO/SAM 推理继续走外部 Worker
# （Worker 子进程在首次推理时懒启动，此处不启动子进程，无开销）。
_startup_cfg = read_config()
_restored_python = _startup_cfg.get("pythonPath", "")
if _restored_python and os.path.isfile(_restored_python):
    try:
        detector.configure_worker(_restored_python)
    except Exception as _e:
        print(f"⚠️ 恢复推理环境失败：{_e}")

# app 退出时关闭 Worker 子进程，避免残留进程占用端口与显存
import atexit
atexit.register(detector._stop_worker)
atexit.register(train_manager.shutdown)

ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
THUMB_MAX_SIZE = 160  # 缩略图最长边（备用，当前不生成）

# ===== 当前打开的项目根（模块级全局；单用户本地工具） =====
# 由 POST /api/project/open 设置。所有读写都基于此路径就地完成。
ACTIVE_PROJECT = None


# ===================== 路径派生（基于 ACTIVE_PROJECT） =====================

def _images_dir():
    return os.path.join(ACTIVE_PROJECT, "images")


def _labels_dir():
    return os.path.join(ACTIVE_PROJECT, "labels")


def _thumbs_dir():
    return os.path.join(ACTIVE_PROJECT, ".thumbnails")


def _classes_file():
    return os.path.join(ACTIVE_PROJECT, "classes.txt")


def _colors_file():
    return os.path.join(ACTIVE_PROJECT, "分类颜色缓存.json")


# ===================== 类别与标注文件读写 =====================

def _read_classes():
    """读取 classes.txt，返回类名列表（行号 = class_id）。文件不存在返回空列表。"""
    if not ACTIVE_PROJECT or not os.path.exists(_classes_file()):
        return []
    for enc in ("utf-8-sig", "gbk", "utf-8"):
        try:
            with open(_classes_file(), "r", encoding=enc) as f:
                return [line.rstrip("\n") for line in f if line.strip()]
        except (UnicodeDecodeError, LookupError):
            continue
    return []


def _write_classes(names):
    """覆盖写入 classes.txt，每行一个类名。"""
    with open(_classes_file(), "w", encoding="utf-8") as f:
        if names:
            f.write("\n".join(names) + "\n")


def _count_labels():
    """扫描 labels/ 下所有 txt，返回 {类名: 框数} 全项目统计。"""
    counts = {}
    if not ACTIVE_PROJECT:
        return counts
    labels_dir = _labels_dir()
    if not os.path.isdir(labels_dir):
        return counts
    names = _read_classes()
    for fn in os.listdir(labels_dir):
        if not fn.endswith(".txt"):
            continue
        try:
            with open(os.path.join(labels_dir, fn), "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.split()
                    if parts and parts[0].isdigit():
                        cid = int(parts[0])
                        if 0 <= cid < len(names):
                            label = names[cid]
                            counts[label] = counts.get(label, 0) + 1
        except OSError:
            pass
    return counts


def _read_colors():
    """读取 colors.json，返回 {类名: hex}。损坏/不存在返回空 dict。"""
    if not ACTIVE_PROJECT or not os.path.exists(_colors_file()):
        return {}
    try:
        with open(_colors_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_colors(mapping):
    """覆盖写入 colors.json。"""
    with open(_colors_file(), "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)


def _safe_label_stem(original_name):
    """文件名 → 安全的 txt 主干（去扩展名 + 替换危险字符 + basename 兜底防穿越）。"""
    stem = os.path.splitext(original_name)[0]
    stem = re.sub(r'[\\/:*?"<>|]+', "_", stem)
    stem = stem.lstrip(". ")
    return os.path.basename(stem) or "unnamed"


def _label_txt_path(image_name):
    """标注 txt 路径：labels/<安全主干>.txt。"""
    return os.path.join(_labels_dir(), _safe_label_stem(image_name) + ".txt")


def _clamp01(v):
    return max(0.0, min(1.0, v))


def _make_thumbnail(src_path, dst_path):
    """生成缩略图到 .thumbnails/，160px 最长边 JPEG。返回 True/False。"""
    try:
        from PIL import Image

        with Image.open(src_path) as im:
            im.thumbnail((THUMB_MAX_SIZE, THUMB_MAX_SIZE))
            if im.mode in ("RGBA", "P"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.convert("RGBA").split()[-1])
                im = bg
            else:
                im = im.convert("RGB")
            im.save(dst_path, "JPEG", quality=80, optimize=True)
        return True
    except Exception:
        return False


def _scan_images():
    """扫描 images/ 生成图片清单。record = {name, has_label, status, url, size}。"""
    images = []
    img_dir = _images_dir()
    if not os.path.isdir(img_dir):
        return images
    for name in sorted(os.listdir(img_dir)):
        if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
            continue
        full = os.path.join(img_dir, name)
        if not os.path.isfile(full):
            continue
        stem = _safe_label_stem(name)
        has_label = os.path.exists(os.path.join(_labels_dir(), stem + ".txt"))
        try:
            size = os.path.getsize(full)
        except OSError:
            size = 0
        images.append({
            "name": name,
            "has_label": has_label,
            "status": "done" if has_label else "pending",
            "url": f"/api/project/image/{name}",
            "thumb_url": f"/api/project/thumb/{name}",
            "size": size,
        })
    # 清理孤儿缩略图（images/ 里已删的图）。
    _cleanup_orphan_thumbs({img["name"] for img in images})
    return images


def _cleanup_orphan_thumbs(valid_names):
    """删除 .thumbnails/ 中没有对应原图的缩略图。"""
    thumbs_dir = _thumbs_dir()
    if not os.path.isdir(thumbs_dir):
        return
    # 有效缩略图主干集合：image.png/ext1 + image.jpeg/ext2 → 都对应 image.jpg
    valid_stems = {os.path.splitext(n)[0] for n in valid_names}
    for fn in os.listdir(thumbs_dir):
        if not fn.lower().endswith(".jpg"):
            continue
        stem = os.path.splitext(fn)[0]
        if stem not in valid_stems:
            try:
                os.remove(os.path.join(thumbs_dir, fn))
            except OSError:
                pass


# ===================== 页面 =====================

@app.route("/")
def index():
    """主界面：标注工作台（空壳，图片由前端打开项目后渲染）。"""
    return render_template("index.html")


# ===================== 项目：浏览 / 打开 / 状态 / 刷新 =====================

def _list_roots():
    """跨平台根入口：Windows 探测存在的盘符；mac/linux 列根目录 + 家目录置顶。"""
    if platform.system() == "Windows":
        return [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]
    home = os.path.expanduser("~")
    entries = []
    try:
        for name in os.listdir("/"):
            full = os.path.join("/", name)
            if os.path.isdir(full):
                entries.append(full)
    except OSError:
        pass
    if home not in entries:
        entries.insert(0, home)
    return entries


@app.route("/api/browse")
def api_browse():
    """目录浏览：返回子目录；传 ?files=.pt,.onnx 时同时返回匹配的文件。path 为空返回根入口。"""
    raw = (request.args.get("path") or "").strip()
    file_exts = (request.args.get("files") or "").strip()
    if not raw:
        roots = _list_roots()
        return jsonify({"ok": True, "current": "", "parent": None, "dirs": [{"name": r, "path": r} for r in roots]})
    if not os.path.isdir(raw):
        return jsonify({"ok": False, "error": "路径不存在或不是目录"}), 400

    current = os.path.realpath(raw)
    dirs = []
    files = []
    allowed_files = set()
    if file_exts:
        allowed_files = {e.strip().lower() for e in file_exts.split(",") if e.strip()}
    try:
        for name in sorted(os.listdir(current)):
            full = os.path.join(current, name)
            if os.path.isdir(full):
                dirs.append({"name": name, "path": full})
            elif allowed_files and os.path.isfile(full):
                ext = os.path.splitext(name)[1].lower()
                if ext in allowed_files:
                    try:
                        fsize = os.path.getsize(full)
                    except OSError:
                        fsize = 0
                    files.append({"name": name, "path": full, "size": fsize, "ext": ext})
    except (OSError, PermissionError):
        pass

    parent = os.path.dirname(current)
    # 根盘符/根目录时 parent 为空或与自身相同 → null（无法再上钻）
    if not parent or os.path.realpath(parent) == current:
        parent = None
    return jsonify({"ok": True, "current": current, "parent": parent, "dirs": dirs, "files": files})


# ===================== 模型加载 =====================

# 当前已加载的模型信息（模块级；单用户本地工具）
LOADED_MODEL = {"path": None, "name": None, "format": None, "loaded_at": None}

MODEL_EXTENSIONS = {".pt", ".onnx"}

# 当前已加载的 SAM 2 模型信息（独立于 YOLO 的 LOADED_MODEL，两者可并存）
LOADED_SAM = {"variant": None, "loaded_at": None}


@app.route("/api/model/load", methods=["POST"])
def api_model_load():
    """加载模型：校验文件存在 + 格式支持，记录路径（实际加载由 detector 完成）。"""
    global LOADED_MODEL
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()

    if not path:
        return jsonify({"ok": False, "error": "请指定模型文件路径"}), 400
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "模型文件不存在"}), 404

    ext = os.path.splitext(path)[1].lower()
    if ext not in MODEL_EXTENSIONS:
        return jsonify({
            "ok": False,
            "error": f"不支持的模型格式：{ext}。支持：{', '.join(sorted(MODEL_EXTENSIONS))}"
        }), 400

    import datetime

    # 真正加载到 detector（首次耗时较长，后续切换模型时重载）。
    try:
        detector.load(path)
    except Exception as e:
        return jsonify({"ok": False, "error": f"模型加载失败：{e}"}), 500

    name = os.path.basename(path)
    real_path = os.path.realpath(path)
    LOADED_MODEL = {
        "path": real_path,
        "name": name,
        "format": ext,
        "loaded_at": datetime.datetime.now().isoformat(),
    }

    # 缓存模型路径到配置，下次启动自动预填
    cfg = read_config()
    cfg["lastModelPath"] = real_path
    write_config(cfg)
    return jsonify({
        "ok": True,
        "model": LOADED_MODEL,
        "device": detector.device,
        "labels": detector.labels[:20] if detector.labels else [],
    })


@app.route("/api/model/status")
def api_model_status():
    """返回当前已加载模型的状态。"""
    loaded = LOADED_MODEL["path"] is not None and detector.is_loaded
    return jsonify({
        "ok": True,
        "loaded": loaded,
        "model": LOADED_MODEL if LOADED_MODEL["path"] else None,
        "device": detector.device if loaded else None,
        "labels": detector.labels[:20] if loaded else [],
    })


# ===================== 环境检测 + 配置 =====================

@app.route("/api/env/check")
def api_env_check():
    """检测当前 Python 环境可运行哪些模型格式，含外部环境扫描和当前配置。"""
    env = check_environment()
    cfg = read_config()
    return jsonify({
        "ok": True,
        **env,
        "config": {
            "pythonPath": cfg.get("pythonPath", ""),
            "hasWorker": bool(cfg.get("pythonPath") and detector._use_worker),
        },
    })


@app.route("/api/env/config", methods=["GET"])
def api_env_config_get():
    """读取推理环境配置。"""
    cfg = read_config()
    return jsonify({
        "ok": True,
        "pythonPath": cfg.get("pythonPath", ""),
        "hasWorker": bool(cfg.get("pythonPath") and detector._use_worker),
    })


@app.route("/api/env/config", methods=["POST"])
def api_env_config_save():
    """保存推理环境配置（pythonPath + 重启 worker）。"""
    data = request.get_json(silent=True) or {}
    python_path = (data.get("pythonPath") or "").strip()

    cfg = read_config()
    if python_path:
        # 探测该 Python 是否有可用运行时
        from detector import _probe_python

        info = _probe_python(python_path)
        if not info:
            return jsonify({
                "ok": False,
                "error": f"该 Python 环境中未检测到 PyTorch 或 ONNX Runtime。\n\n路径：{python_path}\n\n请在该环境执行：pip install torch ultralytics",
            }), 400

        # 验证通过，写入配置
        cfg["pythonPath"] = python_path
        write_config(cfg)

        # 配置 detector 并启动 worker
        try:
            detector.configure_worker(python_path)
            if LOADED_MODEL.get("path") and os.path.isfile(LOADED_MODEL["path"]):
                # 已有模型路径，让 worker 加载
                detector.load(LOADED_MODEL["path"])
        except Exception as e:
            return jsonify({"ok": False, "error": f"Worker 启动失败：{e}"}), 500

        return jsonify({
            "ok": True,
            "pythonPath": python_path,
            "runtime": {
                "torch": info.get("torch"),
                "ultralytics": info.get("ultralytics"),
                "onnxruntime": info.get("onnxruntime"),
                "sam2": info.get("sam2"),
            },
        })
    else:
        # 清空配置 → 回退到进程内模式
        cfg.pop("pythonPath", None)
        write_config(cfg)
        detector.configure_worker("")
        return jsonify({"ok": True, "pythonPath": "", "message": "已切换回进程内推理模式"})

@app.route("/api/detect/<path:image_name>", methods=["POST"])
def api_detect(image_name):
    """对当前项目中的单张图片执行目标检测。首次调用自动懒加载模型。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    if not detector.is_loaded:
        # 懒加载：尝试用已记录路径加载
        if LOADED_MODEL.get("path") and os.path.isfile(LOADED_MODEL["path"]):
            try:
                detector.load(LOADED_MODEL["path"])
            except Exception as e:
                return jsonify({"ok": False, "error": f"模型加载失败：{e}"}), 500
        else:
            return jsonify({"ok": False, "error": "模型未加载，请先在侧栏加载模型文件"}), 400

    safe = os.path.basename(image_name)
    img_path = os.path.join(_images_dir(), safe)
    if not os.path.isfile(img_path):
        return jsonify({"ok": False, "error": "图片不存在"}), 404

    data = request.get_json(silent=True) or {}
    conf = max(0.0, min(1.0, float(data.get("conf", 0.5))))
    force = bool(data.get("force", False))

    # 从 colors 配置拿已有颜色映射，传给前端时直接带 hex
    colors = _read_colors()

    try:
        t0 = __import__("time").time()
        raw_boxes, cached = detector.predict(img_path, safe, conf=conf, force=force)
        elapsed = round((__import__("time").time() - t0) * 1000)  # ms
    except Exception as e:
        return jsonify({"ok": False, "error": f"推理失败：{e}"}), 500

    # 补充 hex 颜色（匹配已有类别，无则默认色）
    for b in raw_boxes:
        b.setdefault("score", 100)
        b.setdefault("hex", colors.get(b.get("label", ""), "#003d9b"))

    return jsonify({
        "ok": True,
        "boxes": raw_boxes,
        "cached": cached,
        "elapsed_ms": elapsed,
        "device": detector.device,
    })


# ===================== SAM 2 分割（独立引擎，与 YOLO 并列） =====================

@app.route("/api/sam/load", methods=["POST"])
def api_sam_load():
    """加载 SAM 2 分割模型。variant: large/base_plus/small/tiny；
    checkpoint 可选本地 .pt（离线），留空则 from_pretrained 自动下载。"""
    global LOADED_SAM
    data = request.get_json(silent=True) or {}
    variant = (data.get("variant") or "large").strip()
    checkpoint = (data.get("checkpoint") or "").strip()
    try:
        detector.load_sam(variant, checkpoint)
    except Exception as e:
        return jsonify({"ok": False, "error": f"SAM 加载失败：{e}"}), 500

    import datetime
    LOADED_SAM = {
        "variant": detector.sam_variant,
        "loaded_at": datetime.datetime.now().isoformat(),
    }
    # 缓存变体到配置，下次启动可预填
    cfg = read_config()
    cfg["lastSamVariant"] = detector.sam_variant
    write_config(cfg)
    return jsonify({
        "ok": True,
        "variant": detector.sam_variant,
        "device": detector.sam_device,
    })


@app.route("/api/sam/predict", methods=["POST"])
def api_sam_predict():
    """对当前项目图片用点提示做 SAM 2 分割，返回外接框（可能为 None）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    if not detector.sam_is_loaded:
        return jsonify({"ok": False, "error": "SAM 模型未加载，请先在侧栏加载"}), 400

    data = request.get_json(silent=True) or {}
    safe = os.path.basename(data.get("image_name", ""))  # 防路径穿越
    img_path = os.path.join(_images_dir(), safe)
    if not os.path.isfile(img_path):
        return jsonify({"ok": False, "error": "图片不存在"}), 404

    points = data.get("points", [])  # [[nx, ny], ...] 归一化 0~1
    labels = data.get("labels", [1] * len(points))
    if not points:
        return jsonify({"ok": False, "error": "未提供分割点"}), 400

    # 归一化点 → 像素坐标（坐标转换在后端做，沿用既有约定）
    from PIL import Image
    W, H = Image.open(img_path).size
    px_points = [[float(x) * W, float(y) * H] for x, y in points]

    try:
        t0 = __import__("time").time()
        box = detector.segment(img_path, px_points, labels)
        elapsed = round((__import__("time").time() - t0) * 1000)
    except Exception as e:
        return jsonify({"ok": False, "error": f"分割失败：{e}"}), 500

    return jsonify({
        "ok": True,
        "box": box,  # None 表示未分割出目标
        "elapsed_ms": elapsed,
        "device": detector.device,
    })


@app.route("/api/sam/unload", methods=["POST"])
def api_sam_unload():
    """卸载 SAM 模型，释放显存（不影响 YOLO）。"""
    try:
        detector.unload_sam()
    except Exception as e:
        return jsonify({"ok": False, "error": f"SAM 卸载失败：{e}"}), 500
    return jsonify({"ok": True})


@app.route("/api/project/open", methods=["POST"])
def api_project_open():
    """打开/初始化项目：检测老/新，设 ACTIVE_PROJECT，返回图片清单+类别+颜色。"""
    global ACTIVE_PROJECT
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path or not os.path.isdir(path):
        return jsonify({"ok": False, "error": "路径不存在或不是目录"}), 400

    path = os.path.realpath(path)
    ACTIVE_PROJECT = path

    # 缓存项目路径到配置，下次启动自动恢复
    cfg = read_config()
    cfg["lastProjectPath"] = path
    write_config(cfg)

    images_exists = os.path.isdir(_images_dir())
    labels_exists = os.path.isdir(_labels_dir())
    is_new = not (images_exists or labels_exists)

    # 补建缺失目录/文件（新旧项目都走这个逻辑，不覆写已有文件）。
    os.makedirs(_images_dir(), exist_ok=True)
    os.makedirs(_labels_dir(), exist_ok=True)
    if not os.path.exists(_classes_file()):
        open(_classes_file(), "w", encoding="utf-8").close()
    if not os.path.exists(_colors_file()):
        with open(_colors_file(), "w", encoding="utf-8") as f:
            json.dump({}, f)

    names = _read_classes()
    colors = _read_colors()
    categories = [
        {"label": n, "hex": colors.get(n, "#003d9b"), "id": i}
        for i, n in enumerate(names)
    ]
    return jsonify({
        "ok": True,
        "isNew": is_new,
        "projectPath": path,
        "images": _scan_images(),
        "categories": categories,
        "colors": colors,
    })


@app.route("/api/project/status")
def api_project_status():
    """页面刷新恢复：是否已打开项目 + 缓存的项目路径和模型路径。"""
    cfg = read_config()
    last_project = cfg.get("lastProjectPath", "")
    last_model = cfg.get("lastModelPath", "")
    if not ACTIVE_PROJECT:
        return jsonify({"ok": True, "opened": False, "lastProjectPath": last_project, "lastModelPath": last_model})
    return jsonify({"ok": True, "opened": True, "projectPath": ACTIVE_PROJECT, "lastProjectPath": last_project, "lastModelPath": last_model})


@app.route("/api/project/refresh")
def api_project_refresh():
    """重扫 images/（用户在外部增删图后）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    return jsonify({"ok": True, "images": _scan_images()})


@app.route("/api/project/stats")
def api_project_stats():
    """全项目类别统计：扫描 labels/ 下所有 txt 汇总每类框数。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    return jsonify({"ok": True, "categoryCounts": _count_labels()})


@app.route("/api/project/image/<path:filename>")
def api_project_image(filename):
    """按文件名读图返回（send_from_directory + basename 双重防穿越）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    safe = os.path.basename(filename)
    img_dir = _images_dir()
    if not os.path.exists(os.path.join(img_dir, safe)):
        return jsonify({"ok": False, "error": "图片不存在"}), 404
    return send_from_directory(img_dir, safe)


@app.route("/api/project/thumb/<path:filename>")
def api_project_thumb(filename):
    """按文件名返回缩略图（160px 最长边，按需生成并缓存到 .thumbnails/）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    safe = os.path.basename(filename)
    src = os.path.join(_images_dir(), safe)
    if not os.path.isfile(src):
        return jsonify({"ok": False, "error": "图片不存在"}), 404

    thumbs_dir = _thumbs_dir()
    os.makedirs(thumbs_dir, exist_ok=True)
    thumb_name = os.path.splitext(safe)[0] + ".jpg"
    dst = os.path.join(thumbs_dir, thumb_name)

    # 缩略图不存在或比原图旧 → 重新生成。
    try:
        need_gen = not os.path.isfile(dst) or os.path.getmtime(src) > os.path.getmtime(dst)
    except OSError:
        need_gen = True
    if need_gen:
        if not _make_thumbnail(src, dst):
            # 生成失败，回退到原图。
            return send_from_directory(_images_dir(), safe)

    return send_from_directory(thumbs_dir, thumb_name)


# ===================== 类别（classes.txt + colors.json）=====================

@app.route("/api/classes")
def api_get_classes():
    """返回全部类别：[{label, hex, id}]，id = classes.txt 行号（class_id）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": True, "categories": []})
    names = _read_classes()
    colors = _read_colors()
    categories = [
        {"label": n, "hex": colors.get(n, "#003d9b"), "id": i}
        for i, n in enumerate(names)
    ]
    return jsonify({"ok": True, "categories": categories})


@app.route("/api/classes", methods=["POST"])
def api_add_class():
    """新增类别：追加到 classes.txt 末尾 + 更新 colors.json。返回新 class_id。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    data = request.get_json(silent=True) or {}
    label = (data.get("label") or "").strip()
    hex_color = (data.get("hex") or "").strip()
    if not label:
        return jsonify({"ok": False, "error": "类别名不能为空"}), 400
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", hex_color):
        return jsonify({"ok": False, "error": "颜色格式非法"}), 400

    names = _read_classes()
    if label in names:
        return jsonify({"ok": False, "error": "类别已存在"}), 409

    names.append(label)
    _write_classes(names)
    colors = _read_colors()
    colors[label] = hex_color
    _write_colors(colors)
    return jsonify({"ok": True, "id": len(names) - 1, "category": {"label": label, "hex": hex_color}})


@app.route("/api/classes/<path:label>", methods=["DELETE"])
def api_delete_class(label):
    """删除类别。被使用且未 force=1 → 409；force=1 重写所有 txt（被删行丢弃，>idx 减 1）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    names = _read_classes()
    if label not in names:
        return jsonify({"ok": False, "error": "类别不存在"}), 404
    idx = names.index(label)
    force = request.args.get("force", "0") == "1"

    labels_dir = _labels_dir()
    used_files = 0
    if os.path.isdir(labels_dir):
        for fn in os.listdir(labels_dir):
            if not fn.endswith(".txt"):
                continue
            try:
                with open(os.path.join(labels_dir, fn), "r", encoding="utf-8") as f:
                    for line in f:
                        parts = line.split()
                        if parts and parts[0].isdigit() and int(parts[0]) == idx:
                            used_files += 1
                            break
            except OSError:
                pass

    if used_files and not force:
        return jsonify({
            "ok": False,
            "error": f"类别「{label}」已用于 {used_files} 个标注文件，删除将重写它们并丢弃该类别的框。",
            "in_use": True,
            "count": used_files,
        }), 409

    names.pop(idx)
    _write_classes(names)
    colors = _read_colors()
    colors.pop(label, None)
    _write_colors(colors)

    if os.path.isdir(labels_dir):
        for fn in list(os.listdir(labels_dir)):
            if not fn.endswith(".txt"):
                continue
            path = os.path.join(labels_dir, fn)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            except OSError:
                continue
            new_lines = []
            for line in lines:
                parts = line.split()
                if not parts or not parts[0].isdigit():
                    continue
                cid = int(parts[0])
                if cid == idx:
                    continue
                if cid > idx:
                    cid -= 1
                new_lines.append(f"{cid} {' '.join(parts[1:])}\n")
            if new_lines:
                with open(path, "w", encoding="utf-8") as f:
                    f.writelines(new_lines)
            else:
                os.remove(path)

    return jsonify({"ok": True, "total": len(names)})


# ===================== 单图标注（YOLO txt）=====================
# 前端坐标：左上角 + 宽高（0~1）。YOLO：中心点 + 宽高（0~1）。

@app.route("/api/labels/<path:image_name>", methods=["PUT"])
def api_save_labels(image_name):
    """保存某图标注为 labels/<同名>.txt（YOLO 中心点格式）。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    txt_path = _label_txt_path(image_name)
    data = request.get_json(silent=True) or {}
    boxes = data.get("boxes") or []
    names = _read_classes()

    if not boxes:
        try:
            if os.path.exists(txt_path):
                os.remove(txt_path)
        except OSError:
            pass
        return jsonify({"ok": True, "count": 0})

    lines = []
    for b in boxes:
        # 确定 class_id 的规则（从不追加新类别到 classes.txt）：
        #   1. class_id 合法且在范围内 → 直接用
        #   2. class_id 不合法但 label 匹配已有类别 → 用该类别索引
        #   3. 都不行 → 默认 index 0
        cid = b.get("class_id")
        if cid is None or not isinstance(cid, int) or cid < 0 or cid >= len(names):
            label = b.get("label", "")
            if label in names:
                cid = names.index(label)
            else:
                cid = 0
        x = _clamp01(float(b.get("x", 0)))
        y = _clamp01(float(b.get("y", 0)))
        w = _clamp01(float(b.get("w", 0)))
        h = _clamp01(float(b.get("h", 0)))
        cx = _clamp01(x + w / 2)
        cy = _clamp01(y + h / 2)
        lines.append(f"{cid} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return jsonify({"ok": True, "count": len(lines)})


@app.route("/api/labels/<path:image_name>")
def api_load_labels(image_name):
    """加载某图标注（读 txt，转回前端左上角格式）。txt 不存在返回空。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    txt_path = _label_txt_path(image_name)
    if not os.path.exists(txt_path):
        return jsonify({"ok": True, "boxes": []})

    names = _read_classes()
    colors = _read_colors()
    boxes = []
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 5:
                    continue
                try:
                    cid = int(parts[0])
                    cx, cy, w, h = (float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4]))
                except ValueError:
                    continue
                if cid < 0 or cid >= len(names):
                    continue
                label = names[cid]
                boxes.append({
                    "label": label,
                    "class_id": cid,
                    "score": 100,
                    "x": _clamp01(cx - w / 2),
                    "y": _clamp01(cy - h / 2),
                    "w": _clamp01(w),
                    "h": _clamp01(h),
                    "hex": colors.get(label, "#003d9b"),
                })
    except OSError:
        return jsonify({"ok": True, "boxes": []})
    return jsonify({"ok": True, "boxes": boxes})


# ===================== 模型训练 =====================

# 训练环境扫描缓存 + 锁（懒加载：首次进训练页时同步扫描，后续缓存秒开）
_TRAIN_ENV_CACHE = None
_TRAIN_ENV_LOCK = threading.Lock()


@app.route("/api/train/env")
def api_train_env():
    """返回已配置的训练 Python 环境路径与元数据。"""
    cfg = read_config()
    selected = cfg.get("trainPythonPath", "")
    envs = []
    cuda_ver = "13.3"
    env_name = ""
    env_path = ""
    if selected and os.path.isfile(selected):
        env_path = os.path.dirname(selected)
        env_name = os.path.basename(env_path) or "custom"
        from detector import _probe_python
        info = _probe_python(selected) or {}
        cuda_ver = info.get("cuda") or "13.3"
        envs.append({
            "name": env_name,
            "python": selected,
            "ultralytics": "已保存",
            "torch": "已保存",
        })
    return jsonify({
        "ok": True,
        "envs": envs,
        "selected": selected,
        "cudaVersion": cuda_ver,
        "envName": env_name,
        "envPath": env_path,
    })


@app.route("/api/train/env/save", methods=["POST"])
def api_train_env_save():
    """保存手动输入的训练 Python 路径。单次探测 ultralytics，写入配置。"""
    data = request.get_json(silent=True) or {}
    python_path = (data.get("pythonPath") or "").strip()

    if not python_path:
        return jsonify({"ok": False, "error": "请输入 Python 路径"}), 400
    if not os.path.isfile(python_path):
        return jsonify({"ok": False, "error": f"文件不存在：{python_path}"}), 400

    # 持久化训练环境选择
    cfg = read_config()
    cfg["trainPythonPath"] = python_path
    write_config(cfg)

    env_path = os.path.dirname(python_path)
    env_name = os.path.basename(env_path) or "custom"
    cuda_ver = "13.3"

    return jsonify({
        "ok": True,
        "pythonPath": python_path,
        "name": env_name,
        "envPath": env_path,
        "cudaVersion": cuda_ver,
        "runtime": {
            "torch": "已准备",
            "ultralytics": "已准备",
        },
    })


@app.route("/api/train/start", methods=["POST"])
def api_train_start():
    """启动训练：校验项目/环境 → 生成 data.yaml → 合并参数 → spawn 训练子进程。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先在顶部打开一个项目"}), 400

    data = request.get_json(silent=True) or {}

    # 训练环境（独立于推理环境；默认 yolo 虚拟环境，由前端下拉选择）
    python_path = (data.get("trainPythonPath") or "").strip()
    if not python_path:
        python_path = (read_config().get("trainPythonPath") or "").strip()
    if not python_path or not os.path.isfile(python_path):
        return jsonify({
            "ok": False,
            "error": "未选择训练环境。请在右侧「训练环境」下拉中选择一个含 ultralytics 的环境（如 yolo）",
        }), 400

    # 持久化训练环境选择，下次默认用它
    cfg = read_config()
    cfg["trainPythonPath"] = python_path
    write_config(cfg)

    # 实验名校验（防路径穿越/特殊字符）
    name = str(data.get("name") or "exp").strip() or "exp"
    if not re.match(r"^[A-Za-z0-9_\-.]+$", name):
        return jsonify({"ok": False, "error": "实验名只能包含字母、数字、下划线、连字符、点"}), 400

    # 基础数值参数
    try:
        epochs = int(data.get("epochs", 50))
        imgsz = int(data.get("imgsz", 640))
        workers = int(data.get("workers", 8))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "epochs / imgsz / workers 必须是整数"}), 400

    batch_raw = str(data.get("batch", 16)).strip()
    if batch_raw.lower() == "auto":
        batch = "auto"
    else:
        try:
            batch = int(batch_raw)
        except ValueError:
            batch = 16

    device = str(data.get("device") or "cpu").strip()
    model = str(data.get("model") or "yolo11n.pt").strip()
    export_onnx = bool(data.get("exportOnnx", False))

    try:
        val_ratio = float(data.get("valRatio", 0.2))
        val_ratio = max(0.05, min(0.5, val_ratio))
    except (TypeError, ValueError):
        val_ratio = 0.2

    params = {
        "model": model,
        "epochs": epochs,
        "imgsz": imgsz,
        "batch": batch,
        "device": device,
        "workers": workers,
        "name": name,
        "valRatio": val_ratio,
        "exportOnnx": export_onnx,
        "customParamsText": str(data.get("customParamsText") or ""),
        "customParamsYaml": str(data.get("customParamsYaml") or ""),
    }

    try:
        result = train_manager.start(ACTIVE_PROJECT, params, python_path)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "dataYaml": result["dataYaml"]})


@app.route("/api/train/status")
def api_train_status():
    """查询训练状态机：idle / running / done / error / cancelled。"""
    return jsonify({"ok": True, **train_manager.status()})


@app.route("/api/train/stop", methods=["POST"])
def api_train_stop():
    """停止正在运行的训练（terminate → kill）。"""
    result = train_manager.stop()
    if not result.get("ok"):
        return jsonify(result), 400
    return jsonify(result)


@app.route("/api/train/logs")
def api_train_logs():
    """SSE：实时推送训练日志到前端 xterm。每连接独立队列，请求线程不阻塞读子进程。"""
    q = train_manager.subscribe()  # 已注入历史日志回放

    def gen():
        try:
            while True:
                try:
                    text = q.get(timeout=15)
                except queue.Empty:
                    yield ": heartbeat\n\n"  # 心跳，防代理/WebView 连接超时
                    continue
                yield f"data: {json.dumps(text, ensure_ascii=False)}\n\n"
        finally:
            train_manager.unsubscribe(q)

    return Response(
        stream_with_context(gen),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/train/logs_poll")
def api_train_logs_poll():
    """高频轮询：根据游标 cursor 极速拉取增量训练日志，完美解决 WebView2 中 SSE 连接死锁问题。"""
    try:
        cursor = int(request.args.get("cursor", 0))
    except ValueError:
        cursor = 0
    text, new_cursor = train_manager.get_logs_after(cursor)
    return jsonify({"ok": True, "text": text, "cursor": new_cursor})


@app.route("/api/train/export", methods=["POST"])
def api_train_export():
    """把训练产物（best.pt 及可选 onnx）复制到项目内 models/，供「智能标注」阶段加载。"""
    if not ACTIVE_PROJECT:
        return jsonify({"ok": False, "error": "请先打开项目"}), 400
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "请指定实验名"}), 400
    try:
        result = train_manager.export_artifacts(ACTIVE_PROJECT, name)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 404
    return jsonify({"ok": True, **result})


# ===================== 桌面模式（pywebview） =====================

def _pick_free_port(start=5055, tries=20):
    """在 start ~ start+tries 范围找一个空闲端口。"""
    import socket

    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start


def _run_desktop():
    """以桌面窗口模式启动（pywebview + 系统 WebView，无外部浏览器）。"""
    import threading
    import sys
    import time

    try:
        import webview
    except ImportError:
        print("pywebview 未安装。请运行: pip install pywebview")
        print("回退到浏览器模式…")
        app.run(debug=True, threaded=True)
        return

    port = _pick_free_port()
    url = f"http://127.0.0.1:{port}"

    def flask_thread():
        app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False, threaded=True)

    t = threading.Thread(target=flask_thread, daemon=True)
    t.start()

    # 等 Flask 就绪（最多 3 秒）
    import urllib.request

    for _ in range(30):
        try:
            urllib.request.urlopen(url, timeout=0.3)
            break
        except (urllib.error.URLError, OSError):
            time.sleep(0.1)
    else:
        print("Flask 启动超时，请检查端口或重试。")
        sys.exit(1)

    # 固定 WebView2 用户数据目录，避免临时目录权限问题
    wv_data = os.path.join(os.path.expanduser("~"), ".autolabels", "webview2-data")
    os.makedirs(wv_data, exist_ok=True)
    os.environ["WEBVIEW2_USER_DATA_FOLDER"] = wv_data

    webview.create_window(
        title="视界标注专业版",
        url=url,
        width=1440,
        height=900,
        min_size=(1024, 600),
        resizable=True,
        text_select=True,
    )

    try:
        webview.start()
    except Exception as e:
        msg = str(e)
        if any(x in msg for x in ("WebView2", "edgechromium", "0x8000FFFF", "E_UNEXPECTED")):
            print(
                "⚠️  WebView2 运行时不可用。\n"
                "   python app.py --browser 可临时用浏览器打开。\n"
                "   或从以下地址安装 WebView2 运行时后重试：\n"
                "   https://go.microsoft.com/fwlink/p/?LinkId=2124703"
            )
        else:
            print(f"桌面模式启动失败：{msg}")
        sys.exit(1)


if __name__ == "__main__":
    import sys

    if "--desktop" in sys.argv or len(sys.argv) == 1:
        # 默认桌面模式；传 --browser 回退到浏览器模式
        if "--browser" in sys.argv:
            app.run(debug=True, threaded=True)
        else:
            _run_desktop()
    else:
        app.run(debug=True, threaded=True)
