#!/usr/bin/env python3
"""视界标注 — 推理 Worker 子进程。

由主进程（app.py）在外部 Python 环境中启动，通过 HTTP 通信。
使用该环境的 torch/ultralytics 或 onnxruntime 加载模型并执行推理。

协议：
  GET  /health              → {"ok": true, "loaded": bool, "device": "..."}
  POST /load   {"path":"."} → {"ok": true, "device": "...", "labels": [...]}
  POST /predict {"image_path":"...","conf":0.5} → {"ok": true, "boxes":[...], ...}

启动方式：
  python worker.py --model /path/to/model.pt --port 5099
  python worker.py --port 5099          # 不预加载，等 /load 请求

端口可用范围：5090-5120，由 --port 指定或自动选择。
"""

import argparse
import json
import os
import sys

# 放行 OpenMP 运行时冲突（torch + MKL 在 Windows/conda 常见，否则 import torch 时 OMP Error #15 abort）。
# 须在任何 torch import 之前；Worker 是独立进程，显式设一次更稳。
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
import time
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

from sam_engine import SamHolder


# ===== 模型持有者（模块级单例） =====

class ModelHolder:
    def __init__(self):
        self.model = None
        self.format = None
        self.device = "cpu"
        self.labels = []

    def load(self, path: str):
        ext = os.path.splitext(path)[1].lower()
        if ext == ".pt":
            self._load_pt(path)
        elif ext == ".onnx":
            self._load_onnx(path)
        else:
            raise ValueError(f"不支持格式：{ext}")
        self.format = ext

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
        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.model = ort.InferenceSession(path, sess_opts, providers=providers)
        self.device = providers[0] if providers else "cpu"
        try:
            meta = self.model.get_modelmeta()
            if meta.custom_metadata_map:
                names = meta.custom_metadata_map.get("names", "")
                if names:
                    self.labels = list(json.loads(names).values())
        except Exception:
            self.labels = []

    def unload(self):
        """释放模型引用并尽量回收显存（对应 detector.unload）。"""
        self.model = None
        self.format = None
        self.labels = []
        self.device = "cpu"
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def predict(self, image_path: str, conf: float = 0.5):
        if self.format == ".pt":
            return self._predict_pt(image_path, conf)
        elif self.format == ".onnx":
            return self._predict_onnx(image_path, conf)
        raise RuntimeError("模型未加载")

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
                    "label": label, "class_id": cls_id, "score": round(score * 100),
                    "x": x1 / W, "y": y1 / H,
                    "w": (x2 - x1) / W, "h": (y2 - y1) / H,
                })
        return boxes

    def _predict_onnx(self, image_path: str, conf: float):
        import numpy as np
        from PIL import Image

        img = Image.open(image_path).convert("RGB")
        W, H = img.size
        input_size = 640
        scale = min(input_size / W, input_size / H)
        nw, nh = int(W * scale), int(H * scale)
        img_resized = img.resize((nw, nh), Image.LANCZOS)
        padded = Image.new("RGB", (input_size, input_size), (114, 114, 114))
        pad_x = (input_size - nw) // 2
        pad_y = (input_size - nh) // 2
        padded.paste(img_resized, (pad_x, pad_y))
        img_np = np.array(padded).astype(np.float32) / 255.0
        img_np = img_np.transpose(2, 0, 1)[np.newaxis, ...]
        input_name = self.model.get_inputs()[0].name
        outputs = self.model.run(None, {input_name: img_np})
        boxes = self._parse_onnx_output(outputs[0], W, H, input_size, scale, pad_x, pad_y, conf)
        return boxes

    def _parse_onnx_output(self, output, orig_w, orig_h, input_size, scale, pad_x, pad_y, conf):
        import numpy as np
        boxes = []
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
                "label": label, "class_id": cls_id, "score": round(score * 100),
                "x": max(0, x), "y": max(0, y),
                "w": min(bw, 1 - x), "h": min(bh, 1 - y),
            })
        # NMS：按 score 排序，剔除高重叠框
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


holder = ModelHolder()
sam_holder = SamHolder()


# ===== HTTP Handler =====

class WorkerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 静默，避免污染 stdout

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        if self.path == "/health":
            self._send_json({
                "ok": True,
                "loaded": holder.model is not None,
                "device": holder.device,
                "format": holder.format,
                "labels": holder.labels[:20],
                "sam_loaded": sam_holder.is_loaded,
                "sam_variant": sam_holder.variant,
                "sam_device": sam_holder.device,
            })
        else:
            self._send_json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        try:
            if self.path == "/load":
                data = self._read_body()
                path = data.get("path", "")
                if not path or not os.path.isfile(path):
                    self._send_json({"ok": False, "error": "模型文件不存在"}, 400)
                    return
                holder.load(path)
                self._send_json({
                    "ok": True,
                    "device": holder.device,
                    "format": holder.format,
                    "labels": holder.labels[:20],
                })

            elif self.path == "/predict":
                if holder.model is None:
                    self._send_json({"ok": False, "error": "模型未加载"}, 400)
                    return
                data = self._read_body()
                image_path = data.get("image_path", "")
                conf = float(data.get("conf", 0.5))
                if not image_path or not os.path.isfile(image_path):
                    self._send_json({"ok": False, "error": "图片不存在"}, 400)
                    return
                t0 = time.time()
                boxes = holder.predict(image_path, conf)
                elapsed = round((time.time() - t0) * 1000)
                self._send_json({
                    "ok": True,
                    "boxes": boxes,
                    "elapsed_ms": elapsed,
                    "device": holder.device,
                })

            elif self.path == "/load_sam":
                data = self._read_body()
                variant = data.get("variant", "large")
                checkpoint = data.get("checkpoint", "")
                sam_holder.load(variant, checkpoint)
                self._send_json({
                    "ok": True,
                    "variant": sam_holder.variant,
                    "device": sam_holder.device,
                })

            elif self.path == "/segment":
                if not sam_holder.is_loaded:
                    self._send_json({"ok": False, "error": "SAM 模型未加载"}, 400)
                    return
                data = self._read_body()
                image_path = data.get("image_path", "")
                points = data.get("points", [])
                labels = data.get("labels", [1] * len(points))
                if not image_path or not os.path.isfile(image_path):
                    self._send_json({"ok": False, "error": "图片不存在"}, 400)
                    return
                t0 = time.time()
                box = sam_holder.segment(image_path, points, labels)
                elapsed = round((time.time() - t0) * 1000)
                if box is None:
                    self._send_json({"ok": False, "error": "未分割出目标", "elapsed_ms": elapsed})
                    return
                self._send_json({
                    "ok": True,
                    "box": box,
                    "elapsed_ms": elapsed,
                    "device": sam_holder.device,
                })

            elif self.path == "/unload_sam":
                sam_holder.unload()
                self._send_json({"ok": True, "variant": sam_holder.variant})

            elif self.path == "/unload":
                holder.unload()
                self._send_json({"ok": True})

            elif self.path == "/shutdown":
                self._send_json({"ok": True})
                # 在另一个线程中关闭，避免阻塞当前响应
                import threading
                threading.Thread(target=lambda: (time.sleep(0.1), sys.exit(0)), daemon=True).start()

            else:
                self._send_json({"ok": False, "error": "not found"}, 404)

        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)


# ===== 入口 =====

def _pick_port(start=5090, tries=30):
    import socket
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start


def main():
    parser = argparse.ArgumentParser(description="视界标注推理 Worker")
    parser.add_argument("--port", type=int, default=0, help="监听端口（0=自动选择）")
    parser.add_argument("--model", type=str, default="", help="启动时预加载的模型路径")
    args = parser.parse_args()

    port = args.port if args.port > 0 else _pick_port()

    # 预加载模型（可选）
    if args.model and os.path.isfile(args.model):
        try:
            holder.load(args.model)
        except Exception as e:
            print(f"WORKER_ERROR: {e}", file=sys.stderr, flush=True)

    # 启动 HTTP server
    server = HTTPServer(("127.0.0.1", port), WorkerHandler)

    # 向主进程通告端口（stdout 这行是给主进程解析的）
    print(f"WORKER_READY:{port}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
