import time
import math
from datetime import datetime
from collections import deque, defaultdict
from nonebot import on_message
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent

# === 配置区域 ===
# 群组配置：为不同群设置不同的监控名单和阈值
# 只要不在这个列表里的群，都不会被监控
GROUP_CONFIGS = {
    # 示例:
    # 群号: {
    #     "target_users": [名单用户列表],
    #     "threshold": 触发禁言的消息数量
    # }
    # === 群号 111222 ===
    111222: {
        # 该群的监控名单（刷屏的人）
        "target_users": [12345678, 87654321, 111111],
        # 几句开始触发禁言（默认5句以后，即第6句开始）
        "threshold": 5,
        # 定时禁言配置
        "scheduled_mute": {
            "enabled": False,     # 是否开启定时禁言
            "cooldown": 30,       # 冷却时间（秒），防止刷屏调用API
            "ranges": [           # 时间段列表
                ("23:00", "07:00"), # 跨夜：晚上11点到早上7点
                ("12:00", "13:30")  # 午休
            ]
        }
    },

    # === 群号 333444 (另一个群) ===
    333444: {
        "target_users": [99999],
        "threshold": 3  # 这个群严格一点，3句就禁言
    }
}

# 阶梯式禁言连击判定时间（秒）
# 如果名单内用户发言间隔超过这个时间，禁言等级重置
COMBO_TIMEOUT = 180  # 3分钟

# 阶梯式禁言时长配置（单位：分钟）
MUTE_LEVELS = [1, 2, 3, 5, 7, 10, 13, 17, 21]
# ===============

# 全局状态变量 (使用 defaultdict 自动处理新群)
# Group ID -> 当前连续的名单用户发言数量
# Group ID -> 当前连续的名单用户发言数量
group_combo_counts = defaultdict(int)
# Group ID -> 上一次 Target User 发言的时间戳
group_last_activity_times = defaultdict(int)
# Group ID -> 上一次执行定时禁言的时间戳
group_last_schedule_enforcement_times = defaultdict(int)

def parse_time(time_str):
    """解析 "HH:MM" 格式的时间字符串为 (hour, minute)"""
    try:
        t = datetime.strptime(time_str, "%H:%M").time()
        return t.hour, t.minute
    except ValueError:
        return None

def check_scheduled_mute(current_dt, ranges):
    """
    检查当前时间是否在设定范围内
    返回: (是否在范围内, 剩余禁言时长(秒))
    """
    now_time = current_dt.time()
    current_minutes = now_time.hour * 60 + now_time.minute
    
    max_duration = 0
    in_range = False
    
    for start_str, end_str in ranges:
        start_time = parse_time(start_str)
        end_time = parse_time(end_str)

        if start_time is None or end_time is None:
            print(f"Skipping invalid time range: {start_str} - {end_str}")
            continue

        start_h, start_m = start_time
        end_h, end_m = end_time
        
        start_minutes = start_h * 60 + start_m
        end_minutes = end_h * 60 + end_m
        
        # 计算该时间段是否包含当前时间
        is_current_in = False
        duration = 0
        
        if start_minutes <= end_minutes:
            # 同一天的时间段 (e.g. 12:00 - 13:00)
            if start_minutes <= current_minutes < end_minutes:
                is_current_in = True
                duration = (end_minutes - current_minutes) * 60
        else:
            # 跨夜时间段 (e.g. 23:00 - 07:00)
            # 23:00 - 24:00 (当天) OR 00:00 - 07:00 (次日)
            if current_minutes >= start_minutes:
                # 在前半段 (e.g. 23:30)
                is_current_in = True
                # 剩余时间 = (24*60 - current) + end
                duration = ((24 * 60 - current_minutes) + end_minutes) * 60
            elif current_minutes < end_minutes:
                # 在后半段 (e.g. 06:00)
                is_current_in = True
                duration = (end_minutes - current_minutes) * 60
        
        if is_current_in:
            in_range = True
            # 取最长的剩余时间（防止重叠时间段问题）
            if duration > max_duration:
                max_duration = duration
                
    return in_range, max_duration

# 注册消息事件响应器
monitor_msg = on_message(priority=10, block=False)

@monitor_msg.handle()
async def handle_msg(bot: Bot, event: GroupMessageEvent):
    # Determine config for this group
    group_id = event.group_id
    if group_id not in GROUP_CONFIGS:
        return # Not monitored

    config = GROUP_CONFIGS[group_id]
    target_users = config["target_users"]
    threshold = config["threshold"]

    user_id = event.user_id
    current_time = time.time()
    current_dt = datetime.now()
    
    # === 逻辑分支 0：定时禁言检查 ===
    # 只要有人说话，就检查是否需要触发定时全员禁言
    scheduled_config = config.get("scheduled_mute", {})
    if scheduled_config.get("enabled", False):
        ranges = scheduled_config.get("ranges", [])
        is_in_time, duration = check_scheduled_mute(current_dt, ranges)
        
        if is_in_time:
            # 冷却检查
            cooldown = scheduled_config.get("cooldown", 30)
            last_enforce = group_last_schedule_enforcement_times[group_id]
            
            if current_time - last_enforce > cooldown:
                print(f"群 {group_id} 触发定时禁言及实施对象，冷却已就绪。剩余时长: {duration}秒")
                # 对名单内所有用户执行禁言
                for target_uid in target_users:
                    try:
                        await bot.set_group_ban(
                            group_id=group_id,
                            user_id=target_uid,
                            duration=int(duration)
                        )
                    except Exception as e:
                        print(f"定时禁言执行失败 (User {target_uid}): {e}")
                
                # 更新最后执行时间
                group_last_schedule_enforcement_times[group_id] = current_time
            else:
                # 冷却中，跳过
                pass
    
    # === 逻辑分支 1：非名单用户 ===
    if user_id not in target_users:
        # 只要有非名单用户发言，直接重置该群的连击
        if group_combo_counts[group_id] > 0:
            print(f"群 {group_id} 非名单用户 {user_id} 发言，打断连击。")
            group_combo_counts[group_id] = 0
            group_last_activity_times[group_id] = 0
        return

    # === 逻辑分支 2：名单用户 ===
    
    # 检查是否超时
    last_time = group_last_activity_times[group_id]
    if last_time > 0 and (current_time - last_time > COMBO_TIMEOUT):
        print(f"群 {group_id} 名单用户发言间隔超过 3 分钟，重置连击计数。")
        group_combo_counts[group_id] = 0

    # 更新状态
    group_last_activity_times[group_id] = current_time
    group_combo_counts[group_id] += 1
    
    current_count = group_combo_counts[group_id]
    
    # 检查是否达到惩罚触发点
    if current_count > threshold:
        try:
            # 计算当前禁言等级
            current_level = current_count - threshold
            
            # 计算时长
            if current_level <= len(MUTE_LEVELS):
                mute_minutes = MUTE_LEVELS[current_level - 1]
            else:
                # 超过列表范围，执行自动叠加算法
                mute_minutes = MUTE_LEVELS[-1]
                for i in range(len(MUTE_LEVELS) + 1, current_level + 1):
                    # 增量
                    increment = math.ceil((i - 1) / 2)
                    mute_minutes += int(increment)
            
            mute_seconds = mute_minutes * 60
            
            # 执行禁言
            await bot.set_group_ban(
                group_id=event.group_id,
                user_id=user_id,
                duration=mute_seconds
            )
            
            # 记录日志
            print(f"触发第 {current_level} 级连击禁言：{mute_minutes} 分钟。")
            
        except Exception as e:
            print(f"禁言失败: {e}")
