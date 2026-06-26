"""视界标注专业版 | AI 自动标注 —— Flask 应用入口。

运行方式：
    pip install -r requirements.txt
    python app.py
然后在浏览器打开 http://127.0.0.1:5000
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    session,
    url_for,
)

app = Flask(__name__)
# 用于 session 加密签名（开发用固定值即可，生产应换成环境变量）。
app.secret_key = "dev-secret-autolabels"

UPLOAD_DIR = os.path.join(app.static_folder, "uploads")
THUMB_DIR = os.path.join(app.static_folder, "thumbnails")
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 单次上传上限 50MB
THUMB_MAX_SIZE = 160  # 缩略图最长边 160px，列表里显示 40px，足够清晰且极小

# ===== 标注产物（YOLO 格式）=====
# 项目根目录下，便于离线训练直接取用。
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LABEL_DIR = os.path.join(BASE_DIR, "labels")  # 每图一个 txt
CLASSES_FILE = os.path.join(BASE_DIR, "classes.txt")  # 类名每行一个，行号=class_id
COLOR_CACHE_FILE = os.path.join(BASE_DIR, "分类颜色缓存.json")  # {类名: "#hex"}
os.makedirs(LABEL_DIR, exist_ok=True)

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


def _ensure_session_images():
    """确保 session 中存在图片清单（内存级持久化，按浏览器会话隔离）。"""
    if "images" not in session:
        session["images"] = []
    return session["images"]


# ===== 类别与标注文件读写 =====

def _read_classes():
    """读取 classes.txt，返回类名列表（行号 = class_id）。文件不存在返回空列表。"""
    if not os.path.exists(CLASSES_FILE):
        return []
    with open(CLASSES_FILE, "r", encoding="utf-8") as f:
        return [line.rstrip("\n") for line in f if line.strip()]


def _write_classes(names):
    """覆盖写入 classes.txt，每行一个类名。"""
    with open(CLASSES_FILE, "w", encoding="utf-8") as f:
        if names:
            f.write("\n".join(names) + "\n")


def _read_colors():
    """读取颜色缓存 JSON，返回 {类名: hex}。损坏/不存在返回空 dict。"""
    if not os.path.exists(COLOR_CACHE_FILE):
        return {}
    try:
        with open(COLOR_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_colors(mapping):
    """覆盖写入颜色缓存 JSON。"""
    with open(COLOR_CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)


def _image_name_by_id(images, image_id):
    """从图片清单反查原始文件名（用于 txt 命名）。找不到返回 None。"""
    for img in images:
        if img["id"] == image_id:
            return img["name"]
    return None


def _safe_label_stem(original_name):
    """原始文件名 → 安全的 txt 文件名主干（去扩展名 + 替换危险字符）。

    最终再 basename 兜底，确保无法逃出 LABEL_DIR（防路径穿越）。
    """
    stem = os.path.splitext(original_name)[0]
    stem = re.sub(r'[\\/:*?"<>|]+', "_", stem)
    stem = stem.lstrip(". ")  # 防隐藏文件 / 相对路径
    return os.path.basename(stem) or "unnamed"


def _label_txt_path(original_name):
    """标注 txt 完整路径：labels/<安全主干>.txt。"""
    return os.path.join(LABEL_DIR, _safe_label_stem(original_name) + ".txt")


def _clamp01(v):
    return max(0.0, min(1.0, v))


def _make_thumbnail(src_path, dst_path):
    """生成缩略图（最长边 THUMB_MAX_SIZE，JPEG 压缩）。

    列表只需 40px，缩略图约几 KB，避免浏览器一次解码多张 MB 级原图导致卡顿。
    生成失败时静默返回 False，由调用方回退到原图。
    """
    try:
        from PIL import Image  # 延迟导入，未装 Pillow 时不影响启动

        with Image.open(src_path) as im:
            im.thumbnail((THUMB_MAX_SIZE, THUMB_MAX_SIZE))
            # 统一存为 JPEG（含透明通道的图先铺白底），体积最小。
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


@app.route("/")
def index():
    """主界面：标注工作台。"""
    images = _ensure_session_images()
    return render_template("index.html", images=images)


@app.route("/api/images")
def api_images():
    """返回当前会话的全部图片（含状态）。"""
    return jsonify({"images": _ensure_session_images()})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """接收多文件上传，保存到 static/uploads，返回新增的图片清单。

    每张图片状态标注为：
        - pending  待处理（新导入默认）
        - done     已处理（接入模型检测后更新）
    """
    if "files" not in request.files:
        return jsonify({"ok": False, "error": "未选择文件"}), 400

    files = request.files.getlist("files")
    saved = []
    images = _ensure_session_images()

    for f in files:
        if not f or not f.filename:
            continue
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in ALLOWED_EXT:
            continue

        # 用 uuid 防止重名覆盖，保留原始扩展名。
        safe_name = f"{uuid.uuid4().hex}{ext}"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        os.makedirs(THUMB_DIR, exist_ok=True)
        save_path = os.path.join(UPLOAD_DIR, safe_name)
        f.save(save_path)

        # 生成缩略图；失败则回退原图。
        thumb_name = f"{uuid.uuid4().hex}.jpg"
        thumb_path = os.path.join(THUMB_DIR, thumb_name)
        has_thumb = _make_thumbnail(save_path, thumb_path)

        size = os.path.getsize(save_path)
        record = {
            "id": uuid.uuid4().hex,
            "name": f.filename,
            "url": url_for("static", filename=f"uploads/{safe_name}"),
            # 列表专用小缩略图，避免一次性加载多张 MB 级原图导致卡顿。
            "thumb_url": (
                url_for("static", filename=f"thumbnails/{thumb_name}")
                if has_thumb
                else url_for("static", filename=f"uploads/{safe_name}")
            ),
            "size": size,
            "status": "pending",  # 新导入统一标记「待处理」
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        images.append(record)
        saved.append(record)

    # session 赋值确保触发序列化。
    session["images"] = images
    return jsonify({"ok": True, "images": saved, "total": len(images)})


@app.route("/api/images/<image_id>/status", methods=["PATCH"])
def api_update_status(image_id):
    """更新某张图片的状态（pending <-> done）。"""
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    if status not in ("pending", "done"):
        return jsonify({"ok": False, "error": "非法状态"}), 400

    images = _ensure_session_images()
    for img in images:
        if img["id"] == image_id:
            img["status"] = status
            session["images"] = images
            return jsonify({"ok": True, "image": img})
    return jsonify({"ok": False, "error": "图片不存在"}), 404


@app.route("/api/images/<image_id>", methods=["DELETE"])
def api_delete_image(image_id):
    """删除某张图片（同时尝试删除磁盘文件）。"""
    images = _ensure_session_images()
    target = next((img for img in images if img["id"] == image_id), None)
    if not target:
        return jsonify({"ok": False, "error": "图片不存在"}), 404

    images.remove(target)
    session["images"] = images

    def _remove(url):
        rel = url.lstrip("/")
        abs_path = os.path.join(app.static_folder, rel.replace("static/", "", 1))
        try:
            if os.path.exists(abs_path):
                os.remove(abs_path)
        except OSError:
            pass

    _remove(target["url"])
    if target.get("thumb_url") and target["thumb_url"] != target["url"]:
        _remove(target["thumb_url"])

    return jsonify({"ok": True, "total": len(images)})


@app.route("/api/images", methods=["DELETE"])
def api_clear_images():
    """一键清空：删除当前会话全部图片及其磁盘文件（原图+缩略图）。"""
    images = _ensure_session_images()

    def _remove(url):
        rel = url.lstrip("/")
        abs_path = os.path.join(app.static_folder, rel.replace("static/", "", 1))
        try:
            if os.path.exists(abs_path):
                os.remove(abs_path)
        except OSError:
            pass

    for img in images:
        _remove(img["url"])
        if img.get("thumb_url") and img["thumb_url"] != img["url"]:
            _remove(img["thumb_url"])

    session["images"] = []
    return jsonify({"ok": True, "total": 0, "cleared": len(images)})


# ===================== 类别（classes.txt + 颜色缓存）=====================

@app.route("/api/classes")
def api_get_classes():
    """返回全部类别：[{label, hex, id}]，id = classes.txt 行号（class_id）。"""
    names = _read_classes()
    colors = _read_colors()
    categories = [
        {"label": n, "hex": colors.get(n, "#003d9b"), "id": i}
        for i, n in enumerate(names)
    ]
    return jsonify({"ok": True, "categories": categories})


@app.route("/api/classes", methods=["POST"])
def api_add_class():
    """新增类别：追加到 classes.txt 末尾 + 更新颜色缓存。返回新 class_id。"""
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
    """删除类别。

    若该 class_id 被现有标注使用且未带 force=1 → 409 要求二次确认。
    force=1 时：移除类别、更新两文件、重写所有 txt（被删 class_id 的行丢弃，
    >idx 的 class_id 减 1）。
    """
    names = _read_classes()
    if label not in names:
        return jsonify({"ok": False, "error": "类别不存在"}), 404
    idx = names.index(label)
    force = request.args.get("force", "0") == "1"

    # 统计被使用情况（扫描所有 txt 里行首 == idx 的行）。
    used_files = 0
    for fn in os.listdir(LABEL_DIR):
        if not fn.endswith(".txt"):
            continue
        try:
            with open(os.path.join(LABEL_DIR, fn), "r", encoding="utf-8") as f:
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

    # 执行删除 + 重排。
    names.pop(idx)
    _write_classes(names)
    colors = _read_colors()
    colors.pop(label, None)
    _write_colors(colors)

    for fn in list(os.listdir(LABEL_DIR)):
        if not fn.endswith(".txt"):
            continue
        path = os.path.join(LABEL_DIR, fn)
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
                continue  # 被删类别 → 丢弃该框
            if cid > idx:
                cid -= 1  # 后移类别补位
            new_lines.append(f"{cid} {' '.join(parts[1:])}\n")
        if new_lines:
            with open(path, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
        else:
            os.remove(path)  # 重排后为空 → 删文件

    return jsonify({"ok": True, "total": len(names)})


# ===================== 单图标注（YOLO txt）=====================
# 前端坐标：左上角 + 宽高（0~1）。YOLO：中心点 + 宽高（0~1）。

@app.route("/api/labels/<image_id>", methods=["PUT"])
def api_save_labels(image_id):
    """保存某图的标注为 labels/<图片名>.txt（YOLO 中心点格式）。"""
    images = _ensure_session_images()
    name = _image_name_by_id(images, image_id)
    if not name:
        return jsonify({"ok": False, "error": "图片信息丢失，请重新导入"}), 404

    data = request.get_json(silent=True) or {}
    boxes = data.get("boxes") or []

    txt_path = _label_txt_path(name)
    names = _read_classes()
    changed = False  # classes 是否有变更（自动追加新类别时）

    if not boxes:
        # 框全删 → 删除 txt，不写空文件。
        try:
            if os.path.exists(txt_path):
                os.remove(txt_path)
        except OSError:
            pass
        return jsonify({"ok": True, "count": 0})

    lines = []
    for b in boxes:
        label = b.get("label", "")
        if label not in names:
            # 未见过的类别自动追加（保证总能存）。
            names.append(label)
            changed = True
        cid = names.index(label)
        x = _clamp01(float(b.get("x", 0)))
        y = _clamp01(float(b.get("y", 0)))
        w = _clamp01(float(b.get("w", 0)))
        h = _clamp01(float(b.get("h", 0)))
        cx = _clamp01(x + w / 2)
        cy = _clamp01(y + h / 2)
        lines.append(f"{cid} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

    if changed:
        _write_classes(names)

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return jsonify({"ok": True, "count": len(lines)})


@app.route("/api/labels/<image_id>")
def api_load_labels(image_id):
    """加载某图的标注（读 txt，转回前端左上角格式）。txt 不存在返回空。"""
    images = _ensure_session_images()
    name = _image_name_by_id(images, image_id)
    if not name:
        return jsonify({"ok": False, "error": "图片信息丢失，请重新导入"}), 404

    txt_path = _label_txt_path(name)
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
                    continue  # class_id 越界，跳过
                label = names[cid]
                boxes.append({
                    "label": label,
                    "score": 100,  # YOLO 格式无置信度，加载时占位
                    "x": _clamp01(cx - w / 2),
                    "y": _clamp01(cy - h / 2),
                    "w": _clamp01(w),
                    "h": _clamp01(h),
                    "hex": colors.get(label, "#003d9b"),
                })
    except OSError:
        return jsonify({"ok": True, "boxes": []})
    return jsonify({"ok": True, "boxes": boxes})


if __name__ == "__main__":
    app.run(debug=True)
