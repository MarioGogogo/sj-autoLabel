"""检测器模块：环境检测 + 模型加载 + 推理。

全局单例 detector = Detector()，app.py 启动时调用 check_environment()，
推理时懒加载模型（首次调用 predict 时自动加载）。
"""

import importlib.metadata
import importlib.util
import os
import subprocess
import sys
import time

from sam_engine import SamHolder

# ===================== 环境检测 =====================

_ENV_CACHE = None  # 缓存检测结果，只跑一次


def check_environment():
    """检测当前环境 + 扫描外部 conda/venv 中可用的推理运行时。

    返回:
        {
            pt: bool,       # 当前进程可 import torch + ultralytics
            onnx: bool,     # 当前进程可 import onnxruntime
            details: {package: version|"未安装（...）"},
            external: [     # 其他环境中发现的可用于推理的环境
                {name, python, torch, ultralytics, onnxruntime}
            ],
        }
    """
    global _ENV_CACHE
    if _ENV_CACHE is not None:
        return _ENV_CACHE

    result = {"pt": False, "onnx": False, "sam2": False, "details": {}, "external": []}

    # ---- 当前进程检测 ----
    _check_current_process(result)

    # ---- 当前环境未满足时，扫描外部环境 ----
    if not result["pt"] and not result["onnx"]:
        result["external"] = _scan_external_envs()

    _ENV_CACHE = result
    return result


def _check_current_process(result):
    """检测当前 Python 进程可用哪些推理运行时（轻量探测，不加载 DLL）。"""
    # PyTorch (.pt) — 仅探测模块是否存在，不 import 避免 DLL 冲突
    if importlib.util.find_spec("torch") and importlib.util.find_spec("ultralytics"):
        result["pt"] = True
        result["details"]["torch"] = _try_version("torch")
        result["details"]["ultralytics"] = _try_version("ultralytics")
        # ultralytics YOLO 依赖 torchvision::nms 算子
        if not importlib.util.find_spec("torchvision"):
            result["pt"] = False
            result["details"]["torchvision"] = "未安装（pip install torchvision）"
        else:
            result["details"]["torchvision"] = _try_version("torchvision")
    else:
        result["details"]["torch"] = "未安装（pip install torch）"
        result["details"]["ultralytics"] = "需要 PyTorch"

    # ONNX Runtime (.onnx)
    if importlib.util.find_spec("onnxruntime"):
        result["onnx"] = True
        result["details"]["onnxruntime"] = _try_version("onnxruntime")
    else:
        result["details"]["onnxruntime"] = "未安装（pip install onnxruntime）"

    # SAM 2（.pt 分割模型，交互式点选）
    if importlib.util.find_spec("sam2"):
        result["sam2"] = True
        result["details"]["sam2"] = _try_version("sam2")
    else:
        result["details"]["sam2"] = "未安装（pip install sam2）"


def _scan_external_envs():
    """扫描系统上其他 Python 环境（已按用户要求停用自动扫描）。"""
    return []


def _scan_conda_envs():
    """用 conda/mamba 命令列出所有环境，检查每个环境是否有推理运行时。"""
    found = []

    # 找 conda/mamba/micromamba 可执行文件
    conda_bin = None
    for cmd in ["conda", "mamba", "micromamba"]:
        try:
            result = subprocess.run(
                [cmd, "env", "list", "--json"],
                capture_output=True, text=True, timeout=10,
                env={**os.environ, "CONDA_NO_PLUGINS": "1"},
            )
            if result.returncode == 0:
                data = __import__("json").loads(result.stdout)
                conda_bin = cmd
                break
        except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
            continue

    if not conda_bin:
        return found

    # 解析 conda env list 输出
    try:
        result = subprocess.run(
            [conda_bin, "env", "list", "--json"],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "CONDA_NO_PLUGINS": "1"},
        )
        envs_data = __import__("json").loads(result.stdout)
        env_paths = envs_data.get("envs", [])
    except Exception:
        return found

    for env_path in env_paths:
        # 找该环境的 python
        python_exe = os.path.join(env_path, "bin", "python3")  # macOS/Linux
        if not os.path.isfile(python_exe):
            python_exe = os.path.join(env_path, "bin", "python")
        if not os.path.isfile(python_exe):
            python_exe = os.path.join(env_path, "python.exe")  # Windows
        if not os.path.isfile(python_exe):
            continue

        env_info = _probe_python(python_exe)
        if env_info:
            env_info["name"] = os.path.basename(env_path)
            env_info["type"] = "conda"
            found.append(env_info)

    return found


def _scan_venv_dirs():
    """扫描常见位置的 venv/virtualenv。"""
    found = []
    candidates = []

    # 当前项目下的 venv
    project_root = os.path.dirname(os.path.abspath(__file__))
    for name in ["venv", ".venv", "env"]:
        p = os.path.join(project_root, name)
        if os.path.isdir(p):
            candidates.append(p)

    # 用户 home 下的常见位置
    home = os.path.expanduser("~")
    for d in [home, os.path.join(home, "miniconda3"), os.path.join(home, "anaconda3")]:
        if os.path.isdir(d):
            candidates.append(d)

    for cand in candidates[:10]:  # 最多扫 10 个，避免太慢
        for python_name in ["bin/python3", "bin/python", "python.exe"]:
            python_exe = os.path.join(cand, python_name)
            if os.path.isfile(python_exe) and python_exe != sys.executable:
                env_info = _probe_python(python_exe)
                if env_info:
                    env_info["name"] = os.path.basename(cand)
                    env_info["type"] = "venv"
                    found.append(env_info)
                break

    return found


def _probe_python(python_exe):
    """用指定 Python 解释器探测其是否可 import torch/ultralytics/onnxruntime。

    返回 {"python": path, "torch": ver|None, "ultralytics": ver|None, "onnxruntime": ver|None}
    若该环境中没有任何推理运行时则返回 None。
    """
    probe_code = """
import sys, importlib.util, importlib.metadata, json

# distribution 名与导入名不一致的包：onnxruntime-gpu 的导入名仍是 onnxruntime，
# 直接 version("onnxruntime") 会抛 PackageNotFoundError，故按候选名遍历 distributions。
_ALIASES = {'onnxruntime': {'onnxruntime', 'onnxruntime-gpu'}}

def _version(pkg):
    names = _ALIASES.get(pkg, {pkg})
    try:
        for d in importlib.metadata.distributions():
            nm = d.metadata.get('Name')
            if nm and nm in names:
                return d.version
    except Exception:
        pass
    return None

result = {}
for pkg in ['torch', 'ultralytics', 'onnxruntime', 'sam2']:
    try:
        spec = importlib.util.find_spec(pkg)
        result[pkg] = _version(pkg) if spec is not None else None
    except Exception:
        result[pkg] = None

result['cuda'] = "13.3"
print("PROBE_JSON:" + json.dumps(result))
"""
    try:
        # 构建子进程环境：注入防崩溃环境变量，补全 conda DLL 路径
        env = {
            **os.environ,
            "PYTHONPATH": "",
            "KMP_DUPLICATE_LIB_OK": "TRUE",
            "PYTHONIOENCODING": "utf-8",
        }
        py_dir = os.path.dirname(python_exe)
        conda_dll = os.path.join(os.path.dirname(py_dir), "Library", "bin")
        conda_scripts = os.path.join(os.path.dirname(py_dir), "Scripts")
        paths = env.get("PATH", "").split(os.pathsep)
        for d in [py_dir, conda_dll, conda_scripts]:
            if d and d not in paths:
                paths.insert(0, d)
        env["PATH"] = os.pathsep.join(paths)

        proc = subprocess.run(
            [python_exe, "-c", probe_code],
            capture_output=True, text=True, timeout=15,
            env=env,
        )
        stdout = proc.stdout or ""
        marker = "PROBE_JSON:"
        idx = stdout.find(marker)
        if idx >= 0:
            raw = stdout[idx + len(marker):].strip().splitlines()[0]
            result = json.loads(raw)
        else:
            return None
    except Exception:
        return None

    # 只有在至少有一个推理运行时时才返回（SAM 2 依附 torch）
    has_any = (
        bool(result.get("torch") and result.get("ultralytics"))
        or bool(result.get("onnxruntime"))
        or bool(result.get("torch") and result.get("sam2"))
    )
    if not has_any:
        return None

    return {
        "python": python_exe,
        "torch": result.get("torch"),
        "ultralytics": result.get("ultralytics"),
        "onnxruntime": result.get("onnxruntime"),
        "sam2": result.get("sam2"),
    }


def _try_version(pkg):
    """获取包版本用于环境详情展示。

    兼容 distribution 名与导入名不一致的情况：onnxruntime-gpu 注册的包名是
    onnxruntime-gpu，但导入名仍是 onnxruntime，直接 version("onnxruntime") 会抛
    PackageNotFoundError。改用 distributions() 遍历按候选名匹配，全程不抛异常。
    """
    candidates = {pkg, "onnxruntime-gpu"} if pkg == "onnxruntime" else {pkg}
    try:
        for dist in importlib.metadata.distributions():
            name = dist.metadata.get("Name")
            if name and name in candidates:
                return dist.version
    except Exception:
        pass
    return "已安装（版本未知）"


# ===================== 配置文件 =====================

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".autolabels")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")


def read_config():
    """读取 ~/.autolabels/config.json，返回 dict。不存在返回空。"""
    try:
        if os.path.exists(CONFIG_PATH):
            import json

            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def write_config(data: dict):
    """写入 ~/.autolabels/config.json。"""
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        import json

        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        raise OSError(f"无法写入配置文件：{e}")


# ===================== NMS 工具函数 =====================

def _iou(a, b):
    """计算两个比例坐标框的 IoU（0~1 归一化坐标）。"""
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area_a = a["w"] * a["h"]
    area_b = b["w"] * b["h"]
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0


# ===================== 检测器 =====================


class Detector:
    """模型检测器：支持进程内推理 + 外部 Worker 子进程。

    全局只实例化一次。当配置了外部 Python 路径时，自动启动 Worker 子进程。
    """

    def __init__(self):
        # 进程内推理
        self.model = None
        self.model_path = None
        self.model_format = None
        self.labels = []
        self._detected_images = set()
        self.device = "cpu"

        # Worker 子进程
        self._worker_proc = None
        self._worker_port = 0
        self._worker_python = ""

        # SAM 2 分割引擎（独立于 YOLO，两者可同时加载、互不干扰）
        self._sam_holder = SamHolder()
        self.sam_variant = None
        self.sam_device = "cpu"

    # ---- Worker 管理 ----

    @property
    def _use_worker(self):
        """是否通过外部 Worker 推理。"""
        return bool(self._worker_python and os.path.isfile(self._worker_python))

    def configure_worker(self, python_path: str):
        """配置外部 Python 路径。传空字符串则禁用 Worker 模式。"""
        if not python_path:
            self._stop_worker()
            self._worker_python = ""
            return
        if not os.path.isfile(python_path):
            raise FileNotFoundError(f"Python 路径不存在：{python_path}")
        self._worker_python = python_path

    def _start_worker(self):
        """启动 Worker 子进程，等待就绪。"""
        if self._worker_proc and self._worker_proc.poll() is None:
            return  # 已在运行

        self._stop_worker()

        worker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")
        py_dir = os.path.dirname(self._worker_python)
        conda_dll = os.path.join(os.path.dirname(py_dir), "Library", "bin")
        worker_env = {**os.environ, "PYTHONPATH": ""}
        paths = worker_env.get("PATH", "").split(os.pathsep)
        for d in [py_dir, conda_dll]:
            if d not in paths:
                paths.insert(0, d)
        worker_env["PATH"] = os.pathsep.join(paths)

        self._worker_proc = subprocess.Popen(
            [self._worker_python, worker_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=worker_env,
        )

        # 等待 worker 输出 WORKER_READY:<port>
        deadline = time.time() + 15
        while time.time() < deadline:
            line = self._worker_proc.stdout.readline()
            if line.startswith("WORKER_READY:"):
                self._worker_port = int(line.strip().split(":")[1])
                return
            if self._worker_proc.poll() is not None:
                stderr = self._worker_proc.stderr.read()
                raise RuntimeError(f"Worker 进程退出：{stderr[:200]}")
            time.sleep(0.05)

        raise TimeoutError("Worker 启动超时")

    def _stop_worker(self):
        """停止 Worker 子进程。"""
        if self._worker_proc:
            try:
                self._worker_request("POST", "/shutdown", timeout=2)
            except Exception:
                pass
            try:
                self._worker_proc.terminate()
                self._worker_proc.wait(timeout=3)
            except Exception:
                try:
                    self._worker_proc.kill()
                except Exception:
                    pass
            self._worker_proc = None
            self._worker_port = 0

    def _worker_request(self, method: str, path: str, data: dict = None, timeout: int = 60):
        """向 Worker 发送 HTTP 请求，返回 (status, json_data)。"""
        import urllib.request

        url = f"http://127.0.0.1:{self._worker_port}{path}"
        body = None
        if data is not None:
            import json as _json

            body = _json.dumps(data).encode("utf-8")

        req = urllib.request.Request(url, method=method, data=body)
        if body:
            req.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                import json as _json

                return resp.status, _json.loads(resp.read())
        except urllib.error.HTTPError as e:
            import json as _json

            return e.code, _json.loads(e.read())

    def _worker_health(self):
        """检查 Worker 健康状态。返回 dict 或 None（不可达）。"""
        try:
            status, data = self._worker_request("GET", "/health", timeout=3)
            return data if status == 200 else None
        except Exception:
            return None

    # ---- 加载 ----

    def load(self, path: str):
        """加载模型文件。Worker 模式下发送 /load，否则进程内加载。"""
        path = os.path.realpath(path)

        if self._use_worker:
            self._start_worker()
            status, data = self._worker_request("POST", "/load", {"path": path})
            if status != 200 or not data.get("ok"):
                raise RuntimeError(data.get("error", "Worker 加载失败"))
            self.model_path = path
            self.model_format = os.path.splitext(path)[1].lower()
            self.device = data.get("device", "cpu")
            self.labels = data.get("labels", [])
            self._detected_images.clear()
            return

        # 进程内模式
        if self.model is not None and self.model_path == path:
            return

        ext = os.path.splitext(path)[1].lower()
        if ext == ".pt":
            self._load_pt(path)
        elif ext == ".onnx":
            self._load_onnx(path)
        else:
            raise ValueError(f"不支持的模型格式：{ext}")

        self.model_path = path
        self.model_format = ext
        self._detected_images.clear()

    def _load_pt(self, path: str):
        import torch
        from ultralytics import YOLO

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = YOLO(path)
        self.model.to(self.device)
        self.labels = list(self.model.names.values()) if hasattr(self.model, "names") else []

    def _load_onnx(self, path: str):
        import onnxruntime as ort

        providers = ort.get_available_providers()
        # 优先 CUDA → CoreML（macOS）→ CPU
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        self.model = ort.InferenceSession(path, sess_options, providers=providers)
        self.device = providers[0] if providers else "cpu"

        # 尝试从模型元数据读取类别名
        try:
            meta = self.model.get_modelmeta()
            if meta.custom_metadata_map:
                names = meta.custom_metadata_map.get("names", "")
                if names:
                    import json
                    self.labels = list(json.loads(names).values())
        except Exception:
            self.labels = []

    # ---- 推理 ----

    def predict(self, image_path: str, image_name: str, conf: float = 0.5, force: bool = False):
        """对单张图片推理，返回 (boxes, cached)。Worker 模式下通过 HTTP 调用。"""
        # 去重检查
        cache_key = f"{image_name}@{conf:.2f}"
        if not force and cache_key in self._detected_images:
            return [], True

        if self._use_worker:
            return self._predict_via_worker(image_path, image_name, conf, cache_key)

        # 进程内模式
        if self.model is None:
            raise RuntimeError("模型未加载，请先加载模型文件")

        ext = self.model_format
        if ext == ".pt":
            boxes = self._predict_pt(image_path, conf)
        elif ext == ".onnx":
            boxes = self._predict_onnx(image_path, conf)
        else:
            raise ValueError(f"未知模型格式：{ext}")

        self._detected_images.add(cache_key)
        return boxes, False

    def _predict_via_worker(self, image_path: str, image_name: str, conf: float, cache_key: str):
        """通过 Worker 子进程推理。"""
        if self._worker_proc is None or self._worker_proc.poll() is not None:
            raise RuntimeError("Worker 进程未运行，请检查推理环境配置")

        status, data = self._worker_request(
            "POST", "/predict", {"image_path": image_path, "conf": conf}
        )
        if status != 200 or not data.get("ok"):
            raise RuntimeError(data.get("error", "Worker 推理失败"))

        self._detected_images.add(cache_key)
        return data.get("boxes", []), False

    def _predict_pt(self, image_path: str, conf: float):
        from PIL import Image

        img = Image.open(image_path)
        W, H = img.size

        results = self.model(image_path, conf=conf, verbose=False)
        boxes = []
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                cls_id = int(box.cls[0]) if hasattr(box.cls, "__iter__") else int(box.cls)
                label = self.labels[cls_id] if cls_id < len(self.labels) else f"class_{cls_id}"
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                score = float(box.conf[0]) if hasattr(box.conf, "__iter__") else float(box.conf)
                boxes.append({
                    "label": label,
                    "class_id": cls_id,
                    "score": round(score * 100),
                    "x": x1 / W,
                    "y": y1 / H,
                    "w": (x2 - x1) / W,
                    "h": (y2 - y1) / H,
                })
        return boxes

    def _predict_onnx(self, image_path: str, conf: float):
        import numpy as np
        from PIL import Image, ImageOps

        img = Image.open(image_path).convert("RGB")
        W, H = img.size

        # 标准 YOLO ONNX 预处理：letterbox（保持比例 + 灰边填充），而非简单拉伸
        input_size = 640
        scale = min(input_size / W, input_size / H)
        nw, nh = int(W * scale), int(H * scale)
        img_resized = img.resize((nw, nh), Image.LANCZOS)
        padded = Image.new("RGB", (input_size, input_size), (114, 114, 114))
        pad_x = (input_size - nw) // 2
        pad_y = (input_size - nh) // 2
        padded.paste(img_resized, (pad_x, pad_y))
        img_np = np.array(padded).astype(np.float32) / 255.0
        img_np = img_np.transpose(2, 0, 1)[np.newaxis, ...]  # NCHW

        input_name = self.model.get_inputs()[0].name
        outputs = self.model.run(None, {input_name: img_np})

        # 解析 ONNX YOLO 输出 [1, 84, 8400] 格式
        boxes = self._parse_onnx_output(outputs[0], W, H, input_size, scale, pad_x, pad_y, conf)
        return boxes

    def _parse_onnx_output(self, output, orig_w, orig_h, input_size, scale, pad_x, pad_y, conf):
        import numpy as np

        boxes = []
        # output shape: (1, 4 + num_classes, num_anchors)
        output = np.squeeze(output[0]) if isinstance(output, list) else np.squeeze(output)
        if output.ndim != 2:
            output = output.reshape(output.shape[0], -1)

        num_classes = output.shape[0] - 4
        for i in range(output.shape[1]):
            scores = output[4:, i]
            cls_id = int(np.argmax(scores))
            score = float(scores[cls_id])
            if score < conf:
                continue

            cx, cy, w, h = output[:4, i]
            # 去掉 letterbox 灰边，映射回原图
            cx = (cx * input_size - pad_x) / scale
            cy = (cy * input_size - pad_y) / scale
            w = w * input_size / scale
            h = h * input_size / scale
            x = max(0, (cx - w / 2) / orig_w)
            y = max(0, (cy - h / 2) / orig_h)
            bw = min(w / orig_w, 1 - x)
            bh = min(h / orig_h, 1 - y)

            label = self.labels[cls_id] if cls_id < len(self.labels) else f"class_{cls_id}"
            boxes.append({
                "label": label,
                "class_id": cls_id,
                "score": round(score * 100),
                "x": max(0, x),
                "y": max(0, y),
                "w": min(bw, 1 - x),
                "h": min(bh, 1 - y),
            })
        # NMS：按 score 排序，剔除高重叠的框
        boxes.sort(key=lambda b: b["score"], reverse=True)
        keep = []
        for b in boxes:
            overlap = False
            for kb in keep:
                if _iou(b, kb) > 0.5:
                    overlap = True
                    break
            if not overlap:
                keep.append(b)
        return keep

    # ---- SAM 2 分割（独立引擎，与 YOLO 并列） ----

    def load_sam(self, variant="large", checkpoint=""):
        """加载 SAM 2 模型。Worker 模式转发 /load_sam，否则进程内加载。"""
        if self._use_worker:
            self._start_worker()
            status, data = self._worker_request(
                "POST", "/load_sam",
                {"variant": variant, "checkpoint": checkpoint},
                timeout=180,  # 首次加载/下载可能较慢
            )
            if status != 200 or not data.get("ok"):
                raise RuntimeError(data.get("error", "SAM 加载失败"))
            self.sam_variant = data.get("variant", variant)
            self.sam_device = data.get("device", "cpu")
        else:
            self._sam_holder.load(variant, checkpoint)
            self.sam_variant = self._sam_holder.variant
            self.sam_device = self._sam_holder.device

    def segment(self, image_path, points, labels):
        """点提示分割，返回归一化外接框 {x,y,w,h,score} 或 None。"""
        if self._use_worker:
            if self._worker_proc is None or self._worker_proc.poll() is not None:
                raise RuntimeError("Worker 进程未运行，请检查推理环境配置")
            status, data = self._worker_request(
                "POST", "/segment",
                {"image_path": image_path, "points": points, "labels": labels},
                timeout=60,
            )
            if status != 200 or not data.get("ok"):
                raise RuntimeError(data.get("error", "SAM 分割失败"))
            return data.get("box")
        if not self._sam_holder.is_loaded:
            raise RuntimeError("SAM 模型未加载，请先加载")
        return self._sam_holder.segment(image_path, points, labels)

    def unload_sam(self):
        """卸载 SAM 模型，释放显存（不影响 YOLO）。"""
        if self._use_worker:
            if self._worker_proc and self._worker_proc.poll() is None:
                status, data = self._worker_request("POST", "/unload_sam", {}, timeout=30)
                if status != 200 or not data.get("ok"):
                    raise RuntimeError(data.get("error", "SAM 卸载失败"))
        else:
            self._sam_holder.unload()
        self.sam_variant = None
        self.sam_device = "cpu"

    @property
    def sam_is_loaded(self):
        if self._use_worker:
            health = self._worker_health()
            return health is not None and health.get("sam_loaded", False)
        return self._sam_holder.is_loaded

    @property
    def is_loaded(self):
        if self._use_worker:
            health = self._worker_health()
            return health is not None and health.get("loaded", False)
        return self.model is not None


# ===================== 全局单例 =====================

detector = Detector()
