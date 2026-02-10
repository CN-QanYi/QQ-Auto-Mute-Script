// === 全局状态 ===
let currentGroupId = null;
let groupMembers = [];
let config = {};
let selectedDay = 'default';
let botUserId = null;          // 机器人自身 QQ 号
let groupNameMap = {};         // 群号 → 群名映射
let groupSavedState = {};      // 群号 → 是否已保存到服务端

const DAYS = [
    { key: 'default', label: '默认' },
    { key: 0, label: '周一' },
    { key: 1, label: '周二' },
    { key: 2, label: '周三' },
    { key: 3, label: '周四' },
    { key: 4, label: '周五' },
    { key: 5, label: '周六' },
    { key: 6, label: '周日' }
];

// 默认群配置（共享常量，避免重复定义）
const DEFAULT_GROUP_CONFIG = {
    target_users: [],
    threshold: 5,
    combo_timeout: 180,
    scheduled_mute: {
        enabled: false,
        cooldown: 30,
        ranges: { default: [] }
    }
};

// === 初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    // 获取机器人自身信息
    await loadBotInfo();
    // 先加载群列表，确保 DOM 元素存在后再加载配置
    await loadGroups();
    await loadConfig();
});

// === 认证失败处理 ===
window.addEventListener('api-unauthorized', (event) => {
    console.warn('API 认证失败:', event.detail);

    const newKey = prompt('API 密钥无效或已过期，请重新输入 API 密钥：');
    if (newKey && newKey.trim()) {
        localStorage.setItem('apiKey', newKey.trim());
        location.reload();
    } else {
        showToast('未输入 API 密钥，部分功能可能不可用', 'error');
    }
});

// === API 调用 ===
async function api(endpoint, options = {}) {
    try {
        // Build headers with Content-Type and optional API key
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        // Add X-API-KEY header if API key is stored in localStorage
        const apiKey = localStorage.getItem('apiKey');
        if (apiKey) {
            headers['X-API-KEY'] = apiKey;
        }

        const response = await fetch(endpoint, {
            ...options,
            headers
        });

        // Handle 401 Unauthorized - clear stored API key and notify UI
        if (response.status === 401) {
            localStorage.removeItem('apiKey');
            window.dispatchEvent(new CustomEvent('api-unauthorized', {
                detail: { endpoint, status: response.status }
            }));
            return {
                success: false,
                error: '未授权：API 密钥无效或已过期',
                status: 401,
                statusText: response.statusText
            };
        }

        // Check content-type for JSON responses
        const contentType = response.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');

        if (!response.ok) {
            // Non-OK response - try to get error details
            if (isJson) {
                const errorData = await response.json();
                return {
                    success: false,
                    error: errorData.detail || errorData.error || response.statusText,
                    status: response.status,
                    statusText: response.statusText,
                    data: errorData
                };
            } else {
                const body = await response.text();
                return {
                    success: false,
                    error: response.statusText || 'Request failed',
                    status: response.status,
                    statusText: response.statusText,
                    body: body
                };
            }
        }

        // OK response - parse JSON if applicable
        if (isJson) {
            return await response.json();
        } else {
            // Non-JSON success response
            const body = await response.text();
            return {
                success: true,
                body: body,
                status: response.status
            };
        }
    } catch (error) {
        console.error('API Error:', error);
        return {
            success: false,
            error: error.message || 'Network error',
            status: 0
        };
    }
}

// === 获取机器人信息 ===
async function loadBotInfo() {
    const result = await api('/api/bot/info');
    if (result.success && result.data) {
        botUserId = result.data.user_id;
    }
}

// === 群列表 ===
async function loadGroups() {
    const container = document.getElementById('groupList');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    const result = await api('/api/groups');

    if (result.success) {
        updateStatus(true);
        // 建立群名映射
        groupNameMap = {};
        result.data.forEach(g => {
            groupNameMap[g.group_id] = g.group_name;
        });
        renderGroups(result.data);
    } else {
        updateStatus(false);
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <h3>无法连接到机器人</h3>
                <p>请确保机器人已启动并连接</p>
            </div>
        `;
    }
}

function renderGroups(groups) {
    const container = document.getElementById('groupList');

    if (groups.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>暂无群聊</h3>
                <p>机器人尚未加入任何群</p>
            </div>
        `;
        return;
    }

    container.innerHTML = groups.map(g => `
        <div class="group-item" data-id="${g.group_id}" onclick="selectGroup(${g.group_id})">
            <div class="group-avatar">👥</div>
            <div class="group-info">
                <h4>${escapeHtml(g.group_name)}</h4>
                <small>${g.group_id} · ${g.member_count} 成员</small>
            </div>
            ${config[g.group_id] ? '<span class="configured-badge">已配置</span>' : ''}
        </div>
    `).join('');
}

// === 选择群 ===
async function selectGroup(groupId) {
    currentGroupId = groupId;

    // 更新选中状态
    document.querySelectorAll('.group-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id == groupId);
    });

    // 显示主内容区
    document.getElementById('mainContent').style.display = 'flex';
    document.getElementById('emptyContent').style.display = 'none';

    // 加载群成员
    await loadMembers(groupId);

    // 加载该群配置
    loadGroupConfig(groupId);
}

// === 群成员列表 ===
async function loadMembers(groupId) {
    const container = document.getElementById('memberGrid');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    const result = await api(`/api/groups/${groupId}/members`);

    if (result.success) {
        groupMembers = result.data;
        renderMembers();
    } else {
        container.innerHTML = `<div class="empty-state"><p>加载成员失败</p></div>`;
    }
}

function renderMembers(filter = '') {
    const container = document.getElementById('memberGrid');
    const groupConfig = config[currentGroupId] || { target_users: [] };
    const targetUsers = groupConfig.target_users || [];

    let filtered = groupMembers;

    // 前端防御：过滤机器人自身 QQ
    if (botUserId) {
        filtered = filtered.filter(m => m.user_id !== botUserId);
    }

    if (filter) {
        const lowerFilter = filter.toLowerCase();
        filtered = filtered.filter(m =>
            m.nickname.toLowerCase().includes(lowerFilter) ||
            m.card.toLowerCase().includes(lowerFilter) ||
            String(m.user_id).includes(filter)
        );
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>无匹配成员</p></div>`;
        return;
    }

    container.innerHTML = filtered.map(m => {
        const isSelected = targetUsers.includes(m.user_id);
        const displayName = m.card || m.nickname || '未知';
        const safeAvatar = escapeHtml(m.avatar || '');
        return `
            <div class="member-item ${isSelected ? 'selected' : ''}" 
                 data-id="${m.user_id}" 
                 onclick="toggleMember(${m.user_id})">
                <img class="member-avatar" 
                     src="${safeAvatar}" 
                     alt="${escapeHtml(displayName)}"
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%2330363d%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%238b949e%22 font-size=%2240%22>👤</text></svg>'">
                <div class="member-info">
                    <div class="member-name">${escapeHtml(displayName)}</div>
                    <div class="member-id">${m.user_id}</div>
                </div>
                <div class="member-checkbox">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
            </div>
        `;
    }).join('');
}

function toggleMember(userId) {
    if (!currentGroupId) return;

    // 使用统一的配置初始化函数
    ensureGroupConfig();

    const targetUsers = config[currentGroupId].target_users;
    const index = targetUsers.indexOf(userId);

    if (index > -1) {
        targetUsers.splice(index, 1);
    } else {
        targetUsers.push(userId);
    }

    // 更新UI
    const el = document.querySelector(`.member-item[data-id="${userId}"]`);
    if (el) el.classList.toggle('selected');

    updateSelectedCount();
}

function updateSelectedCount() {
    const count = config[currentGroupId]?.target_users?.length || 0;
    document.getElementById('selectedCount').textContent = count;
}

// === 配置管理 ===
async function loadConfig() {
    const result = await api('/api/config');
    if (result.success) {
        config = result.data;
        // 标记服务端已有的群配置为已保存
        groupSavedState = {};
        for (const groupId of Object.keys(config)) {
            groupSavedState[groupId] = true;
        }
        // 刷新群列表显示已配置标记
        const groups = document.querySelectorAll('.group-item');
        groups.forEach(g => {
            const id = g.dataset.id;
            const badge = g.querySelector('.configured-badge');
            if (config[id] && !badge) {
                g.insertAdjacentHTML('beforeend', '<span class="configured-badge">已配置</span>');
            }
        });
    }
}

function loadGroupConfig(groupId) {
    const groupConfig = config[groupId] || JSON.parse(JSON.stringify(DEFAULT_GROUP_CONFIG));

    // 填充表单（使用 ?? 保留合法的 0 值）
    document.getElementById('threshold').value = String(groupConfig.threshold ?? 5);
    document.getElementById('comboTimeout').value = String(groupConfig.combo_timeout ?? 180);
    document.getElementById('cooldown').value = String(groupConfig.scheduled_mute?.cooldown ?? 30);

    // 定时禁言开关
    const toggle = document.getElementById('scheduledMuteToggle');
    const isEnabled = groupConfig.scheduled_mute?.enabled || false;
    toggle.classList.toggle('active', isEnabled);
    toggle.setAttribute('aria-checked', isEnabled.toString());

    // 渲染时间段
    selectedDay = 'default';
    renderDayTabs();
    renderTimeRanges();

    updateSelectedCount();
}

// === 时间段配置 ===
function renderDayTabs() {
    const container = document.getElementById('dayTabs');
    const ranges = config[currentGroupId]?.scheduled_mute?.ranges || {};

    container.innerHTML = DAYS.map(d => {
        const hasRanges = ranges[d.key] && ranges[d.key].length > 0;
        return `
            <button class="day-tab ${selectedDay === d.key ? 'active' : ''}" 
                    onclick="selectDay('${d.key}')">
                ${d.label}${hasRanges && d.key !== 'default' ? ' •' : ''}
            </button>
        `;
    }).join('');
}

function selectDay(day) {
    selectedDay = day === 'default' ? 'default' : parseInt(day);
    renderDayTabs();
    renderTimeRanges();
}

function renderTimeRanges() {
    const container = document.getElementById('timeRangeList');
    const groupConfig = config[currentGroupId] || {};
    const ranges = groupConfig.scheduled_mute?.ranges || {};
    const dayRanges = ranges[selectedDay] || [];

    // 清空容器
    container.innerHTML = '';

    if (dayRanges.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 20px;">
                <p>暂无时间段，点击下方添加</p>
            </div>
        `;
    } else {
        // 使用 DOM 方法安全构建元素，防止 XSS
        dayRanges.forEach((r, i) => {
            const item = document.createElement('div');
            item.className = 'time-range-item';

            const startInput = document.createElement('input');
            startInput.type = 'time';
            startInput.value = r[0] || '';
            startInput.addEventListener('change', () => updateTimeRange(i, 0, startInput.value));

            const span = document.createElement('span');
            span.textContent = '至';

            const endInput = document.createElement('input');
            endInput.type = 'time';
            endInput.value = r[1] || '';
            endInput.addEventListener('change', () => updateTimeRange(i, 1, endInput.value));

            const btn = document.createElement('button');
            btn.className = 'btn-remove';
            btn.textContent = '删除';
            btn.addEventListener('click', () => removeTimeRange(i));

            item.appendChild(startInput);
            item.appendChild(span);
            item.appendChild(endInput);
            item.appendChild(btn);
            container.appendChild(item);
        });
    }
}

function addTimeRange() {
    if (!currentGroupId) return;

    ensureGroupConfig();

    if (!config[currentGroupId].scheduled_mute.ranges[selectedDay]) {
        config[currentGroupId].scheduled_mute.ranges[selectedDay] = [];
    }

    config[currentGroupId].scheduled_mute.ranges[selectedDay].push(['23:00', '07:00']);
    renderTimeRanges();
    renderDayTabs();
}

function updateTimeRange(index, pos, value) {
    if (!currentGroupId) return;

    const ranges = config[currentGroupId]?.scheduled_mute?.ranges;
    if (ranges && ranges[selectedDay] && ranges[selectedDay][index]) {
        ranges[selectedDay][index][pos] = value;
    }
}

function removeTimeRange(index) {
    if (!currentGroupId) return;

    const ranges = config[currentGroupId]?.scheduled_mute?.ranges;
    if (ranges && ranges[selectedDay]) {
        ranges[selectedDay].splice(index, 1);
        if (ranges[selectedDay].length === 0 && selectedDay !== 'default') {
            delete ranges[selectedDay];
        }
        renderTimeRanges();
        renderDayTabs();
    }
}

// === 保存配置 ===
// 配置值范围常量
const CONFIG_LIMITS = {
    threshold: { min: 0, max: 100, default: 5, label: '触发阈值' },
    combo_timeout: { min: 1, max: 3600, default: 180, label: '连击超时' },
    cooldown: { min: 1, max: 3600, default: 30, label: '冷却时间' }
};

function validateAndClamp(value, limits) {
    // 如果是 NaN，返回默认值
    if (Number.isNaN(value)) {
        return { valid: true, value: limits.default, clamped: false };
    }
    // 检查范围
    if (value < limits.min || value > limits.max) {
        return { valid: false, value: value, min: limits.min, max: limits.max };
    }
    return { valid: true, value: value, clamped: false };
}

async function saveConfig() {
    if (!currentGroupId) {
        showToast('请先选择一个群', 'error');
        return;
    }

    ensureGroupConfig();

    // 解析表单数据
    const parsedThreshold = parseInt(document.getElementById('threshold').value);
    const parsedTimeout = parseInt(document.getElementById('comboTimeout').value);
    const parsedCooldown = parseInt(document.getElementById('cooldown').value);

    // 验证并获取有效值
    const thresholdResult = validateAndClamp(parsedThreshold, CONFIG_LIMITS.threshold);
    const timeoutResult = validateAndClamp(parsedTimeout, CONFIG_LIMITS.combo_timeout);
    const cooldownResult = validateAndClamp(parsedCooldown, CONFIG_LIMITS.cooldown);

    // 收集验证错误
    const errors = [];
    if (!thresholdResult.valid) {
        errors.push(`${CONFIG_LIMITS.threshold.label}必须在 ${thresholdResult.min}-${thresholdResult.max} 之间`);
    }
    if (!timeoutResult.valid) {
        errors.push(`${CONFIG_LIMITS.combo_timeout.label}必须在 ${timeoutResult.min}-${timeoutResult.max} 秒之间`);
    }
    if (!cooldownResult.valid) {
        errors.push(`${CONFIG_LIMITS.cooldown.label}必须在 ${cooldownResult.min}-${cooldownResult.max} 秒之间`);
    }

    // 如果有验证错误，显示提示并中止保存
    if (errors.length > 0) {
        showToast(errors.join('；'), 'error');
        return;
    }

    // 使用验证后的值更新配置
    config[currentGroupId].threshold = thresholdResult.value;
    config[currentGroupId].combo_timeout = timeoutResult.value;
    config[currentGroupId].scheduled_mute.cooldown = cooldownResult.value;
    config[currentGroupId].scheduled_mute.enabled = document.getElementById('scheduledMuteToggle').classList.contains('active');

    const result = await api(`/api/config/${currentGroupId}`, {
        method: 'POST',
        body: JSON.stringify(config[currentGroupId])
    });

    if (result.success) {
        showToast('配置已保存', 'success');
        // 标记该群为已保存
        groupSavedState[currentGroupId] = true;
        // 更新群列表中的已配置标记
        const groupItem = document.querySelector(`.group-item[data-id="${currentGroupId}"]`);
        if (groupItem && !groupItem.querySelector('.configured-badge')) {
            groupItem.insertAdjacentHTML('beforeend', '<span class="configured-badge">已配置</span>');
        }
    } else {
        showToast('保存失败: ' + result.error, 'error');
    }
}

async function deleteConfig() {
    if (!currentGroupId) return;

    if (!confirm('确定要删除该群的配置吗？')) return;

    const result = await api(`/api/config/${currentGroupId}`, { method: 'DELETE' });

    if (result.success) {
        delete config[currentGroupId];
        delete groupSavedState[currentGroupId];
        showToast('配置已删除', 'success');

        // 移除已配置标记
        const groupItem = document.querySelector(`.group-item[data-id="${currentGroupId}"]`);
        const badge = groupItem?.querySelector('.configured-badge');
        if (badge) badge.remove();

        // 重新加载配置
        loadGroupConfig(currentGroupId);
        renderMembers();
    } else {
        showToast('删除失败', 'error');
    }
}

// === 工具函数 ===
function ensureGroupConfig() {
    if (!config[currentGroupId]) {
        config[currentGroupId] = JSON.parse(JSON.stringify(DEFAULT_GROUP_CONFIG));
    }
    if (!config[currentGroupId].scheduled_mute) {
        config[currentGroupId].scheduled_mute = {
            enabled: false,
            cooldown: 30,
            ranges: { default: [] }
        };
    }
    if (!config[currentGroupId].scheduled_mute.ranges) {
        config[currentGroupId].scheduled_mute.ranges = { default: [] };
    }
}

function toggleScheduledMute() {
    const toggle = document.getElementById('scheduledMuteToggle');
    toggle.classList.toggle('active');
    // Update aria-checked for accessibility
    const isActive = toggle.classList.contains('active');
    toggle.setAttribute('aria-checked', isActive.toString());
}

function updateStatus(connected) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    dot.classList.toggle('connected', connected);
    text.textContent = connected ? '已连接' : '未连接';
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    // Create SVG element safely
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.innerHTML = type === 'success'
        ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
        : '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>';

    // Create span and use textContent to prevent XSS
    const span = document.createElement('span');
    span.textContent = message;

    toast.appendChild(svg);
    toast.appendChild(span);
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// === 配置导入导出 ===
function triggerDownload(content, filename) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// === 批量导出 ===
function openBatchExportModal() {
    // 收集已保存的群配置
    const savedGroups = Object.keys(config).filter(gid => groupSavedState[gid]);

    if (savedGroups.length === 0) {
        showToast('当前没有已保存的群配置可导出', 'error');
        return;
    }

    const overlay = document.getElementById('batchExportModal');
    const listContainer = document.getElementById('exportGroupList');

    // 渲染群列表
    listContainer.innerHTML = savedGroups.map(gid => {
        const name = escapeHtml(groupNameMap[gid] || '未知群聊');
        return `
            <label class="export-group-item" data-gid="${gid}">
                <input type="checkbox" checked value="${gid}">
                <div class="export-group-info">
                    <span class="export-group-name">${name}</span>
                    <span class="export-group-id">${gid}</span>
                </div>
            </label>
        `;
    }).join('');

    overlay.style.display = 'flex';
}

function closeBatchExportModal() {
    document.getElementById('batchExportModal').style.display = 'none';
}

function toggleAllExportGroups() {
    const checkboxes = document.querySelectorAll('#exportGroupList input[type="checkbox"]');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => { cb.checked = !allChecked; });
}

function executeBatchExport() {
    const checkboxes = document.querySelectorAll('#exportGroupList input[type="checkbox"]:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);

    if (selectedIds.length === 0) {
        showToast('请至少选择一个群', 'error');
        return;
    }

    const exportData = {};
    selectedIds.forEach(gid => {
        if (config[gid]) {
            exportData[gid] = config[gid];
        }
    });

    const now = new Date();
    const ts = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0') + '_'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');

    const suffix = selectedIds.length === 1 ? selectedIds[0] : `批量${selectedIds.length}群`;
    const content = JSON.stringify(exportData, null, 4);
    triggerDownload(content, `config_${suffix}_${ts}.json`);

    showToast(`已导出 ${selectedIds.length} 个群的配置`, 'success');
    closeBatchExportModal();
}

function importConfig() {
    const fileInput = document.getElementById('configFileInput');
    fileInput.value = '';
    fileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // 读取文件
        let text;
        try {
            text = await file.text();
        } catch (err) {
            showToast('读取文件失败', 'error');
            return;
        }

        // 解析 JSON
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            showToast('文件不是有效的 JSON 格式', 'error');
            return;
        }

        // 基本结构校验
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            showToast('配置格式错误：应为 { "群号": { ... } } 结构', 'error');
            return;
        }

        const groupCount = Object.keys(parsed).length;
        if (groupCount === 0) {
            showToast('配置文件为空，没有可导入的群配置', 'error');
            return;
        }

        // 选择导入模式
        const mode = confirm(
            `即将导入 ${groupCount} 个群的配置。\n\n` +
            `点击「确定」= 合并模式（保留现有配置，仅覆盖同名群）\n` +
            `点击「取消」= 取消导入`
        );
        if (!mode) return;

        // 是否覆盖
        const overwrite = confirm(
            '是否使用覆盖模式？\n\n' +
            '点击「确定」= 覆盖（删除所有现有配置，仅保留导入的内容）\n' +
            '点击「取消」= 合并（推荐，保留未涉及群的配置）'
        );

        const importMode = overwrite ? 'overwrite' : 'merge';

        const result = await api(`/api/config/import?mode=${importMode}`, {
            method: 'POST',
            body: JSON.stringify(parsed)
        });

        if (result.success) {
            showToast(result.message || '导入成功', 'success');
            // 刷新配置
            await loadConfig();
            if (currentGroupId) {
                loadGroupConfig(currentGroupId);
                renderMembers();
            }
        } else {
            showToast('导入失败: ' + (result.error || '未知错误'), 'error');
        }
    };
    fileInput.click();
}

// 搜索功能
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('memberSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            renderMembers(e.target.value);
        });
    }
});
