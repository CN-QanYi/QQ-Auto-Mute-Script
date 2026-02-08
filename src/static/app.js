// === 全局状态 ===
let currentGroupId = null;
let groupMembers = [];
let config = {};
let selectedDay = 'default';

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

// === 初始化 ===
document.addEventListener('DOMContentLoaded', () => {
    loadGroups();
    loadConfig();
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

// === 群列表 ===
async function loadGroups() {
    const container = document.getElementById('groupList');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    const result = await api('/api/groups');

    if (result.success) {
        updateStatus(true);
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
    if (filter) {
        const lowerFilter = filter.toLowerCase();
        filtered = groupMembers.filter(m =>
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
        return `
            <div class="member-item ${isSelected ? 'selected' : ''}" 
                 data-id="${m.user_id}" 
                 onclick="toggleMember(${m.user_id})">
                <img class="member-avatar" 
                     src="${m.avatar}" 
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

    if (!config[currentGroupId]) {
        config[currentGroupId] = {
            target_users: [],
            threshold: 5,
            combo_timeout: 180,
            scheduled_mute: {
                enabled: false,
                cooldown: 30,
                ranges: { default: [] }
            }
        };
    }

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
    const groupConfig = config[groupId] || {
        target_users: [],
        threshold: 5,
        combo_timeout: 180,
        scheduled_mute: {
            enabled: false,
            cooldown: 30,
            ranges: { default: [] }
        }
    };

    // 填充表单
    document.getElementById('threshold').value = groupConfig.threshold || 5;
    document.getElementById('comboTimeout').value = groupConfig.combo_timeout || 180;
    document.getElementById('cooldown').value = groupConfig.scheduled_mute?.cooldown || 30;

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

    if (dayRanges.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 20px;">
                <p>暂无时间段，点击下方添加</p>
            </div>
        `;
    } else {
        container.innerHTML = dayRanges.map((r, i) => `
            <div class="time-range-item">
                <input type="time" value="${r[0]}" onchange="updateTimeRange(${i}, 0, this.value)">
                <span>至</span>
                <input type="time" value="${r[1]}" onchange="updateTimeRange(${i}, 1, this.value)">
                <button class="btn-remove" onclick="removeTimeRange(${i})">删除</button>
            </div>
        `).join('');
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
async function saveConfig() {
    if (!currentGroupId) {
        showToast('请先选择一个群', 'error');
        return;
    }

    ensureGroupConfig();

    // 收集表单数据
    config[currentGroupId].threshold = parseInt(document.getElementById('threshold').value) || 5;
    config[currentGroupId].combo_timeout = parseInt(document.getElementById('comboTimeout').value) || 180;
    config[currentGroupId].scheduled_mute.cooldown = parseInt(document.getElementById('cooldown').value) || 30;
    config[currentGroupId].scheduled_mute.enabled = document.getElementById('scheduledMuteToggle').classList.contains('active');

    const result = await api(`/api/config/${currentGroupId}`, {
        method: 'POST',
        body: JSON.stringify(config[currentGroupId])
    });

    if (result.success) {
        showToast('配置已保存', 'success');
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
        config[currentGroupId] = {
            target_users: [],
            threshold: 5,
            combo_timeout: 180,
            scheduled_mute: {
                enabled: false,
                cooldown: 30,
                ranges: { default: [] }
            }
        };
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

// 搜索功能
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('memberSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            renderMembers(e.target.value);
        });
    }
});
