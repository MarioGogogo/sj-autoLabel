"""训练核心默认参数（单一数据源）。

本模块只含纯数据（dict / list），无任何第三方依赖，因此主进程 venv 与外部
yolo 环境（train_runner.py 运行处）都能 import 它，保证「弹窗展示的参数」与
「实际注入 m.train(**final) 的参数」永远一致，不会脱节。

覆盖优先级（见 train_runner.py）：
    CORE_DEFAULTS  <  右侧面板基础控件(baseKwargs)  <  自定义参数框(key=value)  <  yaml 文件

注意：epochs / imgsz / batch / device / workers 故意不在 CORE_DEFAULTS 中——
这几项由右侧面板控件控制（默认值不变），核心默认只固化「右侧面板没有」的高级超参数。
data / project / name 由 train_runner 注入，同样不放这里。
"""

# ===================== 核心默认参数（注入训练的实际值） =====================
# 来源：针对本项目「闪白小目标 + 稀缺类」精调的方案。
# 剔除：epochs/imgsz/batch/device/workers（右侧面板）、data/project/name（runner 注入）。
CORE_DEFAULTS = {
    # 输出
    "save": True,
    "save_period": 25,
    "verbose": True,
    "plots": True,

    # 学习控制
    "patience": 50,                 # 给稀缺类充足学习时间
    "lr0": 0.001,
    "lrf": 0.0001,                  # final_lr ≈ 1e-7，后期精细收敛到闪白细节
    "momentum": 0.937,
    "weight_decay": 0.0005,
    "warmup_epochs": 5,
    "warmup_momentum": 0.8,
    "warmup_bias_lr": 0.1,
    "optimizer": "AdamW",

    # 损失权重：cls 回归 1.0，不惩罚闪白
    "box": 0.05,
    "cls": 1.0,
    "dfl": 1.5,

    # 训练时验证阈值：低 conf 保召回
    "conf": 0.001,
    "iou": 0.7,

    # 数据增强：适度增强，重点给稀缺闪白帧增样
    "hsv_h": 0.01,
    "hsv_s": 0.4,
    "hsv_v": 0.3,
    "degrees": 5.0,
    "translate": 0.05,
    "scale": 0.3,
    "shear": 1.0,
    "perspective": 0.0,
    "flipud": 0.0,
    "fliplr": 0.5,
    "mosaic": 0.7,                  # 给小目标 / 稀有类增样
    "mixup": 0.1,
    "copy_paste": 0.1,              # 若 ultralytics 报 copy_paste 相关错，改成 0.0
    "close_mosaic": 20,

    # 其他
    "rect": False,
    "single_cls": False,
    "cache": "ram",                 # 小数据集内存缓存没问题；大数据集可改 'disk' 或 False
}


# ===================== 分组元数据（供弹窗渲染，key 必须与 CORE_DEFAULTS 一一对应） =====================
CORE_PARAM_GROUPS = [
    {
        "title": "输出与记录",
        "items": [
            {"key": "save", "note": "是否保存检查点"},
            {"key": "save_period", "note": "每 N 个 epoch 存一次（0=只存 last/best）"},
            {"key": "verbose", "note": "详细日志"},
            {"key": "plots", "note": "训练结束后生成训练曲线 / 混淆矩阵等图"},
        ],
    },
    {
        "title": "学习控制",
        "items": [
            {"key": "patience", "note": "早停耐心值（验证指标无改善的 epoch 数），给稀缺类充足学习时间"},
            {"key": "optimizer", "note": "优化器"},
            {"key": "lr0", "note": "初始学习率"},
            {"key": "lrf", "note": "最终学习率 = lr0 × lrf，后期精细收敛"},
            {"key": "momentum", "note": "动量"},
            {"key": "weight_decay", "note": "权重衰减（L2 正则）"},
            {"key": "warmup_epochs", "note": "预热 epoch 数"},
            {"key": "warmup_momentum", "note": "预热初始动量"},
            {"key": "warmup_bias_lr", "note": "预热偏置初始学习率"},
        ],
    },
    {
        "title": "损失权重",
        "items": [
            {"key": "box", "note": "框回归损失权重（降低，不压制分类）"},
            {"key": "cls", "note": "分类损失权重（提高，强化闪白识别）"},
            {"key": "dfl", "note": "Distribution Focal Loss 权重"},
        ],
    },
    {
        "title": "训练时验证阈值",
        "items": [
            {"key": "conf", "note": "置信度阈值（极低，保召回）"},
            {"key": "iou", "note": "NMS 的 IoU 阈值"},
        ],
    },
    {
        "title": "数据增强",
        "items": [
            {"key": "hsv_h", "note": "色调抖动"},
            {"key": "hsv_s", "note": "饱和度抖动"},
            {"key": "hsv_v", "note": "明度抖动"},
            {"key": "degrees", "note": "旋转角度（°）"},
            {"key": "translate", "note": "平移比例"},
            {"key": "scale", "note": "缩放比例"},
            {"key": "shear", "note": "剪切角度（°）"},
            {"key": "perspective", "note": "透视变换"},
            {"key": "flipud", "note": "上下翻转概率"},
            {"key": "fliplr", "note": "左右翻转概率"},
            {"key": "mosaic", "note": "Mosaic 拼接概率（小目标 / 稀有类增样）"},
            {"key": "mixup", "note": "MixUp 混合概率"},
            {"key": "copy_paste", "note": "复制粘贴增强（报错可改 0.0）"},
            {"key": "close_mosaic", "note": "最后 N 个 epoch 关闭 Mosaic，精细收敛"},
        ],
    },
    {
        "title": "其他",
        "items": [
            {"key": "rect", "note": "矩形训练（保持原图比例，这里关闭）"},
            {"key": "single_cls", "note": "单类训练模式"},
            {"key": "cache", "note": "数据缓存：ram/disk/False"},
        ],
    },
]


# epochs / imgsz / batch / device / workers 由右侧面板控制，弹窗里单列说明用。
BASIC_PARAM_HINT = "epochs / imgsz / batch / device / workers 由右侧「训练参数」面板控制；"
COVERAGE_NOTE = (
    "以上为核心默认参数（已生效）。右侧面板基础参数与「自定义参数」框（key=value）"
    "可覆盖其中任意一项，同名键后者覆盖前者。"
)


# ===================== 预设方案（训练参数起点） =====================
# 每个预设含展示用元数据 + 完整 params（与 CORE_DEFAULTS 同 key 体系）。
# train_runner 按「选中预设」的 params 作为合并起点（替代单一 CORE_DEFAULTS）。
# params 在模块加载时即展开为完整 dict，主进程与外部 runner import 同一份，绝不脱节。
PRESETS = [
    {
        "id": "small_target",
        "name": "闪白小目标·精修",
        "recommended": True,
        "icon": "target",
        "tags": ["小目标增强", "稀缺类", "强增样"],
        "desc": "针对闪白小目标与稀缺类别精调：高强度数据增强 + 低学习率精细收敛，最大化召回。",
        "params": dict(CORE_DEFAULTS),  # = 当前精调方案
    },
    {
        "id": "balanced",
        "name": "均衡通用",
        "recommended": False,
        "icon": "balance",
        "tags": ["通用", "稳健", "适中增强"],
        "desc": "适中数据增强与标准超参，适合数据量正常、类别均衡的常规检测场景，训练稳定。",
        "params": {**CORE_DEFAULTS, **{  # 相对精修的温和变体
            "mosaic": 1.0, "mixup": 0.0, "copy_paste": 0.0, "close_mosaic": 10,
            "patience": 30, "degrees": 0.0, "translate": 0.1, "scale": 0.5,
            "hsv_s": 0.7, "hsv_v": 0.4,
        }},
    },
    {
        "id": "fast",
        "name": "快速基线",
        "recommended": False,
        "icon": "bolt",
        "tags": ["快速", "低资源", "试参"],
        "desc": "轻量增强 + 稍大学习率，快速跑通基线验证，适合调参探索与低配环境。",
        "params": {**CORE_DEFAULTS, **{  # 轻量快速变体
            "mosaic": 1.0, "mixup": 0.0, "copy_paste": 0.0, "close_mosaic": 10,
            "patience": 20, "lr0": 0.002, "warmup_epochs": 3,
            "degrees": 0.0, "scale": 0.4, "hsv_s": 0.5,
        }},
    },
]

DEFAULT_PRESET_ID = "small_target"


def get_preset_params(preset_id):
    """按 id 取预设 params；无效 id 兜底返回 CORE_DEFAULTS（永不报错）。"""
    for p in PRESETS:
        if p["id"] == preset_id:
            return dict(p["params"])
    return dict(CORE_DEFAULTS)


def get_preset_meta(preset_id):
    """按 id 取预设元数据；无效返回 None。"""
    for p in PRESETS:
        if p["id"] == preset_id:
            return p
    return None
