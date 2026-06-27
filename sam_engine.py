"""SAM 2 分割引擎（共享逻辑）。

供 worker.py（外部 Python 子进程）和 detector.py（进程内）复用，
避免分割逻辑在两处重复（参照 ONNX 解析在 worker/detector 重复的历史教训）。

依赖 sam2 + torch，均为懒加载（仅在调用时 import），
避免未安装该环境的进程在 import 本模块时失败。
"""

import os

# 模型变体 → HuggingFace model_id（from_pretrained 自动下载/缓存用）
SAM_VARIANTS = {
    "large": "facebook/sam2-hiera-large",
    "base_plus": "facebook/sam2-hiera-base_plus",
    "small": "facebook/sam2-hiera-small",
    "tiny": "facebook/sam2-hiera-tiny",
}

# 变体 → config 后缀（build_sam2 走本地 checkpoint 时用）
_CFG_SUFFIX = {"large": "l", "base_plus": "b+", "small": "s", "tiny": "t"}


def _config_candidates(variant):
    """本地 checkpoint 时尝试的 config 相对路径候选。

    sam2 包版本/安装方式不同，config 路径有差异（2.0 在 configs/sam2/，
    2.1 在 configs/sam2.1/），逐个尝试。
    """
    s = _CFG_SUFFIX.get(variant, "l")
    return [
        f"configs/sam2.1/sam2.1_hiera_{s}.yaml",
        f"configs/sam2/sam2_hiera_{s}.yaml",
        f"sam2.1_hiera_{s}.yaml",
        f"sam2_hiera_{s}.yaml",
    ]


class SamHolder:
    """SAM 2 image predictor 持有者，带 image embedding 缓存。"""

    def __init__(self):
        self.predictor = None
        self.variant = None
        self.device = "cpu"
        self._img_key = None  # 已计算 embedding 的图片键（path@mtime）

    @property
    def is_loaded(self):
        return self.predictor is not None

    def load(self, variant="large", checkpoint=""):
        """加载 SAM 2 模型。

        优先用本地 checkpoint（build_sam2，适合用户已下载的 .pt 如 sam2.1_hiera_large.pt），
        找不到匹配 config 或失败时回退 from_pretrained（自动下载到 HF 缓存，首次需联网）。
        """
        import torch
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        predictor = None
        last_err = None

        # 1) 本地权重：build_sam2（逐个尝试候选 config 路径）
        if checkpoint and os.path.isfile(checkpoint):
            try:
                from sam2.build_sam import build_sam2

                for cfg in _config_candidates(variant):
                    try:
                        model = build_sam2(cfg, checkpoint, device=self.device)
                        predictor = SAM2ImagePredictor(model)
                        break
                    except Exception as e:  # 该 config 不匹配，试下一个
                        last_err = e
            except Exception as e:  # build_sam2 不可用
                last_err = e

        # 2) 回退：from_pretrained（自动下载到 HF 缓存）
        if predictor is None:
            model_id = SAM_VARIANTS.get(variant, SAM_VARIANTS["large"])
            predictor = SAM2ImagePredictor.from_pretrained(model_id)
            # from_pretrained 默认可能不指定设备，手动迁移到目标设备
            if self.device != "cpu":
                try:
                    predictor.model.to(self.device)
                except Exception:
                    pass

        self.predictor = predictor
        self.variant = variant
        self._img_key = None

    def segment(self, image_path, points, labels):
        """对图片用点提示分割，返回最佳 mask 的归一化外接矩形。

        Args:
            image_path: 图片绝对路径
            points: [[px, py], ...] 像素坐标
            labels: [1, ...] 1=正点 0=负点
        Returns:
            {x, y, w, h, score}（归一化 0~1，左上角+宽高）或 None（无有效 mask）
        """
        import numpy as np
        from PIL import Image

        img = Image.open(image_path).convert("RGB")
        W, H = img.size

        # image embedding 缓存：同图连续点选只 set_image 一次（首次约 1-3s）
        key = f"{image_path}@{os.path.getmtime(image_path)}"
        if key != self._img_key:
            self.predictor.set_image(np.array(img))
            self._img_key = key

        masks, scores, _ = self.predictor.predict(
            point_coords=np.array(points, dtype=np.float32),
            point_labels=np.array(labels, dtype=np.int32),
            multimask_output=True,
        )
        best = int(np.argmax(scores))
        ys, xs = np.where(masks[best])
        if len(xs) == 0:
            return None
        x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
        if x2 <= x1 or y2 <= y1:
            return None
        return {
            "x": x1 / W,
            "y": y1 / H,
            "w": (x2 - x1) / W,
            "h": (y2 - y1) / H,
            "score": round(float(scores[best]) * 100),
        }

    def unload(self):
        """卸载模型，释放显存（predictor 置 None + 清 CUDA 缓存）。"""
        self.predictor = None
        self.variant = None
        self.device = "cpu"
        self._img_key = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()  # 释放 caching allocator 缓存的显存块
        except Exception:
            pass
