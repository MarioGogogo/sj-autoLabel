"""训练进程管理器：启动/监控/取消 YOLO 训练子进程，实时广播输出。

架构（与 detector.py 的 worker.py 同步 HTTP 模式不同——训练是单次长任务 + 流式输出 + 可取消）：
- 主进程（Flask）通过 subprocess.Popen 启动外部 Python 跑 train_runner.py
- 后台 reader 线程持续读子进程 stdout（stderr 合流），写入 deque 历史 + 广播给所有 SSE 订阅者
- 状态机：IDLE → RUNNING → (DONE | ERROR | CANCELLED)；停止后回 IDLE
- 单例 train_manager，app.py import；atexit 注册 shutdown 杀子进程，防残留

环境构建复用 detector._start_worker 的逻辑（PATH 前置外部 python 目录 + conda DLL 目录、清空 PYTHONPATH）。
"""

import glob
import json
import os
import queue
import random
import shutil
import subprocess
import threading
from collections import deque

RUNNER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_runner.py")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
DEFAULT_VAL_RATIO = 0.2


class TrainManager:
    """训练进程生命周期 + 实时日志广播，单例。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._proc = None
        self._reader = None
        self._state = "idle"          # idle | running | done | error | cancelled
        self._error = ""
        self._result = None           # {"weights", "onnx"} | {"status":"error",...}
        self._meta = {}               # name / project / runs_dir / result_path
        self._buffer = deque(maxlen=10000)   # 历史日志片段（新 SSE 连接回放）
        self._subscribers = []        # list[queue.Queue]，每个 SSE 连接一个

    # ===================== 状态查询 =====================

    def status(self):
        with self._lock:
            return {
                "state": self._state,
                "error": self._error,
                "result": self._result,
            }

    def is_running(self):
        with self._lock:
            return self._state == "running"

    # ===================== SSE 订阅 =====================

    def subscribe(self):
        """注册一个 SSE 订阅者，返回其专属队列（已注入历史日志回放）。"""
        q = queue.Queue()
        with self._lock:
            for text in list(self._buffer):
                q.put(text)
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _broadcast(self, text):
        """把一段日志文本广播给所有订阅者。"""
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(text)
            except queue.Full:
                pass  # 慢客户端丢弃，避免拖累 reader 线程

    # ===================== 数据集准备（生成 data.yaml + train/val 切分） =====================

    def prepare_dataset(self, project, val_ratio=DEFAULT_VAL_RATIO):
        """在项目内生成 .dataset_split/{data.yaml,train.txt,val.txt}，返回 data.yaml 绝对路径。

        用固定随机种子切分（可复现），仅保留有对应 label 的图，不移动/复制原图。
        """
        images_dir = os.path.join(project, "images")
        labels_dir = os.path.join(project, "labels")
        if not os.path.isdir(images_dir):
            raise FileNotFoundError("项目缺少 images/ 目录")

        # 仅保留有对应 labels/<stem>.txt 的图
        labeled = []
        for fn in sorted(os.listdir(images_dir)):
            ext = os.path.splitext(fn)[1].lower()
            if ext not in IMAGE_EXTS:
                continue
            stem = os.path.splitext(fn)[0]
            if os.path.isfile(os.path.join(labels_dir, stem + ".txt")):
                labeled.append(fn)
        if not labeled:
            raise FileNotFoundError("没有找到带标注的图片（images/ 下的图在 labels/ 缺少同名 txt）")

        # 固定种子切分（可复现）
        shuffled = labeled[:]
        random.Random(42).shuffle(shuffled)
        n_val = max(1, int(len(shuffled) * val_ratio))
        val, train = shuffled[:n_val], shuffled[n_val:]

        split_dir = os.path.join(project, ".dataset_split")
        os.makedirs(split_dir, exist_ok=True)
        train_txt = os.path.join(split_dir, "train.txt")
        val_txt = os.path.join(split_dir, "val.txt")
        with open(train_txt, "w", encoding="utf-8") as f:
            for fn in train:
                f.write(os.path.join(images_dir, fn) + "\n")
        with open(val_txt, "w", encoding="utf-8") as f:
            for fn in val:
                f.write(os.path.join(images_dir, fn) + "\n")

        names = self._read_classes(project)
        if not names:
            raise FileNotFoundError("classes.txt 为空或不存在，无法确定训练类别")

        # data.yaml：ultralytics 从图像路径把 /images/ 替换为 /labels/ 自动找标签（项目已满足同级约定）
        data_yaml = os.path.join(split_dir, "data.yaml")
        lines = [
            f"path: {project}",
            f"train: {train_txt}",
            f"val: {val_txt}",
            f"nc: {len(names)}",
            "names:",
        ]
        for i, n in enumerate(names):
            # 转义类名里的特殊字符，避免 YAML 解析问题
            safe = str(n).replace('"', '\\"')
            lines.append(f'  {i}: "{safe}"')
        with open(data_yaml, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return data_yaml

    @staticmethod
    def _read_classes(project):
        """读取 classes.txt，返回类名列表（行号 = class_id）。"""
        cf = os.path.join(project, "classes.txt")
        if not os.path.isfile(cf):
            return []
        for enc in ("utf-8-sig", "gbk", "utf-8"):
            try:
                with open(cf, "r", encoding=enc) as f:
                    return [ln.rstrip("\n") for ln in f if ln.strip()]
            except (UnicodeDecodeError, LookupError):
                continue
        return []

    # ===================== 启动训练 =====================

    def start(self, project, params, python_path):
        """启动训练子进程。

        params dict 应含：model, epochs, imgsz, batch, device, workers, name,
                          valRatio, exportOnnx, customParamsText, customParamsYaml
        返回 {"dataYaml": <path>}。出错抛异常交由路由层处理。
        """
        with self._lock:
            if self._state == "running":
                raise RuntimeError("已有训练在运行")
            if self._reader and self._reader.is_alive():
                raise RuntimeError("上一次训练仍在收尾，请稍候再试")

            name = (params.get("name") or "exp").strip() or "exp"
            runs_dir = os.path.join(project, "runs")
            result_path = os.path.join(project, ".dataset_split", f"train_result_{name}.json")
            self._reset_state()
            self._meta = {"name": name, "project": project, "runs_dir": runs_dir, "result_path": result_path}

        # 清除上次结果文件，避免读到旧结果
        try:
            if os.path.isfile(result_path):
                os.remove(result_path)
        except OSError:
            pass

        # 准备数据集（耗时 IO，在锁外执行）
        data_yaml = self.prepare_dataset(project, float(params.get("valRatio", DEFAULT_VAL_RATIO)))

        # 组装传给 runner 的参数
        base_kwargs = {}
        for k in ("epochs", "imgsz", "batch", "device", "workers"):
            if k in params and params[k] not in (None, ""):
                base_kwargs[k] = params[k]

        args = {
            "model": params["model"],
            "dataYaml": data_yaml,
            "runsDir": runs_dir,
            "name": name,
            "exportOnnx": bool(params.get("exportOnnx", False)),
            "baseKwargs": base_kwargs,
            "customParamsText": params.get("customParamsText", ""),
            "customParamsYaml": params.get("customParamsYaml", ""),
            "resultPath": result_path,
        }
        args_json = json.dumps(args, ensure_ascii=False)

        env = self._build_env(python_path)
        with self._lock:
            self._proc = subprocess.Popen(
                [python_path, "-u", RUNNER_PATH, args_json],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,                 # 二进制无缓冲，配合 read1 实时读取
                env=env,
                cwd=os.path.dirname(os.path.abspath(__file__)),
            )
            self._state = "running"
            self._error = ""
            self._result = None
            self._reader = threading.Thread(target=self._reader_loop, daemon=True)
            self._reader.start()

        self._broadcast(f"\n==== 训练已启动：{name}（模型 {params['model']}） ====\n")
        return {"dataYaml": data_yaml}

    def _build_env(self, python_path):
        """复用 detector._start_worker 的环境构建：PATH 前置外部 python 目录 + conda DLL 目录、清空 PYTHONPATH。"""
        env = {**os.environ, "PYTHONPATH": ""}
        py_dir = os.path.dirname(python_path)
        conda_dll = os.path.join(os.path.dirname(py_dir), "Library", "bin")  # conda 约定的 DLL 目录
        paths = env.get("PATH", "").split(os.pathsep)
        for d in (py_dir, conda_dll):
            if d and d not in paths:
                paths.insert(0, d)
        env["PATH"] = os.pathsep.join(paths)
        return env

    def _reader_loop(self):
        """后台线程：持续读子进程 stdout（stderr 已合流）→ 写 deque 历史 + 广播。EOF 后推断终态。"""
        proc = self._proc
        stream = proc.stdout if proc else None
        try:
            if stream is not None:
                while True:
                    # 二进制 read1：读到任何可用字节即返回（保留 \r 让 xterm 正确渲染进度条原地刷新）
                    chunk = stream.read1(4096)
                    if not chunk:
                        break
                    text = chunk.decode("utf-8", "replace")
                    self._buffer.append(text)
                    self._broadcast(text)
        except Exception:
            pass

        try:
            proc.wait()
        except Exception:
            pass
        self._finalize()

    def _finalize(self):
        """子进程结束后，根据返回码 + result.json 推断最终状态。"""
        with self._lock:
            proc = self._proc
            prev = self._state
            rc = proc.returncode if proc else -1

            if prev == "cancelled":
                pass  # stop() 已置为 cancelled，保持
            elif rc == 0:
                self._state = "done"
                self._result = self._read_result()
            else:
                self._state = "error"
                result = self._read_result()
                if result and result.get("error"):
                    self._error = result["error"]
                    self._result = result
                else:
                    self._error = f"训练进程异常退出（退出码 {rc}）"

        self._broadcast(self._state_summary())

    def _read_result(self):
        """读取 runner 写入的 result.json（成功含 weights/onnx，失败含 error/tb）。"""
        rp = self._meta.get("result_path")
        if rp and os.path.isfile(rp):
            try:
                with open(rp, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return None
        return None

    def _state_summary(self):
        """生成终态提示行，广播到终端。"""
        with self._lock:
            s, e, r = self._state, self._error, self._result
        if s == "done":
            extra = ""
            if r and r.get("weights"):
                extra = f"\n产物：{r['weights']}"
                if r.get("onnx"):
                    extra += f"\nONNX：{r['onnx']}"
            return f"\n==== 训练完成 ===={extra}\n"
        if s == "error":
            return f"\n==== 训练失败：{e} ====\n"
        if s == "cancelled":
            return "\n==== 训练已停止 ====\n"
        return ""

    # ===================== 停止训练 =====================

    def stop(self):
        """停止训练：先置 cancelled（避免 reader 把取消覆盖成 error），再 terminate→kill。"""
        with self._lock:
            proc = self._proc
            if not proc or self._state != "running":
                return {"ok": False, "error": "没有正在运行的训练"}
            self._state = "cancelled"
        try:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}

    # ===================== 导出产物 =====================

    def export_artifacts(self, project, name):
        """把训练产物（best.pt 及可选 onnx）复制到项目内 models/，返回 {dest, onnx}。"""
        # 优先从 result.json 拿 runner 记录的产物路径
        result_path = os.path.join(project, ".dataset_split", f"train_result_{name}.json")
        weights_src = onnx_src = None
        if os.path.isfile(result_path):
            try:
                with open(result_path, "r", encoding="utf-8") as f:
                    r = json.load(f)
                weights_src = r.get("weights")
                onnx_src = r.get("onnx")
            except Exception:
                pass

        # 兜底：在 runs/<name>/weights/ 下找
        if not weights_src or not os.path.isfile(weights_src):
            cand = glob.glob(os.path.join(project, "runs", name, "**", "best.pt"), recursive=True)
            if not cand:
                cand = glob.glob(os.path.join(project, "runs", "**", "best.pt"), recursive=True)
            if cand:
                weights_src = cand[0]
        if not weights_src or not os.path.isfile(weights_src):
            raise FileNotFoundError(f"找不到训练产物 best.pt，请确认实验名「{name}」训练已完成")

        models_dir = os.path.join(project, "models")
        os.makedirs(models_dir, exist_ok=True)
        dest_pt = os.path.join(models_dir, f"{name}.pt")
        shutil.copy2(weights_src, dest_pt)

        dest_onnx = None
        if not onnx_src or not os.path.isfile(onnx_src):
            cand = glob.glob(os.path.join(project, "runs", name, "**", "best.onnx"), recursive=True)
            if cand:
                onnx_src = cand[0]
        if onnx_src and os.path.isfile(onnx_src):
            dest_onnx = os.path.join(models_dir, f"{name}.onnx")
            shutil.copy2(onnx_src, dest_onnx)

        return {"dest": dest_pt, "onnx": dest_onnx}

    # ===================== 清理 =====================

    def _reset_state(self):
        self._state = "idle"
        self._error = ""
        self._result = None
        self._buffer.clear()

    def shutdown(self):
        """atexit：杀掉仍在运行的训练子进程，防残留。"""
        with self._lock:
            proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception:
                pass


# ===================== 全局单例 =====================

train_manager = TrainManager()
