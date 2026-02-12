import hmac
import json
import os
import shutil
import glob
import re
import hashlib
import tempfile
import logging
import asyncio
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List, Set
from functools import wraps
from urllib.parse import quote as url_quote

from nonebot import get_driver, get_bot
from nonebot.adapters.onebot.v11 import Bot
from fastapi import FastAPI, HTTPException, Depends, Request, Header, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 导入共享验证器
from src.utils.config_validator import validate_import_config as validate_import_batch

# 日志配置
logger = logging.getLogger(__name__)

# 配置文件路径
CONFIG_PATH = Path(__file__).parent.parent.parent / "config.json"
STATIC_PATH = Path(__file__).parent.parent / "static"
BACKUP_DIR = Path(__file__).parent.parent.parent / "backups"

# API 密钥（从环境变量获取，默认为空字符串表示禁用认证）
API_KEY = os.environ.get("WEBUI_API_KEY", "")

# 获取 NoneBot 驱动（用于生命周期钩子）
driver = get_driver()

# === 启动安全检查 ===
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
_nonebot_host = str(getattr(driver.config, "host", "127.0.0.1"))
_nonebot_port = int(getattr(driver.config, "port", 8080))

if not API_KEY:
    if _nonebot_host not in _LOCAL_HOSTS:
        logger.critical(
            "\n"
            "====================================================\n"
            "  ⛔ 安全错误: WEBUI_API_KEY 未设置!\n"
            "  NoneBot 绑定地址为 '%s' (非本地)，\n"
            "  端口 %d 上的 WebUI API 将在无认证的情况下暴露。\n"
            "  请在 .env 中设置 WEBUI_API_KEY 后重启。\n"
            "====================================================\n",
            _nonebot_host, _nonebot_port
        )
        sys.exit(1)
    else:
        logger.warning(
            "\n"
            "====================================================\n"
            "  ⚠️  安全警告: WEBUI_API_KEY 为空, 认证已禁用!\n"
            "  WebUI (端口 %d) 的 API 接口可被任何人访问。\n"
            "  建议在 .env 中设置 WEBUI_API_KEY。\n"
            "  当前仅绑定本地地址 '%s'，风险较低。\n"
            "====================================================\n",
            _nonebot_port, _nonebot_host
        )

# 创建独立的 WebUI FastAPI 应用
webui_app = FastAPI(title="QQ Auto Mute WebUI")

# === WebSocket / SSE 实时推送 ===
ws_clients: Set[WebSocket] = set()
sse_queues: List[asyncio.Queue] = []


async def broadcast_event(event_type: str, data: Any = None):
    """广播事件到所有已连接的 WebSocket 和 SSE 客户端"""
    message = json.dumps({"type": event_type, "data": data}, ensure_ascii=False)

    # WebSocket 广播（快照迭代，避免并发修改）
    disconnected = set()
    for ws in list(ws_clients):
        try:
            await ws.send_text(message)
        except Exception:
            disconnected.add(ws)
    ws_clients.difference_update(disconnected)

    # SSE 广播（快照迭代，避免并发修改）
    dead_queues = []
    for q in list(sse_queues):
        try:
            q.put_nowait({"event": event_type, "data": data})
        except Exception:
            dead_queues.append(q)
    for q in dead_queues:
        try:
            sse_queues.remove(q)
        except ValueError:
            pass

# 挂载静态文件
if STATIC_PATH.exists():
    webui_app.mount("/static", StaticFiles(directory=str(STATIC_PATH)), name="static")


# === 认证依赖 ===
async def verify_api_key(x_api_key: Optional[str] = Header(None)):
    """验证 API 密钥"""
    # 如果未配置 API_KEY，则禁用认证
    if not API_KEY:
        return True
    
    if not x_api_key or not hmac.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="未授权：无效的 API 密钥")
    return True


# === Pydantic 模型 ===
class ScheduledMuteConfig(BaseModel):
    enabled: bool = False
    cooldown: int = 30
    ranges: Dict[str, List[List[str]]] = {"default": []}


class GroupConfig(BaseModel):
    target_users: List[int] = []
    threshold: int = 5
    combo_timeout: int = 180
    scheduled_mute: ScheduledMuteConfig = ScheduledMuteConfig()


# === 配置文件操作 ===
def load_config() -> Dict[str, Any]:
    """加载配置文件"""
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"加载配置失败: {e}")
            return {}
    return {}


def save_config(config: Dict[str, Any]) -> bool:
    """原子化保存配置文件"""
    try:
        # 在同一目录下创建临时文件
        config_dir = CONFIG_PATH.parent
        fd, temp_path = tempfile.mkstemp(suffix=".json", dir=config_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=4)
                f.flush()
                os.fsync(f.fileno())
            # 原子替换
            os.replace(temp_path, CONFIG_PATH)
            return True
        except Exception:
            # 清理临时文件
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise
    except Exception as e:
        logger.error(f"保存配置失败: {e}")
        return False


# === API 路由（注册到独立的 webui_app）===
@webui_app.get("/", response_class=HTMLResponse)
async def webui_page():
    """返回 WebUI 页面（根路径直接访问）"""
    html_path = STATIC_PATH / "index.html"
    if html_path.exists():
        return FileResponse(html_path, media_type="text/html")
    return HTMLResponse("<h1>WebUI 文件不存在</h1>", status_code=404)


# === WebSocket 实时推送 ===
@webui_app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """​WebSocket 实时推送端点（带认证）"""
    # 在 accept 之前验证 API 密钥
    if API_KEY:
        # 优先从 query 参数获取，其次从 headers 获取
        ws_api_key = websocket.query_params.get("api_key") or \
            websocket.headers.get("x-api-key")
        if not ws_api_key or not hmac.compare_digest(ws_api_key, API_KEY):
            await websocket.accept()
            await websocket.close(code=4001, reason="未授权：无效的 API 密钥")
            return

    await websocket.accept()
    ws_clients.add(websocket)
    logger.info(f"WebSocket client connected (total: {len(ws_clients)})")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                msg_type = msg.get("type", "")

                if msg_type == "sync_import":
                    # 处理同步导入请求
                    import_data = msg.get("data", {})
                    configs = import_data.get("configs", {})
                    import_hash = import_data.get("hash", "")
                    matched_groups = import_data.get("matched_groups", [])

                    if configs and matched_groups:
                        # 保存导入的配置
                        existing = load_config()
                        for gid in matched_groups:
                            if gid in configs:
                                existing[gid] = configs[gid]
                        if save_config(existing):
                            # 热重载
                            try:
                                from src.plugins.auto_mute import reload_config
                                reload_config()
                            except Exception as e:
                                logger.error(f"重新加载配置失败: {e}")

                            # 广播确认
                            await broadcast_event("sync_import:confirmed", {
                                "success": True,
                                "hash": import_hash,
                                "applied_groups": matched_groups
                            })

                            # 广播群列表更新
                            await broadcast_event("group:updated", {
                                "changed_groups": matched_groups
                            })
                        else:
                            await websocket.send_text(json.dumps({
                                "type": "sync_import:confirmed",
                                "data": {"success": False, "error": "保存失败"}
                            }))

                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

            except json.JSONDecodeError:
                logger.warning("Invalid WebSocket message format")
    except WebSocketDisconnect:
        ws_clients.discard(websocket)
        logger.info(f"WebSocket client disconnected (total: {len(ws_clients)})")
    except Exception as e:
        ws_clients.discard(websocket)
        logger.warning(f"WebSocket error: {e}")


# === SSE (EventSource) 降级端点 ===
@webui_app.get("/api/events")
async def sse_endpoint(api_key: Optional[str] = Query(None)):
    """Server-Sent Events 端点，作为 WebSocket 的降级方案"""
    # 验证 API 密钥
    if API_KEY and (not api_key or not hmac.compare_digest(api_key, API_KEY)):
        return Response(status_code=401, content="Unauthorized")

    queue: asyncio.Queue = asyncio.Queue()
    sse_queues.append(queue)

    async def event_generator():
        try:
            # 发送初始连接确认
            yield f"event: connected\ndata: {json.dumps({'status': 'ok'})}\n\n"

            while True:
                try:
                    # 等待事件，30s 超时发送心跳
                    msg = await asyncio.wait_for(queue.get(), timeout=30.0)
                    event_type = msg.get("event", "message")
                    data = json.dumps(msg.get("data", {}), ensure_ascii=False)
                    yield f"event: {event_type}\ndata: {data}\n\n"
                except asyncio.TimeoutError:
                    # 心跳保活
                    yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if queue in sse_queues:
                sse_queues.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@webui_app.get("/api/bot/info")
async def get_bot_info(authorized: bool = Depends(verify_api_key)):
    """获取机器人自身信息（QQ号）"""
    try:
        bot: Bot = get_bot()
        return {"success": True, "data": {"user_id": int(bot.self_id)}}
    except Exception as e:
        logger.error(f"获取机器人信息失败: {e}")
        return {"success": False, "error": str(e)}


@webui_app.get("/api/groups")
async def get_groups(authorized: bool = Depends(verify_api_key)):
    """获取群列表（在线优先，离线时回退到 config.json 已配置群）"""
    online_groups = []
    bot_connected = False

    try:
        bot: Bot = get_bot()
        group_list = await bot.get_group_list()
        bot_connected = True
        online_groups = [
            {
                "group_id": g["group_id"],
                "group_name": g["group_name"],
                "member_count": g.get("member_count", 0),
                "offline": False
            }
            for g in group_list
        ]
    except Exception as e:
        logger.warning(f"获取群列表失败（将使用配置回退）: {e}")

    # 合并：将 config.json 中有但 QQ 群列表中没有的群加入（离线群）
    existing = load_config()
    online_ids = {str(g["group_id"]) for g in online_groups}
    for group_id_str in existing:
        if group_id_str not in online_ids:
            try:
                gid_int = int(group_id_str)
            except (ValueError, TypeError):
                gid_int = group_id_str
            online_groups.append({
                "group_id": gid_int,
                "group_name": f"群 {group_id_str}",
                "member_count": 0,
                "offline": True
            })

    return {
        "success": True,
        "data": online_groups,
        "bot_connected": bot_connected
    }


@webui_app.get("/api/groups/{group_id}/members")
async def get_group_members(group_id: int, authorized: bool = Depends(verify_api_key)):
    """获取群成员列表（头像+昵称+QQ号），自动排除机器人自身"""
    try:
        bot: Bot = get_bot()
        self_id = int(bot.self_id)
        member_list = await bot.get_group_member_list(group_id=group_id)
        return {
            "success": True,
            "data": [
                {
                    "user_id": m["user_id"],
                    "nickname": m.get("nickname", ""),
                    "card": m.get("card", ""),  # 群名片
                    "avatar": f"https://q1.qlogo.cn/g?b=qq&nk={m['user_id']}&s=100"
                }
                for m in member_list
                if m["user_id"] != self_id
            ]
        }
    except Exception as e:
        logger.error(f"获取群成员失败: {e}")
        return {"success": False, "error": str(e)}


@webui_app.get("/api/config")
async def get_config(authorized: bool = Depends(verify_api_key)):
    """获取当前配置"""
    config = load_config()
    return {"success": True, "data": config}


@webui_app.post("/api/config")
async def update_config(config: Dict[str, Any], authorized: bool = Depends(verify_api_key)):
    """保存配置（带验证）"""
    # 验证配置结构
    try:
        validated_config = {}
        for group_id, group_cfg in config.items():
            # 验证每个群配置
            validated_group = GroupConfig(**group_cfg)
            validated_config[group_id] = validated_group.dict()
    except Exception as e:
        logger.error(f"配置验证失败: {e}")
        return {"success": False, "error": f"配置验证失败: {str(e)}"}
    
    if save_config(validated_config):
        # 通知 auto_mute 插件重新加载配置
        reload_ok = True
        reload_err = None
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception as e:
            reload_ok = False
            reload_err = str(e)
            logger.error(f"重新加载配置失败: {e}")

        # 广播配置更新事件
        try:
            await broadcast_event("config:updated", {
                "group_ids": list(validated_config.keys()),
                "action": "bulk_update"
            })
        except Exception as e:
            logger.warning(f"广播配置更新事件失败: {e}")

        return {
            "success": True,
            "message": "配置已保存",
            "reload_ok": reload_ok,
            "reload_error": reload_err
        }
    return {"success": False, "error": "保存失败"}


@webui_app.post("/api/config/{group_id}")
async def update_group_config(group_id: str, group_config: Dict[str, Any], authorized: bool = Depends(verify_api_key)):
    # 注意：此处存在 TOCTOU 竞态条件（load_config -> 修改 -> save_config 期间可能被并发请求覆盖）
    # 对于单用户管理面板场景影响有限；若需支持多用户并发，建议引入文件锁
    """更新单个群的配置（带验证）"""
    # 验证群配置
    try:
        validated_group = GroupConfig(**group_config)
    except Exception as e:
        logger.error(f"群配置验证失败: {e}")
        return {"success": False, "error": f"配置验证失败: {str(e)}"}
    
    config = load_config()
    config[group_id] = validated_group.dict()
    if save_config(config):
        # 通知 auto_mute 插件重新加载配置
        reload_ok = True
        reload_err = None
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception as e:
            reload_ok = False
            reload_err = str(e)
            logger.error(f"重新加载配置失败: {e}")

        # 广播配置更新事件
        try:
            await broadcast_event("config:updated", {
                "group_id": group_id,
                "action": "update"
            })
        except Exception as e:
            logger.warning(f"广播配置更新事件失败: {e}")

        return {
            "success": True,
            "message": f"群 {group_id} 配置已保存",
            "reload_ok": reload_ok,
            "reload_error": reload_err
        }
    return {"success": False, "error": "保存失败", "reload_ok": False, "reload_error": None}


@webui_app.delete("/api/config/{group_id}")
async def delete_group_config(group_id: str, authorized: bool = Depends(verify_api_key)):
    """删除群配置"""
    config = load_config()
    
    # 检查配置是否存在
    if group_id not in config:
        return {"success": False, "error": "配置不存在"}
    
    del config[group_id]
    
    # 尝试保存
    if not save_config(config):
        logger.error(f"删除群 {group_id} 配置后保存失败")
        return {"success": False, "error": "保存失败"}
    
    # 保存成功，尝试重新加载配置
    try:
        from src.plugins.auto_mute import reload_config
        reload_config()
    except Exception as e:
        logger.error(f"重新加载配置失败: {e}")

    # 广播配置删除事件
    try:
        await broadcast_event("config:updated", {
            "group_id": group_id,
            "action": "delete"
        })
    except Exception as e:
        logger.warning(f"广播配置删除事件失败: {e}")

    return {"success": True, "message": f"群 {group_id} 配置已删除"}


# === 群聊匹配辅助函数 ===
def _bigrams(s: str) -> set:
    """生成字符串的字符 bigram 集合"""
    s = s.lower().strip()
    if len(s) < 2:
        return {s}
    return {s[i:i+2] for i in range(len(s) - 1)}


def _jaccard_similarity(a: str, b: str) -> float:
    """计算两个字符串的 Jaccard 相似度（基于 bigram）"""
    if not a or not b:
        return 0.0
    set_a = _bigrams(a)
    set_b = _bigrams(b)
    intersection = set_a & set_b
    union = set_a | set_b
    return len(intersection) / len(union) if union else 0.0


def match_groups(import_config: Dict[str, Any], qq_groups: list,
                 similarity_threshold: float = 0.5) -> Dict[str, Any]:
    """
    将导入配置中的键与 QQ 群列表进行匹配。
    返回每个导入 key 的匹配结果。
    """
    results = {}
    # 构建 QQ 群索引
    qq_by_id = {str(g["group_id"]): g for g in qq_groups}
    qq_by_name = {}  # name -> list of groups
    for g in qq_groups:
        name = g.get("group_name", "")
        qq_by_name.setdefault(name, []).append(g)

    for import_key in import_config:
        # 1. 精确匹配：群号完全一致
        if import_key in qq_by_id:
            g = qq_by_id[import_key]
            results[import_key] = {
                "match_type": "exact",
                "matched_group_id": str(g["group_id"]),
                "group_name": g.get("group_name", ""),
                "confidence": 1.0
            }
            continue

        # 2. 模糊匹配：如果 key 不是纯数字，尝试按群名匹配
        if not import_key.isdigit():
            best_match = None
            best_score = 0.0
            for g in qq_groups:
                g_name = g.get("group_name", "")
                if not g_name or not g_name.strip():
                    continue
                # 子串包含
                if import_key.lower() in g_name.lower() or g_name.lower() in import_key.lower():
                    score = 0.8
                else:
                    score = _jaccard_similarity(import_key, g_name)
                if score > best_score:
                    best_score = score
                    best_match = g
            if best_match and best_score >= similarity_threshold:
                results[import_key] = {
                    "match_type": "fuzzy",
                    "matched_group_id": str(best_match["group_id"]),
                    "group_name": best_match.get("group_name", ""),
                    "confidence": round(best_score, 2)
                }
                continue

        # 3. 未匹配
        results[import_key] = {
            "match_type": "none",
            "matched_group_id": None,
            "group_name": None,
            "confidence": 0.0
        }

    return results


def detect_conflicts(import_config: Dict[str, Any],
                     existing_config: Dict[str, Any],
                     match_results: Dict[str, Any]) -> list:
    """检测导入配置与现有配置的冲突"""
    conflicts = []
    for import_key, match in match_results.items():
        target_id = match.get("matched_group_id")
        if target_id and target_id in existing_config:
            conflicts.append({
                "import_key": import_key,
                "target_group_id": target_id,
                "group_name": match.get("group_name", ""),
                "existing_config": existing_config[target_id],
                "incoming_config": import_config[import_key]
            })
    return conflicts


def create_backup() -> Optional[str]:
    """创建配置备份，返回备份文件名或 None"""
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"config_backup_{timestamp}.json"
        backup_path = BACKUP_DIR / backup_name
        if CONFIG_PATH.exists():
            shutil.copy2(CONFIG_PATH, backup_path)
            logger.info(f"配置已备份: {backup_path}")
            return backup_name
        return None
    except Exception as e:
        logger.error(f"创建备份失败: {e}")
        return None


# === 配置导入导出 ===
@webui_app.get("/api/config/export")
async def export_all_config(authorized: bool = Depends(verify_api_key)):
    """导出全量配置为 JSON 文件下载"""
    config = load_config()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"config_全量_{timestamp}.json"
    ascii_fallback = f"config_export_{timestamp}.json"
    encoded_filename = url_quote(filename, safe="")
    
    export_data = {
        "meta": {
            "version": "1.0",
            "date": datetime.now().isoformat(),
            "type": "full",
            "generator": "QQ-Auto-Mute-Script WebUI"
        },
        "configs": config
    }
    
    content = json.dumps(export_data, ensure_ascii=False, indent=4, sort_keys=True)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded_filename}'}
    )


@webui_app.get("/api/config/export/{group_id}")
async def export_group_config(group_id: str, authorized: bool = Depends(verify_api_key)):
    """导出单个群的配置为 JSON 文件下载"""
    config = load_config()
    if group_id not in config:
        return {"success": False, "error": f"群 {group_id} 的配置不存在"}

    single = {group_id: config[group_id]}
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"config_{group_id}_{timestamp}.json"
    encoded_filename = url_quote(filename, safe="")
    
    export_data = {
        "meta": {
            "version": "1.0",
            "date": datetime.now().isoformat(),
            "type": "single",
            "generator": "QQ-Auto-Mute-Script WebUI"
        },
        "configs": single
    }
    
    content = json.dumps(export_data, ensure_ascii=False, indent=4, sort_keys=True)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"; filename*=UTF-8\'\'{encoded_filename}'}
    )


@webui_app.post("/api/config/import/preview")
async def import_preview(
    incoming: Dict[str, Any],
    authorized: bool = Depends(verify_api_key)
):
    """导入预览：解析配置、匹配群聊、检测冲突"""
    # 兼容包装格式（WebUI 导出的带 meta/configs 的文件）
    if not isinstance(incoming, dict):
        incoming = {}
    configs_to_validate = incoming.get("configs", incoming)
    if not isinstance(configs_to_validate, dict):
        configs_to_validate = {}

    # 1. 使用共享验证器进行深度验证和自动修正
    batch_result = validate_import_batch(configs_to_validate)

    validated = batch_result.valid_configs
    validation_errors = []

    # 收集验证错误
    for key, r in batch_result.results.items():
        for e in r.errors:
            validation_errors.append({"key": key, "error": e})

    # 收集验证警告（作为 info 返回给前端）
    validation_warnings = []
    for key, r in batch_result.results.items():
        for w in r.warnings:
            validation_warnings.append({"key": key, "warning": w})

    # 额外用 Pydantic 做一次严格校验
    pydantic_errors = []
    for key, cfg in validated.items():
        try:
            GroupConfig(**cfg)
        except Exception as e:
            pydantic_errors.append({"key": key, "error": str(e)})

    # 2. 获取 QQ 群列表
    qq_groups = []
    try:
        bot: Bot = get_bot()
        group_list = await bot.get_group_list()
        qq_groups = [
            {
                "group_id": g["group_id"],
                "group_name": g["group_name"],
                "member_count": g.get("member_count", 0)
            }
            for g in group_list
        ]
    except Exception as e:
        logger.warning(f"获取群列表失败（预览仍可继续）: {e}")

    # 3. 群聊匹配
    match_results = match_groups(validated, qq_groups)

    # 4. 冲突检测
    existing = load_config()
    conflicts = detect_conflicts(validated, existing, match_results)

    # 5. 统计
    exact_count = sum(1 for m in match_results.values() if m["match_type"] == "exact")
    fuzzy_count = sum(1 for m in match_results.values() if m["match_type"] == "fuzzy")
    none_count = sum(1 for m in match_results.values() if m["match_type"] == "none")

    return {
        "success": True,
        "data": {
            "total_groups": len(configs_to_validate),
            "valid_groups": len(validated),
            "validation_errors": validation_errors,
            "validation_warnings": validation_warnings,
            "pydantic_errors": pydantic_errors,
            "match_results": match_results,
            "conflicts": conflicts,
            "stats": {
                "exact_match": exact_count,
                "fuzzy_match": fuzzy_count,
                "no_match": none_count,
                "conflict_count": len(conflicts),
                "fixed_count": batch_result.fixed_count
            },
            "qq_groups": qq_groups
        }
    }


@webui_app.post("/api/config/import")
async def import_config(
    incoming: Dict[str, Any],
    mode: str = Query("merge", pattern=r"^(merge|overwrite)$"),
    authorized: bool = Depends(verify_api_key)
):
    """
    执行导入（确认阶段）。
    incoming 格式: {
        "configs": { "群号": { 配置 }, ... },
        "mapping": { "原始key": "目标群号", ... },
        "conflict_resolution": { "群号": "keep_existing" | "use_imported", ... }
    }
    """
    configs = incoming.get("configs", {})
    if not isinstance(configs, dict):
        configs = {}
    mapping = incoming.get("mapping", {})
    if not isinstance(mapping, dict):
        mapping = {}
    conflict_resolution = incoming.get("conflict_resolution", {})
    if not isinstance(conflict_resolution, dict):
        conflict_resolution = {}

    # 使用共享验证器验证并修正配置
    batch_result = validate_import_batch(configs)
    validated = batch_result.valid_configs

    if batch_result.valid_count == 0 and batch_result.total > 0:
        return {"success": False, "error": "所有配置验证失败", "details": list(batch_result.all_errors)}

    # 额外 Pydantic 校验
    pydantic_errors = []
    for key, cfg in validated.items():
        try:
            GroupConfig(**cfg)
        except Exception as e:
            pydantic_errors.append({"key": key, "error": str(e)})

    if pydantic_errors:
        return {"success": False, "error": "配置验证失败", "details": pydantic_errors}

    # 创建备份
    backup_name = create_backup()

    # 应用映射：将原始 key 映射到目标群号
    mapped_configs = {}
    for original_key, cfg in validated.items():
        target_id = mapping.get(original_key, original_key)
        if target_id:  # 跳过映射为空的（用户选择跳过的）
            mapped_configs[target_id] = cfg

    # 处理冲突
    existing = load_config()
    applied = 0
    skipped = 0
    overwritten = 0

    if mode == "overwrite":
        # overwrite 模式: 合并而非替换, 保留未涉及的现有群
        final_config = dict(existing)
        for group_id, cfg in mapped_configs.items():
            if group_id in final_config:
                overwritten += 1
            final_config[group_id] = cfg
            applied += 1
    else:
        # merge 模式
        final_config = dict(existing)
        for group_id, cfg in mapped_configs.items():
            if group_id in final_config:
                resolution = conflict_resolution.get(group_id, "use_imported")
                if resolution == "keep_existing":
                    skipped += 1
                    continue
                else:
                    overwritten += 1
            applied += 1
            final_config[group_id] = cfg

    if not save_config(final_config):
        return {"success": False, "error": "保存失败"}

    # 热重载
    reload_ok = True
    reload_err = None
    try:
        from src.plugins.auto_mute import reload_config
        reload_config()
    except Exception as e:
        reload_ok = False
        reload_err = str(e)
        logger.error(f"重新加载配置失败: {e}")

    return {
        "success": True,
        "message": f"导入完成（模式: {'合并' if mode == 'merge' else '覆盖'}）",
        "stats": {
            "applied": applied,
            "skipped": skipped,
            "overwritten": overwritten,
            "total": len(configs)
        },
        "backup_name": backup_name,
        "reload_ok": reload_ok,
        "reload_error": reload_err
    }


# === 备份恢复 ===
@webui_app.get("/api/config/backups")
async def list_backups(authorized: bool = Depends(verify_api_key)):
    """列出所有配置备份"""
    if not BACKUP_DIR.exists():
        return {"success": True, "data": []}

    backups = []
    for f in sorted(BACKUP_DIR.glob("config_backup_*.json"), reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size": stat.st_size,
            "created": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        })
    return {"success": True, "data": backups}


@webui_app.post("/api/config/backup")
async def create_backup_endpoint(authorized: bool = Depends(verify_api_key)):
    """手动创建配置备份"""
    backup_name = create_backup()
    if backup_name:
        return {"success": True, "message": f"备份已创建: {backup_name}", "filename": backup_name}
    return {"success": False, "error": "备份失败"}


@webui_app.post("/api/config/restore")
async def restore_backup(
    body: Dict[str, str],
    authorized: bool = Depends(verify_api_key)
):
    """从备份恢复配置"""
    filename = body.get("filename", "")
    if not filename:
        return {"success": False, "error": "未指定备份文件名"}

    # 安全检查：防止路径穿越
    safe_name = Path(filename).name
    if safe_name != filename or not re.match(r'^config_backup_\d{8}_\d{6}\.json$', safe_name):
        return {"success": False, "error": "无效的备份文件名"}

    backup_path = BACKUP_DIR / safe_name
    if not backup_path.exists():
        return {"success": False, "error": "备份文件不存在"}

    try:
        with open(backup_path, "r", encoding="utf-8") as f:
            backup_config = json.load(f)

        # 兼容包装格式 (WebUI 导出的带 meta/configs 的文件)
        if isinstance(backup_config, dict) and "configs" in backup_config:
            backup_config = backup_config["configs"]

        # 验证备份内容
        for _, cfg in backup_config.items():
            GroupConfig(**cfg)

        if not save_config(backup_config):
            return {"success": False, "error": "恢复失败：保存出错"}

        # 热重载
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception as e:
            logger.error(f"恢复后重新加载配置失败: {e}")

        return {"success": True, "message": f"已从 {safe_name} 恢复配置"}
    except Exception as e:
        logger.error(f"恢复备份失败: {e}")
        return {"success": False, "error": f"恢复失败: {str(e)}"}


# === WebUI 挂载到 NoneBot 主应用 ===
@driver.on_startup
async def mount_webui():
    """将 WebUI 挂载到 NoneBot 主 ASGI 应用，共享同一事件循环"""
    app = driver.server_app  # type: ignore[attr-defined]
    app.mount("/webui", webui_app)
    logger.info(
        "WebUI 已挂载到 NoneBot 主应用: http://%s:%s/webui/",
        driver.config.host, driver.config.port
    )
