"""
配置验证器模块
提供配置文件导入的验证、修正和默认值填充功能。
可同时供后端 (webui.py) 和单元测试使用。
"""
import re
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# 配置字段定义
CONFIG_FIELDS = {
    "target_users": {"type": list, "default": [], "item_type": int},
    "threshold": {"type": int, "default": 5, "min": 0, "max": 100},
    "combo_timeout": {"type": int, "default": 180, "min": 1, "max": 3600},
}

SCHEDULED_MUTE_FIELDS = {
    "enabled": {"type": bool, "default": False},
    "cooldown": {"type": int, "default": 30, "min": 1, "max": 3600},
    "ranges": {"type": dict, "default": {"default": []}},
}

VALID_DAY_KEYS = {"default", "0", "1", "2", "3", "4", "5", "6"}
TIME_PATTERN = re.compile(r"^\d{2}:\d{2}$")


class ValidationResult:
    """单个群配置的验证结果"""

    def __init__(self, group_key: str):
        self.group_key = group_key
        self.valid = True
        self.config: Optional[Dict[str, Any]] = None
        self.warnings: List[str] = []
        self.errors: List[str] = []

    def add_warning(self, msg: str):
        self.warnings.append(msg)

    def add_error(self, msg: str):
        self.errors.append(msg)
        self.valid = False


class BatchValidationResult:
    """批量验证结果"""

    def __init__(self):
        self.results: Dict[str, ValidationResult] = {}
        self.valid_configs: Dict[str, Dict] = {}
        self.total = 0
        self.valid_count = 0
        self.fixed_count = 0
        self.error_count = 0

    @property
    def all_warnings(self) -> List[str]:
        warnings = []
        for key, r in self.results.items():
            for w in r.warnings:
                warnings.append(f"[{key}] {w}")
        return warnings

    @property
    def all_errors(self) -> List[str]:
        errors = []
        for key, r in self.results.items():
            for e in r.errors:
                errors.append(f"[{key}] {e}")
        return errors


def _safe_int(value: Any, default: int) -> Tuple[int, bool]:
    """安全转换为整数，返回 (值, 是否成功)"""
    if isinstance(value, int):
        return value, True
    if isinstance(value, float):
        return int(value), True
    if isinstance(value, str):
        try:
            return int(value), True
        except (ValueError, TypeError):
            return default, False
    return default, False


def _clamp(value: int, min_val: int, max_val: int) -> Tuple[int, bool]:
    """将值限制在范围内，返回 (值, 是否被修正)"""
    if value < min_val:
        return min_val, True
    if value > max_val:
        return max_val, True
    return value, False


def validate_time_range(time_range: Any) -> Optional[List[str]]:
    """验证单个时间段，返回修正后的时间段或 None"""
    if not isinstance(time_range, (list, tuple)):
        return None
    if len(time_range) != 2:
        return None
    start, end = time_range
    if not isinstance(start, str) or not isinstance(end, str):
        return None
    if not TIME_PATTERN.match(start) or not TIME_PATTERN.match(end):
        return None
    return [start, end]


def validate_group_config(key: str, cfg: Any) -> ValidationResult:
    """
    验证并修正单个群配置。
    - 检查类型正确性
    - 修正越界值
    - 填充缺失字段的默认值
    - 去除无效的 target_users 条目
    """
    result = ValidationResult(key)

    if not isinstance(cfg, dict):
        result.add_error("配置必须是对象类型")
        result.config = {
            "target_users": [],
            "threshold": 5,
            "combo_timeout": 180,
            "scheduled_mute": {"enabled": False, "cooldown": 30, "ranges": {"default": []}},
        }
        return result

    config = {}

    # === target_users ===
    if "target_users" in cfg:
        if not isinstance(cfg["target_users"], list):
            result.add_error("target_users 必须是数组")
            config["target_users"] = []
        else:
            valid_users = []
            seen = set()
            for u in cfg["target_users"]:
                num, ok = _safe_int(u, -1)
                if ok and num > 0:
                    if num not in seen:
                        seen.add(num)
                        valid_users.append(num)
                else:
                    result.add_warning(f"target_users 中的无效值 {u!r} 已忽略")
            config["target_users"] = valid_users
            if len(valid_users) != len(cfg["target_users"]):
                result.add_warning(
                    f"target_users 已自动去重/修正（{len(cfg['target_users'])} → {len(valid_users)}）"
                )
    else:
        config["target_users"] = []
        result.add_warning("缺少 target_users 字段，已使用默认值 []")

    # === threshold ===
    if "threshold" in cfg:
        val, ok = _safe_int(cfg["threshold"], 5)
        if not ok:
            result.add_error("threshold 必须是数字")
            config["threshold"] = 5
        else:
            clamped, was_clamped = _clamp(val, 0, 100)
            if was_clamped:
                result.add_warning(f"threshold 值 {val} 超出范围 (0-100)，已修正为 {clamped}")
            config["threshold"] = clamped
    else:
        config["threshold"] = 5
        result.add_warning("缺少 threshold 字段，已使用默认值 5")

    # === combo_timeout ===
    if "combo_timeout" in cfg:
        val, ok = _safe_int(cfg["combo_timeout"], 180)
        if not ok:
            result.add_error("combo_timeout 必须是数字")
            config["combo_timeout"] = 180
        else:
            clamped, was_clamped = _clamp(val, 1, 3600)
            if was_clamped:
                result.add_warning(f"combo_timeout 值 {val} 超出范围 (1-3600)，已修正为 {clamped}")
            config["combo_timeout"] = clamped
    else:
        config["combo_timeout"] = 180
        result.add_warning("缺少 combo_timeout 字段，已使用默认值 180")

    # === scheduled_mute ===
    if "scheduled_mute" in cfg:
        sm = cfg["scheduled_mute"]
        if not isinstance(sm, dict):
            result.add_error("scheduled_mute 必须是对象")
            config["scheduled_mute"] = {"enabled": False, "cooldown": 30, "ranges": {"default": []}}
        else:
            sm_config = {}

            # enabled
            sm_config["enabled"] = bool(sm.get("enabled", False))

            # cooldown
            if "cooldown" in sm:
                val, ok = _safe_int(sm["cooldown"], 30)
                if ok:
                    clamped, was_clamped = _clamp(val, 1, 3600)
                    if was_clamped:
                        result.add_warning(f"scheduled_mute.cooldown 值 {val} 已修正为 {clamped}")
                    sm_config["cooldown"] = clamped
                else:
                    sm_config["cooldown"] = 30
                    result.add_warning("scheduled_mute.cooldown 不是有效数字，已使用默认值 30")
            else:
                sm_config["cooldown"] = 30

            # ranges
            if "ranges" in sm and isinstance(sm["ranges"], dict):
                valid_ranges = {}
                for day_key, day_ranges in sm["ranges"].items():
                    if str(day_key) not in VALID_DAY_KEYS:
                        result.add_warning(f'scheduled_mute.ranges 中的无效键 "{day_key}" 已忽略')
                        continue
                    if not isinstance(day_ranges, list):
                        result.add_warning(f'scheduled_mute.ranges["{day_key}"] 不是数组，已忽略')
                        continue
                    valid_day_ranges = []
                    for r in day_ranges:
                        validated = validate_time_range(r)
                        if validated:
                            valid_day_ranges.append(validated)
                        else:
                            result.add_warning(f"时间段格式无效 {r!r}，已忽略")
                    if valid_day_ranges or str(day_key) == "default":
                        valid_ranges[str(day_key)] = valid_day_ranges
                if "default" not in valid_ranges:
                    valid_ranges["default"] = []
                sm_config["ranges"] = valid_ranges
            else:
                sm_config["ranges"] = {"default": []}
                if "ranges" in sm:
                    result.add_warning("scheduled_mute.ranges 格式无效，已重置")

            config["scheduled_mute"] = sm_config
    else:
        config["scheduled_mute"] = {"enabled": False, "cooldown": 30, "ranges": {"default": []}}
        result.add_warning("缺少 scheduled_mute 字段，已使用默认配置")

    result.config = config
    return result


def validate_import_config(configs: Dict[str, Any]) -> BatchValidationResult:
    """
    批量验证导入配置。
    对每个群配置进行字段检查、类型校验、范围修正和默认值填充。
    """
    batch = BatchValidationResult()
    batch.total = len(configs)

    for key, cfg in configs.items():
        r = validate_group_config(key, cfg)
        batch.results[key] = r

        if r.config is not None:
            batch.valid_configs[key] = r.config
            batch.valid_count += 1
            if r.warnings:
                batch.fixed_count += 1
        if r.errors:
            batch.error_count += 1

    return batch
