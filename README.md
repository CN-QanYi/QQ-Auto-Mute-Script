# QQ 自动禁言脚本

基于 [NoneBot2](https://github.com/nonebot/nonebot2) + OneBot V11 的 QQ 群自动禁言机器人，内置可视化 WebUI 配置面板。

## 功能特性

### 连击惩罚机制

- **多群独立配置** — 每个群拥有独立的监控名单、触发阈值和连击计数池
- **阶梯式禁言** — 连续触发时禁言时长递增（1 → 2 → 3 → 5 → 7 → 10 → 13 → 17 → 21 分钟…），超出预设等级后自动叠加
- **打断重置** — 非名单用户发言，该群连击计数立即归零
- **超时重置** — 名单用户超过 `combo_timeout`（默认 180 秒）未发言，连击计数归零

### 定时禁言

- 可按 **星期** 设置不同的禁言时间段（支持 `default` 回退 + 周一至周日独立配置）
- 支持跨夜时间段（如 `23:00` → `07:00`）
- 时间段内任一名单用户发言 → **全体名单用户** 被禁言至该时段结束
- 冷却时间控制，防止重复触发

### WebUI 配置面板

启动机器人后访问 `http://127.0.0.1:8080/webui` 即可使用：

- **群组管理** — 自动读取机器人所在的群列表
- **成员选择** — 群成员列表（头像 + 昵称 + QQ 号），点击即可加入/移除监控名单
- **搜索过滤** — 支持按昵称、群名片或 QQ 号搜索成员
- **策略配置** — 触发阈值（0–100）、连击超时（1–3600 秒）、冷却时间（1–3600 秒）
- **时间段管理** — 星期选项卡切换，有配置的星期显示圆点标记，动态添加/删除时间段
- **热重载** — 保存后立即生效，无需重启机器人
- **API 认证** — 可选的 `WEBUI_API_KEY` 保护，使用 `hmac.compare_digest` 防止时序攻击
- **原子化保存** — 配置写入采用 `tmpfile` + `fsync` + `rename` 确保不丢数据

## 快速开始

### 1. 安装依赖

确保已安装 [uv](https://github.com/astral-sh/uv)：

```bash
uv venv
uv pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并按需修改：

```env
HOST=127.0.0.1        # 监听地址
PORT=8080             # 监听端口（NoneBot + WebUI 共用）
LOG_LEVEL=INFO
COMMAND_START=["/"]
WEBUI_API_KEY=         # WebUI API 密钥（留空禁用认证）
```

> ⚠️ 将 `HOST` 设为 `0.0.0.0` 或暴露到公网时，**必须** 设置 `WEBUI_API_KEY`。

### 3. 连接机器人

配合 NapCatQQ / LLOneBot / Lagrange 等工具，添加 **反向 WebSocket** 连接：

- **URL**：`ws://127.0.0.1:8080/onebot/v11/ws`
- **Token**：留空

### 4. 启动

```bash
uv run bot.py
```

日志出现 `OneBot V11 | Bot ... connected` 即连接成功，访问 `http://127.0.0.1:8080/webui` 进行配置。

## 配置文件

所有配置保存在根目录 `config.json`（参考 `config.example.json`）：

```jsonc
{
    "群号": {
        "target_users": [111111111, 222222222],  // 监控名单（QQ 号）
        "threshold": 5,                          // 第几条消息触发禁言
        "combo_timeout": 180,                    // 连击超时（秒）
        "scheduled_mute": {
            "enabled": false,
            "cooldown": 30,                      // 冷却时间（秒）
            "ranges": {
                "default": [["23:00", "07:00"]], // 默认时间段
                "5": [["22:00", "08:00"]],       // 周五
                "6": [["22:00", "08:00"]]        // 周六
            }
        }
    }
}
```

## 注意事项

- 机器人 QQ 必须是 **群管理员或群主**，否则无法执行禁言
- 禁言阶梯可在 `src/plugins/auto_mute.py` 中修改 `MUTE_LEVELS` 自定义
- 密钥建议使用至少 32 位随机字符串，不要提交到版本控制

## 依赖

| 包 | 版本 |
|---|------|
| `nonebot2[fastapi]` | ≥ 2.4.0 |
| `nonebot-adapter-onebot` | ≥ 2.4.0 |
