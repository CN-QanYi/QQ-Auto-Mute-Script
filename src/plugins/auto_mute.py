import time
import math
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
        "threshold": 5
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
group_combo_counts = defaultdict(int)
# Group ID -> 上一次 Target User 发言的时间戳
group_last_activity_times = defaultdict(int)

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
