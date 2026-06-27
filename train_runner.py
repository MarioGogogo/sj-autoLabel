"""训练执行脚本（由配置的外部 Python 解释器直接运行）。

由 train_manager.start 通过 `subprocess.Popen([python_path, "-u", __file__, args_json])` 启动。
职责：
- 解析命令行 args_json，合并训练参数（基础 < key=value 文本 < yaml 文件）
- 调用 ultralytics YOLO(model).train(...) 训练；可选 m.export(format="onnx") 导出 ONNX
- 把产物路径写入 result.json（train_manager 据此更新状态、供「导出模型」按钮读取）
- 训练过程中的所有 stdout/stderr 由 train_manager 的 reader 线程捕获并实时推送到前端 xterm

注意：本脚本运行在「外部 Python 环境」（有 torch + ultralytics + pyyaml），不依赖主进程的 venv。
"""

import glob
import json
import os
import sys


def _coerce(v):
    """把字符串值尝试转 bool/int/float/None/str（自定义参数 key=value 的值类型推断）。"""
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("none", "null"):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    # 去首尾配对引号
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v


def parse_kv(text):
    """解析「每行 key=value」的自定义参数文本，返回 dict。"""
    result = {}
    if not text:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k:
            result[k] = _coerce(v.strip())
    return result


def write_result(path, data):
    """把结果（产物路径 / 错误信息）写入 result.json，供 train_manager 读取。"""
    if not path:
        return
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


class UnbufferedWriter:
    """自动 flush 写入包装器，确保任何库（包括 ultralytics、tqdm、logging）写出的字符实时刷入管道。"""
    def __init__(self, stream):
        self.stream = stream
    def write(self, data):
        self.stream.write(data)
        self.stream.flush()
    def writelines(self, datas):
        self.stream.writelines(datas)
        self.stream.flush()
    def __getattr__(self, attr):
        return getattr(self.stream, attr)


def main(args):
    # 强制将 sys.stdout / sys.stderr 升级为无缓冲流
    sys.stdout = UnbufferedWriter(sys.stdout)
    sys.stderr = UnbufferedWriter(sys.stderr)

    # 重新配置标准输出编码，确保在 Windows 终端和管道下正常输出 utf-8 彩色字符
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    # 合并训练参数：基础控件 < 文本框 key=value < yaml 文件（后者覆盖前者同名键）
    final = {}
    final.update(args.get("baseKwargs", {}))
    final.update(parse_kv(args.get("customParamsText", "")))
    yaml_text = args.get("customParamsYaml", "") or ""
    if yaml_text.strip():
        import yaml  # 外部环境随 ultralytics 自带 pyyaml
        yd = yaml.safe_load(yaml_text)
        if isinstance(yd, dict):
            final.update(yd)
    # data / project / name 由 runner 注入（不暴露给自定义参数覆盖）
    final["data"] = args["dataYaml"]
    final["project"] = args["runsDir"]
    final["name"] = args["name"]
    # 默认开启详细日志输出，确保完整打印模型结构、硬件信息和每个 epoch 的损失/指标明细
    final.setdefault("verbose", True)

    print(f"训练参数：{json.dumps(final, ensure_ascii=False, default=str)}", flush=True)

    from ultralytics import YOLO

    m = YOLO(args["model"])
    m.train(**final)


    # 推导 best.pt 实际输出路径（兼容不同 ultralytics 版本的目录组织）
    save_dir = None
    trainer = getattr(m, "trainer", None)
    if trainer is not None:
        save_dir = getattr(trainer, "save_dir", None)
    if not save_dir:
        save_dir = os.path.join(final["project"], final["name"])
    weights = os.path.abspath(os.path.join(str(save_dir), "weights", "best.pt"))
    if not os.path.isfile(weights):
        cand = glob.glob(os.path.join(args["runsDir"], "**", "best.pt"), recursive=True)
        if cand:
            weights = os.path.abspath(cand[0])

    # 可选导出 ONNX（勾选了才执行）
    onnx = None
    if args.get("exportOnnx"):
        try:
            onnx = os.path.abspath(m.export(format="onnx"))
        except Exception as e:
            print(f"\n⚠️ ONNX 导出失败：{e}", flush=True)

    write_result(args["resultPath"], {"status": "done", "weights": weights, "onnx": onnx})
    print(f"\n训练完成：{weights}" + (f"\nONNX：{onnx}" if onnx else ""), flush=True)


if __name__ == "__main__":
    print("\x1b[1;32m[RUNNER] 训练子进程建立成功，准备加载 YOLO...\x1b[0m", flush=True)
    if len(sys.argv) < 2:
        print("用法：python train_runner.py <args_json_or_file>", file=sys.stderr, flush=True)
        sys.exit(2)

    raw_arg = sys.argv[1]
    args = None
    try:
        if os.path.isfile(raw_arg):
            with open(raw_arg, "r", encoding="utf-8") as f:
                args = json.load(f)
        else:
            args = json.loads(raw_arg)
    except Exception as e:
        print(f"参数解析失败：{e}", file=sys.stderr, flush=True)
        sys.exit(2)

    try:
        main(args)
    except Exception as e:
        import traceback

        tb = traceback.format_exc()
        print(tb, flush=True)  # 完整 traceback 推送到前端 xterm，便于排错
        if isinstance(args, dict):
            write_result(args.get("resultPath", ""), {"status": "error", "error": str(e), "tb": tb})
        sys.exit(1)
