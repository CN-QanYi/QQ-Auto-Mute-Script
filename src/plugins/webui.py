import hmac
import json
import os
import tempfile
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List
from functools import wraps

from nonebot import get_driver, get_bot
from nonebot.adapters.onebot.v11 import Bot
from fastapi import FastAPI, HTTPException, Depends, Request, Header, Query
from fastapi.responses import HTMLResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 日志配置
logger = logging.getLogger(__name__)

# 配置文件路径
CONFIG_PATH = Path(__file__).parent.parent.parent / "config.json"
STATIC_PATH = Path(__file__).parent.parent / "static"

# API 密钥（从环境变量获取，默认为空字符串表示禁用认证）
API_KEY = os.environ.get("WEBUI_API_KEY", "")

# WebUI 独立端口（从环境变量获取，默认 9090）
WEBUI_PORT = int(os.environ.get("WEBUI_PORT", "9090"))

# 获取 NoneBot 驱动（用于生命周期钩子）
driver = get_driver()

# 创建独立的 WebUI FastAPI 应用
webui_app = FastAPI(title="QQ Auto Mute WebUI")

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
    """获取机器人所在的群列表"""
    try:
        bot: Bot = get_bot()
        group_list = await bot.get_group_list()
        return {
            "success": True,
            "data": [
                {
                    "group_id": g["group_id"],
                    "group_name": g["group_name"],
                    "member_count": g.get("member_count", 0)
                }
                for g in group_list
            ]
        }
    except Exception as e:
        logger.error(f"获取群列表失败: {e}")
        return {"success": False, "error": str(e)}


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
    
    return {"success": True, "message": f"群 {group_id} 配置已删除"}


# === 配置导入导出 ===
@webui_app.get("/api/config/export")
async def export_all_config(authorized: bool = Depends(verify_api_key)):
    """导出全量配置为 JSON 文件下载"""
    config = load_config()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"config_全量_{timestamp}.json"
    content = json.dumps(config, ensure_ascii=False, indent=4)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"}
    )


@webui_app.get("/api/config/export/{group_id}")
async def export_group_config(group_id: str, authorized: bool = Depends(verify_api_key)):
    """导出单个群的配置为 JSON 文件下载"""
    config = load_config()
    if group_id not in config:
        return {"success": False, "error": f"群 {group_id} 的配置不存在"}

    # 保持与全量配置一致的结构: { "群号": { ... } }
    single = {group_id: config[group_id]}
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"config_{group_id}_{timestamp}.json"
    content = json.dumps(single, ensure_ascii=False, indent=4)
    return Response(
        content=content,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"}
    )


@webui_app.post("/api/config/import")
async def import_config(
    incoming: Dict[str, Any],
    mode: str = Query("merge", regex="^(merge|overwrite)$"),
    authorized: bool = Depends(verify_api_key)
):
    """导入配置（支持合并或覆盖模式）"""
    # 验证每个群配置
    try:
        validated = {}
        for group_id, group_cfg in incoming.items():
            validated_group = GroupConfig(**group_cfg)
            validated[group_id] = validated_group.dict()
    except Exception as e:
        logger.error(f"导入配置验证失败: {e}")
        return {"success": False, "error": f"配置验证失败: {str(e)}"}

    if mode == "merge":
        # 合并模式：保留现有配置，用导入的覆盖同名群
        existing = load_config()
        existing.update(validated)
        final_config = existing
    else:
        # 覆盖模式：完全替换
        final_config = validated

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

    imported_count = len(validated)
    return {
        "success": True,
        "message": f"已导入 {imported_count} 个群配置（模式: {'合并' if mode == 'merge' else '覆盖'}）",
        "reload_ok": reload_ok,
        "reload_error": reload_err
    }


# === 独立 WebUI 服务器启动 ===
@driver.on_startup
async def start_webui_server():
    """在 NoneBot 启动时，以后台线程启动独立的 WebUI 服务器"""
    import uvicorn

    config = uvicorn.Config(
        webui_app,
        host="0.0.0.0",
        port=WEBUI_PORT,
        log_level="info"
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    logger.info(f"WebUI 已启动: http://localhost:{WEBUI_PORT}/")
