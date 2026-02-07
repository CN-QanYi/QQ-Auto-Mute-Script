import json
import os
import tempfile
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List
from functools import wraps

from nonebot import get_driver, get_bot, on_command
from nonebot.adapters.onebot.v11 import Bot, MessageEvent
from fastapi import FastAPI, HTTPException, Depends, Request, Header
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 日志配置
logger = logging.getLogger(__name__)

# 配置文件路径
CONFIG_PATH = Path(__file__).parent.parent.parent / "config.json"
STATIC_PATH = Path(__file__).parent.parent / "static"

# API 密钥（从环境变量获取，默认为空字符串表示禁用认证）
API_KEY = os.environ.get("WEBUI_API_KEY", "")

# 获取 FastAPI 应用
driver = get_driver()
app: FastAPI = driver.server_app

# 挂载静态文件
if STATIC_PATH.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_PATH)), name="static")


# === 认证依赖 ===
async def verify_api_key(x_api_key: Optional[str] = Header(None)):
    """验证 API 密钥"""
    # 如果未配置 API_KEY，则禁用认证
    if not API_KEY:
        return True
    
    if not x_api_key or x_api_key != API_KEY:
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


class ConfigData(BaseModel):
    __root__: Dict[str, GroupConfig]


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


# === API 路由 ===
@app.get("/webui", response_class=HTMLResponse)
async def webui_page():
    """返回 WebUI 页面"""
    html_path = STATIC_PATH / "index.html"
    if html_path.exists():
        return FileResponse(html_path, media_type="text/html")
    return HTMLResponse("<h1>WebUI 文件不存在</h1>", status_code=404)


@app.get("/api/groups")
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


@app.get("/api/groups/{group_id}/members")
async def get_group_members(group_id: int, authorized: bool = Depends(verify_api_key)):
    """获取群成员列表（头像+昵称+QQ号）"""
    try:
        bot: Bot = get_bot()
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
            ]
        }
    except Exception as e:
        logger.error(f"获取群成员失败: {e}")
        return {"success": False, "error": str(e)}


@app.get("/api/config")
async def get_config(authorized: bool = Depends(verify_api_key)):
    """获取当前配置"""
    config = load_config()
    return {"success": True, "data": config}


@app.post("/api/config")
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
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception as e:
            logger.error(f"重新加载配置失败: {e}")
        return {"success": True, "message": "配置已保存"}
    return {"success": False, "error": "保存失败"}


@app.post("/api/config/{group_id}")
async def update_group_config(group_id: str, group_config: Dict[str, Any], authorized: bool = Depends(verify_api_key)):
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
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception as e:
            logger.error(f"重新加载配置失败: {e}")
        return {"success": True, "message": f"群 {group_id} 配置已保存"}
    return {"success": False, "error": "保存失败"}


@app.delete("/api/config/{group_id}")
async def delete_group_config(group_id: str, authorized: bool = Depends(verify_api_key)):
    """删除群配置"""
    config = load_config()
    if group_id in config:
        del config[group_id]
        if save_config(config):
            try:
                from src.plugins.auto_mute import reload_config
                reload_config()
            except Exception as e:
                logger.error(f"重新加载配置失败: {e}")
            return {"success": True, "message": f"群 {group_id} 配置已删除"}
    return {"success": False, "error": "配置不存在或删除失败"}
