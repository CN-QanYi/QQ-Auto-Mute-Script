import json
import os
from pathlib import Path
from typing import Optional, Dict, Any, List

from nonebot import get_driver, get_bot, on_command
from nonebot.adapters.onebot.v11 import Bot, MessageEvent
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 配置文件路径
CONFIG_PATH = Path(__file__).parent.parent.parent / "config.json"
STATIC_PATH = Path(__file__).parent.parent / "static"

# 获取 FastAPI 应用
driver = get_driver()
app: FastAPI = driver.server_app

# 挂载静态文件
if STATIC_PATH.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_PATH)), name="static")


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
    configs: Dict[str, GroupConfig]


# === 配置文件操作 ===
def load_config() -> Dict[str, Any]:
    """加载配置文件"""
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"加载配置失败: {e}")
            return {}
    return {}


def save_config(config: Dict[str, Any]) -> bool:
    """保存配置文件"""
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=4)
        return True
    except Exception as e:
        print(f"保存配置失败: {e}")
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
async def get_groups():
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
        return {"success": False, "error": str(e)}


@app.get("/api/groups/{group_id}/members")
async def get_group_members(group_id: int):
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
        return {"success": False, "error": str(e)}


@app.get("/api/config")
async def get_config():
    """获取当前配置"""
    config = load_config()
    return {"success": True, "data": config}


@app.post("/api/config")
async def update_config(config: Dict[str, Any]):
    """保存配置"""
    if save_config(config):
        # 通知 auto_mute 插件重新加载配置
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception:
            pass
        return {"success": True, "message": "配置已保存"}
    return {"success": False, "error": "保存失败"}


@app.post("/api/config/{group_id}")
async def update_group_config(group_id: str, group_config: Dict[str, Any]):
    """更新单个群的配置"""
    config = load_config()
    config[group_id] = group_config
    if save_config(config):
        try:
            from src.plugins.auto_mute import reload_config
            reload_config()
        except Exception:
            pass
        return {"success": True, "message": f"群 {group_id} 配置已保存"}
    return {"success": False, "error": "保存失败"}


@app.delete("/api/config/{group_id}")
async def delete_group_config(group_id: str):
    """删除群配置"""
    config = load_config()
    if group_id in config:
        del config[group_id]
        if save_config(config):
            try:
                from src.plugins.auto_mute import reload_config
                reload_config()
            except Exception:
                pass
            return {"success": True, "message": f"群 {group_id} 配置已删除"}
    return {"success": False, "error": "配置不存在或删除失败"}
