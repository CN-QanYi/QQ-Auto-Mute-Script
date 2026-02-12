// ============================================================
// QQ 自动禁言 - WebUI 前端
// ============================================================

// === 基础路径检测（支持子路径挂载，如 /webui） ===
var API_BASE = (function () {
    var path = location.pathname.replace(/\/+$/, '');
    // 移除可能的 index.html 后缀
    return path.replace(/\/index\.html$/i, '') || '';
})();

// === IndexedDB 持久化模块 ===
const IDB = {
    DB_NAME: 'QQAutoMuteDB',
    DB_VERSION: 1,
    STORE_NAME: 'group_config',
    db: null,

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'group_id' });
                }
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    async getAll() {
        if (!this.db) return [];
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    },

    async get(groupId) {
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.get(String(groupId));
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    },

    async put(groupId, configData, pendingSync = true) {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const record = {
                group_id: String(groupId),
                config: configData,
                pending_sync: pendingSync,
                updated_at: Date.now()
            };
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    },

    async delete(groupId) {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.delete(String(groupId));
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    },

    async markSynced(groupId) {
        const record = await this.get(String(groupId));
        if (record) {
            record.pending_sync = false;
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
                const store = tx.objectStore(this.STORE_NAME);
                const req = store.put(record);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }
    },

    async getPendingSyncs() {
        const all = await this.getAll();
        return all.filter(r => r.pending_sync);
    },

    async bulkPut(configs, pendingSync = true) {
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            for (const [groupId, cfg] of Object.entries(configs)) {
                store.put({
                    group_id: String(groupId),
                    config: cfg,
                    pending_sync: pendingSync,
                    updated_at: Date.now()
                });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
};

// === 全局状态 ===
let currentGroupId = null;
let groupMembers = [];
let config = {};
let selectedDay = 'default';
let botUserId = null;
let botConnected = false;
let groupNameMap = {};
let groupSavedState = {};
let downloadCounter = {};     // 导出文件名去重计数器

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

// === 同步管理器（替代固定轮询的自动刷新）===
const SyncManager = {
    // 状态：idle / loading / disabled / retry
    state: 'idle',
    enabled: false,
    retryCount: 0,
    maxRetries: 5,
    debounceTimer: null,
    retryTimer: null,

    init() {
        const saved = localStorage.getItem('syncEnabled');
        // 默认启用实时更新（除非用户显式关闭过）
        if (saved === 'false') {
            this.enabled = false;
            this.updateUI();
        } else {
            this.enabled = true;
            localStorage.setItem('syncEnabled', 'true');
            this.updateUI();
            RealtimeChannel.connect();
        }
    },

    setState(newState) {
        this.state = newState;
        this.updateUI();
    },

    updateUI() {
        const btn = document.getElementById('syncControl');
        const icon = document.getElementById('syncIcon');
        const label = document.getElementById('syncLabel');
        if (!btn || !icon) return;

        icon.classList.remove('sync-spinning');
        btn.classList.remove('active', 'sync-error');
        btn.disabled = false;

        switch (this.state) {
            case 'loading':
                icon.classList.add('sync-spinning');
                btn.classList.add('active');
                if (label) label.textContent = '同步中…';
                break;
            case 'retry':
                icon.classList.add('sync-spinning');
                btn.classList.add('sync-error');
                if (label) label.textContent = '重试 ' + this.retryCount + '/' + this.maxRetries;
                break;
            case 'idle':
                if (this.enabled) {
                    btn.classList.add('active');
                    icon.classList.add('sync-spinning');
                    if (label) label.textContent = '自动刷新';
                } else {
                    if (label) label.textContent = '自动刷新';
                }
                break;
            case 'disabled':
                btn.disabled = true;
                if (label) label.textContent = '不可用';
                break;
        }
    },

    toggle() {
        this.enabled = !this.enabled;
        localStorage.setItem('syncEnabled', this.enabled);

        if (this.enabled) {
            this.retryCount = 0;
            this.setState('idle');
            RealtimeChannel.connect();
        } else {
            this.setState('idle');
            RealtimeChannel.disconnect();
        }
    },

    async performSync() {
        if (this.state === 'loading' || this.state === 'disabled') return;

        // 防抖 300ms
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(async () => {
            this.setState('loading');
            try {
                await loadGroups(true);
                if (currentGroupId) {
                    await loadMembers(currentGroupId, true);
                }
                this.retryCount = 0;
                this.setState('idle');
            } catch (e) {
                console.error('[SyncManager] Sync failed:', e);
                this.handleRetry();
            }
        }, 300);
    },

    handleRetry() {
        if (this.retryCount >= this.maxRetries) {
            this.setState('disabled');
            console.warn('[SyncManager] Max retries reached');
            return;
        }
        this.retryCount++;
        this.setState('retry');
        // 指数退避：1s, 2s, 4s, 8s, 16s
        const delay = Math.pow(2, this.retryCount - 1) * 1000;
        this.retryTimer = setTimeout(() => {
            this.performSync();
        }, delay);
    },

    destroy() {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
    }
};

// === 实时通道（WebSocket → EventSource → 30s 轮询）===
const RealtimeChannel = {
    ws: null,
    eventSource: null,
    pollTimer: null,
    channelType: null,

    connect() {
        this.disconnect();
        this.tryWebSocket();
    },

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.channelType = null;
    },

    tryWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = protocol + '//' + location.host + API_BASE + '/ws';
        const apiKey = localStorage.getItem('apiKey');
        if (apiKey) {
            wsUrl += (wsUrl.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(apiKey);
        }

        try {
            this.ws = new WebSocket(wsUrl);

            // 设置连接超时（3秒）
            var connectTimeout = setTimeout(() => {
                if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                    console.warn('[Realtime] WebSocket connection timeout');
                    this.ws.close();
                }
            }, 3000);

            this.ws.onopen = () => {
                clearTimeout(connectTimeout);
                console.log('[Realtime] WebSocket connected');
                this.channelType = 'websocket';
                SyncManager.retryCount = 0;
                SyncManager.setState('idle');
            };

            this.ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleMessage(msg);
                } catch (e) {
                    console.warn('[Realtime] Invalid message:', e);
                }
            };

            this.ws.onclose = () => {
                console.warn('[Realtime] WebSocket closed');
                this.ws = null;
                if (SyncManager.enabled) {
                    this.tryEventSource();
                }
            };

            this.ws.onerror = () => {
                console.error('[Realtime] WebSocket error');
                if (this.ws) this.ws.close();
            };
        } catch (e) {
            console.warn('[Realtime] WebSocket unavailable, trying EventSource');
            this.tryEventSource();
        }
    },

    tryEventSource() {
        try {
            const apiKey = localStorage.getItem('apiKey');
            let url = API_BASE + '/api/events';
            if (apiKey) url += '?api_key=' + encodeURIComponent(apiKey);

            this.eventSource = new EventSource(url);

            this.eventSource.onopen = () => {
                console.log('[Realtime] EventSource connected');
                this.channelType = 'eventsource';
                SyncManager.retryCount = 0;
                SyncManager.setState('idle');
            };

            this.eventSource.addEventListener('group:updated', (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage({ type: 'group:updated', data: data });
                } catch (e) {
                    console.warn('[Realtime] Invalid SSE message:', e);
                }
            });

            this.eventSource.addEventListener('config:updated', (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessage({ type: 'config:updated', data: data });
                } catch (e) {
                    console.warn('[Realtime] Invalid SSE message:', e);
                }
            });

            this.eventSource.onerror = () => {
                console.warn('[Realtime] EventSource failed, falling back to polling');
                this.eventSource.close();
                this.eventSource = null;
                if (SyncManager.enabled) {
                    this.startPolling();
                }
            };
        } catch (e) {
            console.warn('[Realtime] EventSource unavailable, falling back to polling');
            this.startPolling();
        }
    },

    startPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.channelType = 'polling';
        console.log('[Realtime] Falling back to 10s polling');
        SyncManager.setState('idle');

        this.pollTimer = setInterval(async () => {
            if (!SyncManager.enabled) return;
            await loadGroups(true);
            if (currentGroupId) {
                await loadMembers(currentGroupId, true);
            }
        }, 10000);
    },

    handleMessage(msg) {
        switch (msg.type) {
            case 'group:updated':
                this.handleGroupUpdated(msg.data);
                break;
            case 'config:updated':
                this.handleConfigUpdated(msg.data);
                break;
            case 'sync_import:confirmed':
                this.handleSyncImportConfirmed(msg.data);
                break;
        }
    },

    async handleGroupUpdated(data) {
        await loadGroups(true);
        // 高亮变更项 3 秒
        if (data && data.changed_groups) {
            data.changed_groups.forEach(function (gid) {
                const el = document.querySelector('.group-item[data-id="' + gid + '"]');
                if (el) {
                    el.classList.add('highlight-change');
                    setTimeout(function () { el.classList.remove('highlight-change'); }, 3000);
                }
            });
        }
    },

    async handleConfigUpdated(data) {
        await loadConfig();
        await loadGroups(true);

        if (!data) return;

        // 兼容单群 (group_id) 和批量 (group_ids) 两种 payload
        var changedIds = [];
        if (data.group_id) changedIds.push(String(data.group_id));
        if (data.group_ids) data.group_ids.forEach(function (id) { changedIds.push(String(id)); });

        // 如果当前选中的群在变更列表中，刷新配置面板
        if (currentGroupId && changedIds.indexOf(String(currentGroupId)) !== -1) {
            loadGroupConfig(currentGroupId);
            renderMembers();
        }

        // 高亮变更项
        changedIds.forEach(function (gid) {
            var el = document.querySelector('.group-item[data-id="' + gid + '"]');
            if (el) {
                el.classList.add('highlight-change');
                setTimeout(function () { el.classList.remove('highlight-change'); }, 3000);
            }
        });
    },

    handleSyncImportConfirmed(data) {
        if (data && data.success) {
            showToast('\u540c\u6b65\u5bfc\u5165\u5df2\u786e\u8ba4', 'success');
            loadConfig();
            loadGroups(true);
        }
    },

    sendMessage(type, data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: type, data: data }));
            return true;
        }
        return false;
    }
};

function initScrollReveal() {
    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        const candidates = document.querySelectorAll('.sidebar, .main-content .card');
        if (!candidates.length) return;

        candidates.forEach((el) => { el.classList.add('reveal'); });

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    entry.target.classList.add('in-view');
                    observer.unobserve(entry.target);
                }
            },
            {
                threshold: 0.12,
                rootMargin: '0px 0px -10% 0px'
            }
        );

        candidates.forEach((el) => { observer.observe(el); });
    } catch (e) {
        console.warn('[UI] Scroll reveal init failed:', e);
    }
}

// === 初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    initScrollReveal();

    // 初始化 IndexedDB
    try {
        await IDB.init();
        console.log('[IDB] IndexedDB initialized');
    } catch (e) {
        console.warn('[IDB] IndexedDB init failed:', e);
        showToast('本地存储不可用，离线功能将受限', 'warning');
    }

    // 绑定同步按钮（必须在脚本作用域内绑定，避免与浏览器原生 SyncManager API 命名冲突）
    const syncBtn = document.getElementById('syncControl');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => SyncManager.toggle());
    }

    // 绑定手动添加群按钮
    const addGroupBtn = document.getElementById('addGroupBtn');
    if (addGroupBtn) {
        addGroupBtn.addEventListener('click', () => createGroupByInput());
    }

    // 初始化同步管理器
    try {
        SyncManager.init();
    } catch (e) {
        console.error('[SyncManager] Init failed:', e);
    }

    // 获取机器人自身信息
    try {
        await loadBotInfo();
    } catch (e) {
        console.warn('[Bot] Failed to load bot info:', e);
    }

    // 优先从 IndexedDB 加载离线数据
    await loadFromIndexedDB();

    // 加载远程配置
    await loadConfig();
    // 加载群列表
    await loadGroups();

    // 网络恢复时自动检查待同步数据
    window.addEventListener('online', () => {
        console.log('[Network] Online detected, checking pending syncs');
        showToast('网络已恢复，正在同步...', 'success');
        checkPendingSync();
    });

    window.addEventListener('offline', () => {
        console.log('[Network] Offline detected');
        showToast('网络已断开，已切换到离线模式', 'warning');
    });

    // 全局错误处理
    window.addEventListener('unhandledrejection', (event) => {
        console.error('[Unhandled Promise Rejection]', event.reason);
    });
});

// === 从 IndexedDB 加载离线数据 ===
async function loadFromIndexedDB() {
    try {
        const records = await IDB.getAll();
        if (records.length > 0) {
            records.forEach(r => {
                if (r.config && !config[r.group_id]) {
                    config[r.group_id] = r.config;
                }
                if (r.pending_sync) {
                    groupSavedState[r.group_id] = 'pending';
                }
            });
            console.log('[IDB] Loaded ' + records.length + ' group configs from IndexedDB');
        }
    } catch (e) {
        console.warn('[IDB] Failed to load from IndexedDB:', e);
    }
}

// === 离线同步检查 ===
async function checkPendingSync() {
    if (!IDB.db) return;

    const pending = await IDB.getPendingSyncs();
    if (pending.length === 0) return;

    // 尝试加载远程配置
    const remoteResult = await api('/api/config');
    if (!remoteResult.success) return;

    const remoteConfig = remoteResult.data;
    const diffs = [];

    for (const record of pending) {
        const gid = record.group_id;
        const localCfg = record.config;
        const remoteCfg = remoteConfig[gid];

        if (!remoteCfg) {
            diffs.push({ group_id: gid, type: 'local_only', local: localCfg, remote: null });
        } else if (JSON.stringify(localCfg) !== JSON.stringify(remoteCfg)) {
            diffs.push({ group_id: gid, type: 'conflict', local: localCfg, remote: remoteCfg });
        } else {
            await IDB.markSynced(gid);
        }
    }

    if (diffs.length > 0) {
        showMergeConfirmDialog(diffs);
    }
}

// === 合并确认弹窗 ===
function showMergeConfirmDialog(diffs) {
    let existingOverlay = document.getElementById('mergeConfirmModal');
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'mergeConfirmModal';

    const diffItems = diffs.map(function (d) {
        const typeName = d.type === 'local_only' ? '\u4ec5\u672c\u5730' : '\u51b2\u7a81';
        const typeClass = d.type === 'local_only' ? 'match-fuzzy' : 'match-none';
        const groupName = groupNameMap[d.group_id] || '\u7fa4 ' + d.group_id;
        const discardLabel = d.type === 'local_only' ? '\u4e22\u5f03\u672c\u5730' : '\u4f7f\u7528\u8fdc\u7a0b\u7248\u672c';

        return '<div class="conflict-item" data-gid="' + d.group_id + '">'
            + '<div class="conflict-header">'
            + '<span class="conflict-group-name">' + escapeHtml(groupName) + '</span>'
            + '<span class="match-status ' + typeClass + '">' + typeName + '</span>'
            + '</div>'
            + '<div class="conflict-resolution">'
            + '<label><input type="radio" name="merge_' + d.group_id + '" value="use_local" checked> \u4f7f\u7528\u672c\u5730\u7248\u672c</label>'
            + '<label><input type="radio" name="merge_' + d.group_id + '" value="use_remote"> ' + discardLabel + '</label>'
            + '</div>'
            + '</div>';
    }).join('');

    overlay.innerHTML = '<div class="modal">'
        + '<div class="modal-header">'
        + '<h3>\ud83d\udd04 \u53d1\u73b0\u672c\u5730\u79bb\u7ebf\u66f4\u6539</h3>'
        + '<button class="modal-close" onclick="closeMergeDialog()">&times;</button>'
        + '</div>'
        + '<div class="modal-body">'
        + '<div class="modal-hint">\u7f51\u7edc\u5df2\u6062\u590d\uff0c\u68c0\u6d4b\u5230 ' + diffs.length + ' \u4e2a\u7fa4\u7684\u672c\u5730\u66f4\u6539\u4e0e\u8fdc\u7a0b\u4e0d\u4e00\u81f4\uff1a</div>'
        + diffItems
        + '</div>'
        + '<div class="modal-footer">'
        + '<button class="btn btn-secondary" onclick="closeMergeDialog()">\u7a0d\u540e\u5904\u7406</button>'
        + '<button class="btn btn-primary" onclick="executeMerge()">\u786e\u8ba4\u5408\u5e76</button>'
        + '</div>'
        + '</div>';

    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMergeDialog(); });
    document.body.appendChild(overlay);

    window._pendingMergeDiffs = diffs;
}

function closeMergeDialog() {
    const overlay = document.getElementById('mergeConfirmModal');
    if (overlay) overlay.remove();
    window._pendingMergeDiffs = null;
}

async function executeMerge() {
    const diffs = window._pendingMergeDiffs;
    if (!diffs) return;

    for (const d of diffs) {
        const radio = document.querySelector('input[name="merge_' + d.group_id + '"]:checked');
        const choice = radio ? radio.value : 'use_local';

        if (choice === 'use_local') {
            const result = await api('/api/config/' + d.group_id, {
                method: 'POST',
                body: JSON.stringify(d.local)
            });
            if (result.success) {
                await IDB.markSynced(d.group_id);
            }
        } else {
            if (d.type === 'local_only') {
                await IDB.delete(d.group_id);
                delete config[d.group_id];
            } else {
                config[d.group_id] = d.remote;
                await IDB.put(d.group_id, d.remote, false);
            }
        }
    }

    closeMergeDialog();
    showToast('\u5408\u5e76\u5b8c\u6210', 'success');
    await loadConfig();
    await loadGroups();
    if (currentGroupId) {
        loadGroupConfig(currentGroupId);
        renderMembers();
    }
}

// === 认证失败处理 ===
window.addEventListener('api-unauthorized', (event) => {
    console.warn('API \u8ba4\u8bc1\u5931\u8d25:', event.detail);

    const newKey = prompt('API \u5bc6\u94a5\u65e0\u6548\u6216\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u8f93\u5165 API \u5bc6\u94a5\uff1a');
    if (newKey && newKey.trim()) {
        localStorage.setItem('apiKey', newKey.trim());
        location.reload();
    } else {
        showToast('\u672a\u8f93\u5165 API \u5bc6\u94a5\uff0c\u90e8\u5206\u529f\u80fd\u53ef\u80fd\u4e0d\u53ef\u7528', 'error');
    }
});

// === API 调用 ===
async function api(endpoint, options) {
    if (!options) options = {};
    try {
        var headers = {
            'Content-Type': 'application/json'
        };
        if (options.headers) {
            Object.assign(headers, options.headers);
        }

        var apiKey = localStorage.getItem('apiKey');
        if (apiKey) {
            headers['X-API-KEY'] = apiKey;
        }

        var url = API_BASE + endpoint;
        var response = await fetch(url, Object.assign({}, options, { headers: headers }));

        if (response.status === 401) {
            localStorage.removeItem('apiKey');
            window.dispatchEvent(new CustomEvent('api-unauthorized', {
                detail: { endpoint: endpoint, status: response.status }
            }));
            return {
                success: false,
                error: '\u672a\u6388\u6743\uff1aAPI \u5bc6\u94a5\u65e0\u6548\u6216\u5df2\u8fc7\u671f',
                status: 401,
                statusText: response.statusText
            };
        }

        var contentType = response.headers.get('content-type') || '';
        var isJson = contentType.includes('application/json');

        if (!response.ok) {
            if (isJson) {
                var errorData = await response.json();
                return {
                    success: false,
                    error: errorData.detail || errorData.error || response.statusText,
                    status: response.status,
                    statusText: response.statusText,
                    data: errorData
                };
            } else {
                var body = await response.text();
                return {
                    success: false,
                    error: response.statusText || 'Request failed',
                    status: response.status,
                    statusText: response.statusText,
                    body: body
                };
            }
        }

        if (isJson) {
            return await response.json();
        } else {
            var body2 = await response.text();
            return {
                success: true,
                body: body2,
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

// === 机器人信息 ===
async function loadBotInfo() {
    var result = await api('/api/bot/info');
    if (result.success && result.data) {
        botUserId = result.data.user_id;
    }
}

// === 群列表 ===
async function loadGroups(silent) {
    var container = document.getElementById('groupList');
    if (!silent) {
        container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }

    var result = await api('/api/groups');

    if (result.success) {
        botConnected = result.bot_connected !== false;
        updateStatus(botConnected);
        groupNameMap = {};
        result.data.forEach(function (g) {
            groupNameMap[g.group_id] = g.group_name;
        });
        renderGroups(result.data);

        // 同步到 IndexedDB（保留待同步状态）
        if (IDB.db) {
            for (var gid of Object.keys(config)) {
                var isPending = groupSavedState[gid] === 'pending' || groupSavedState[gid] === false;
                try { await IDB.put(gid, config[gid], isPending); } catch (e) { /* silent */ }
            }
        }
    } else {
        botConnected = false;
        updateStatus(false);

        // 尝试从 config 或 IndexedDB 渲染离线群列表
        var configKeys = Object.keys(config);
        if (configKeys.length > 0) {
            var offlineGroups = configKeys.map(function (gid) {
                return {
                    group_id: parseInt(gid) || gid,
                    group_name: groupNameMap[gid] || '\u7fa4 ' + gid,
                    member_count: 0,
                    offline: true
                };
            });
            renderGroups(offlineGroups);
        } else {
            // 尝试从 IndexedDB 加载
            try {
                var idbRecords = await IDB.getAll();
                if (idbRecords.length > 0) {
                    idbRecords.forEach(function (r) {
                        if (r.config) config[r.group_id] = r.config;
                    });
                    var idbGroups = idbRecords.map(function (r) {
                        return {
                            group_id: parseInt(r.group_id) || r.group_id,
                            group_name: groupNameMap[r.group_id] || '\u7fa4 ' + r.group_id,
                            member_count: 0,
                            offline: true
                        };
                    });
                    renderGroups(idbGroups);
                    return;
                }
            } catch (e) { /* IndexedDB not available */ }

            container.innerHTML = '<div class="empty-state">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
                + '<circle cx="12" cy="12" r="10"></circle>'
                + '<line x1="12" y1="8" x2="12" y2="12"></line>'
                + '<line x1="12" y1="16" x2="12.01" y2="16"></line>'
                + '</svg>'
                + '<h3>\u65e0\u6cd5\u8fde\u63a5\u5230\u673a\u5668\u4eba</h3>'
                + '<p>\u8bf7\u786e\u4fdd\u673a\u5668\u4eba\u5df2\u542f\u52a8\u5e76\u8fde\u63a5</p>'
                + '</div>';
        }
    }
}

function renderGroups(groups) {
    var container = document.getElementById('groupList');

    if (groups.length === 0) {
        container.innerHTML = '<div class="empty-state">'
            + '<h3>\u6682\u65e0\u7fa4\u804a</h3>'
            + '<p>\u673a\u5668\u4eba\u5c1a\u672a\u52a0\u5165\u4efb\u4f55\u7fa4\uff0c\u4e5f\u6ca1\u6709\u5df2\u4fdd\u5b58\u7684\u914d\u7f6e</p>'
            + '</div>';
        return;
    }

    var offlineBanner = '';
    if (!botConnected) {
        offlineBanner = '<div class="offline-banner">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
            + '<circle cx="12" cy="12" r="10"></circle>'
            + '<line x1="12" y1="8" x2="12" y2="12"></line>'
            + '<line x1="12" y1="16" x2="12.01" y2="16"></line>'
            + '</svg>'
            + '\u673a\u5668\u4eba\u672a\u8fde\u63a5\uff0c\u663e\u793a\u5df2\u914d\u7f6e\u7684\u7fa4\u804a'
            + '</div>';
    }

    var items = groups.map(function (g) {
        var gConfig = config[g.group_id];
        var isOffline = g.offline === true;
        var isPendingSync = groupSavedState[g.group_id] === 'pending';
        var summaryHtml = '';
        if (gConfig) {
            var userCount = gConfig.target_users ? gConfig.target_users.length : 0;
            var schedEnabled = gConfig.scheduled_mute ? gConfig.scheduled_mute.enabled : false;
            var threshold = gConfig.threshold != null ? gConfig.threshold : 5;
            var schedTag = schedEnabled
                ? '<span class="summary-tag summary-active" title="\u5b9a\u65f6\u7981\u8a00\u5df2\u542f\u7528">\u23f0</span>'
                : '';
            summaryHtml = '<div class="group-config-summary">'
                + '<span class="summary-tag" title="\u76d1\u63a7\u4eba\u6570">\ud83d\udc64 ' + userCount + '</span>'
                + '<span class="summary-tag" title="\u89e6\u53d1\u9608\u503c">\u26a1 ' + threshold + '</span>'
                + schedTag
                + '</div>';
        }
        var memberInfo = isOffline
            ? '' + g.group_id
            : g.group_id + ' \u00b7 ' + g.member_count + ' \u6210\u5458';
        var offlineTag = isOffline
            ? '<span class="offline-badge">\u79bb\u7ebf</span>'
            : '';
        var pendingSyncTag = isPendingSync
            ? '<span class="pending-sync-badge">\u5f85\u540c\u6b65</span>'
            : '';
        var configBadge = gConfig
            ? '<span class="configured-badge">\u5df2\u914d\u7f6e</span>'
            : '';
        var offlineClass = isOffline ? ' group-offline' : '';
        var deleteBtn = isOffline
            ? '<button class="group-delete-btn" type="button" title="\u5220\u9664\u79bb\u7ebf\u914d\u7f6e" onclick="event.stopPropagation(); deleteOfflineGroup(\'' + g.group_id + '\')">'
                + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
                + '<line x1="18" y1="6" x2="6" y2="18"></line>'
                + '<line x1="6" y1="6" x2="18" y2="18"></line>'
                + '</svg></button>'
            : '';

        return '<div class="group-item' + offlineClass + '" data-id="' + g.group_id + '" onclick="selectGroup(' + g.group_id + ')">'
            + '<div class="group-avatar">\ud83d\udc65</div>'
            + '<div class="group-info">'
            + '<h4>' + escapeHtml(g.group_name) + ' ' + offlineTag + pendingSyncTag + '</h4>'
            + '<small>' + memberInfo + '</small>'
            + summaryHtml
            + '</div>'
            + configBadge
            + deleteBtn
            + '</div>';
    }).join('');

    container.innerHTML = offlineBanner + items;
}

// === 手动通过群号创建配置 ===
function createGroupByInput() {
    var input = prompt('请输入群号（5-12 位数字）：');
    if (input === null) return; // 取消

    var groupId = input.trim();
    if (!/^\d{5,12}$/.test(groupId)) {
        showToast('群号格式无效，请输入 5-12 位数字', 'error');
        return;
    }

    // 如果已存在则直接选中
    if (config[groupId]) {
        showToast('该群配置已存在，已为你选中', 'warning');
        selectGroup(groupId);
        return;
    }

    // 创建默认配置
    config[groupId] = JSON.parse(JSON.stringify(DEFAULT_GROUP_CONFIG));
    groupSavedState[groupId] = 'pending';

    // 存入 IndexedDB
    if (IDB.db) {
        IDB.put(groupId, config[groupId], true).catch(function () { /* silent */ });
    }

    // 重新渲染群列表
    var allGroupIds = Object.keys(config);
    var groups = allGroupIds.map(function (gid) {
        return {
            group_id: parseInt(gid) || gid,
            group_name: groupNameMap[gid] || '群 ' + gid,
            member_count: 0,
            offline: !botConnected
        };
    });
    renderGroups(groups);

    showToast('已为群 ' + groupId + ' 创建默认配置', 'success');

    // 自动选中新建的群
    selectGroup(groupId);
}

// === 删除离线群配置 ===
async function deleteOfflineGroup(groupId) {
    if (!confirm('确定要删除群 ' + groupId + ' 的离线配置吗？')) return;

    // 尝试从服务器删除
    var result = await api('/api/config/' + groupId, { method: 'DELETE' });
    // 无论服务器是否可达，都从本地清理
    delete config[groupId];
    delete groupSavedState[groupId];

    // 从 IndexedDB 删除
    try { await IDB.delete(groupId); } catch (e) { /* silent */ }

    // 如果当前选中的就是这个群，重置面板
    if (String(currentGroupId) === String(groupId)) {
        currentGroupId = null;
        document.getElementById('mainContent').style.display = 'none';
        document.getElementById('emptyContent').style.display = 'flex';
    }

    // 重新渲染群列表
    var allGroupIds = Object.keys(config);
    if (allGroupIds.length > 0) {
        var groups = allGroupIds.map(function (gid) {
            return {
                group_id: parseInt(gid) || gid,
                group_name: groupNameMap[gid] || '群 ' + gid,
                member_count: 0,
                offline: !botConnected
            };
        });
        renderGroups(groups);
    } else {
        await loadGroups();
    }

    showToast('已删除群 ' + groupId + ' 的配置', 'success');
}

// === 选择群 ===
async function selectGroup(groupId) {
    currentGroupId = groupId;

    document.querySelectorAll('.group-item').forEach(function (el) {
        el.classList.toggle('active', el.dataset.id == groupId);
    });

    document.getElementById('mainContent').style.display = 'flex';
    document.getElementById('emptyContent').style.display = 'none';

    await loadMembers(groupId);
    loadGroupConfig(groupId);
}

// === 群成员列表 ===
async function loadMembers(groupId, silent) {
    var container = document.getElementById('memberGrid');
    if (!silent) {
        container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    }

    var result = await api('/api/groups/' + groupId + '/members');

    if (result.success) {
        groupMembers = result.data;
        // 隐藏离线添加控件
        var addControl = document.getElementById('offlineMemberAdd');
        if (addControl) addControl.style.display = 'none';
        renderMembers();
    } else {
        groupMembers = [];
        if (!silent) {
            // 离线模式：从配置加载 target_users
            renderOfflineMembers();
        } else {
            console.warn('\u9759\u9ed8\u5237\u65b0\u6210\u5458\u5217\u8868\u5931\u8d25:', result.error);
        }
    }
}

function renderMembers(filter) {
    if (!filter) filter = '';
    var container = document.getElementById('memberGrid');
    var groupConfig = config[currentGroupId] || { target_users: [] };
    var targetUsers = groupConfig.target_users || [];

    // 如果离线且无成员数据，显示离线成员列表
    if (!botConnected && groupMembers.length === 0) {
        renderOfflineMembers(filter);
        return;
    }

    // 隐藏离线添加控件
    var addControl = document.getElementById('offlineMemberAdd');
    if (addControl) addControl.style.display = 'none';

    var filtered = groupMembers.slice();

    // 过滤机器人自身
    if (botUserId) {
        filtered = filtered.filter(function (m) { return m.user_id !== botUserId; });
    }

    if (filter) {
        var lowerFilter = filter.toLowerCase();
        filtered = filtered.filter(function (m) {
            return m.nickname.toLowerCase().includes(lowerFilter) ||
                m.card.toLowerCase().includes(lowerFilter) ||
                String(m.user_id).includes(filter);
        });
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>\u65e0\u5339\u914d\u6210\u5458</p></div>';
        return;
    }

    container.innerHTML = filtered.map(function (m) {
        var isSelected = targetUsers.includes(m.user_id);
        var displayName = m.card || m.nickname || '\u672a\u77e5';
        var safeAvatar = escapeHtml(m.avatar || '');
        return '<div class="member-item ' + (isSelected ? 'selected' : '') + '" '
            + 'data-id="' + m.user_id + '" onclick="toggleMember(' + m.user_id + ')">'
            + '<img class="member-avatar" src="' + safeAvatar + '" alt="' + escapeHtml(displayName) + '" '
            + 'onerror="this.src=\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%2330363d%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%238b949e%22 font-size=%2240%22>\ud83d\udc64</text></svg>\'">'
            + '<div class="member-info">'
            + '<div class="member-name">' + escapeHtml(displayName) + '</div>'
            + '<div class="member-id">' + m.user_id + '</div>'
            + '</div>'
            + '<div class="member-checkbox">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">'
            + '<polyline points="20 6 9 17 4 12"></polyline>'
            + '</svg>'
            + '</div>'
            + '</div>';
    }).join('');
}

// === 离线成员列表渲染 ===
function renderOfflineMembers(filter) {
    if (!filter) filter = '';
    var container = document.getElementById('memberGrid');
    var groupConfig = config[currentGroupId] || { target_users: [] };
    var targetUsers = groupConfig.target_users || [];

    // 显示离线添加控件
    var addControl = document.getElementById('offlineMemberAdd');
    if (addControl) addControl.style.display = 'flex';

    var filtered = targetUsers;
    if (filter) {
        filtered = filtered.filter(function (uid) { return String(uid).includes(filter); });
    }

    if (filtered.length === 0 && !filter) {
        container.innerHTML = '<div class="empty-state"><p>\u6682\u65e0\u76d1\u63a7\u6210\u5458\uff0c\u53ef\u624b\u52a8\u6dfb\u52a0 QQ \u53f7</p></div>';
        return;
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>\u65e0\u5339\u914d\u6210\u5458</p></div>';
        return;
    }

    container.innerHTML = filtered.map(function (uid) {
        return '<div class="member-item selected offline-member" data-id="' + uid + '">'
            + '<div class="member-avatar-placeholder">\ud83d\udc64</div>'
            + '<div class="member-info">'
            + '<div class="member-name">' + uid + '</div>'
            + '<div class="member-id">\u79bb\u7ebf\u6a21\u5f0f</div>'
            + '</div>'
            + '<button class="btn-remove-member" onclick="event.stopPropagation(); removeOfflineMember(' + uid + ')" title="\u79fb\u9664">'
            + '\u2715'
            + '</button>'
            + '</div>';
    }).join('');
}

// === 离线添加成员 ===
function validateOfflineQQ(input) {
    var value = input.value.replace(/\D/g, '');
    input.value = value;
    var errorEl = document.getElementById('offlineQQError');

    if (!value) {
        errorEl.textContent = '';
        return;
    }

    if (value.length < 5) {
        errorEl.textContent = 'QQ \u53f7\u81f3\u5c11 5 \u4f4d';
    } else if (value.length > 12) {
        errorEl.textContent = 'QQ \u53f7\u6700\u591a 12 \u4f4d';
    } else {
        // 检查重复
        var groupConfig = config[currentGroupId] || { target_users: [] };
        var targetUsers = groupConfig.target_users || [];
        if (targetUsers.includes(parseInt(value))) {
            errorEl.textContent = '\u8be5 QQ \u53f7\u5df2\u5728\u5217\u8868\u4e2d';
        } else {
            errorEl.textContent = '';
        }
    }
}

async function addOfflineMember() {
    if (!currentGroupId) return;

    var input = document.getElementById('offlineQQInput');
    var errorEl = document.getElementById('offlineQQError');
    var value = input.value.trim();

    // 校验：5-12 位纯数字
    if (!/^\d{5,12}$/.test(value)) {
        errorEl.textContent = '\u8bf7\u8f93\u5165 5-12 \u4f4d\u6570\u5b57 QQ \u53f7';
        return;
    }

    var userId = parseInt(value);

    ensureGroupConfig();
    var targetUsers = config[currentGroupId].target_users;

    // 检查重复
    if (targetUsers.includes(userId)) {
        errorEl.textContent = '\u8be5 QQ \u53f7\u5df2\u5728\u5217\u8868\u4e2d';
        return;
    }

    targetUsers.push(userId);
    input.value = '';
    errorEl.textContent = '';

    // 持久化到 IndexedDB
    try {
        await IDB.put(currentGroupId, config[currentGroupId], true);
        groupSavedState[currentGroupId] = 'pending';
    } catch (e) {
        console.warn('[IDB] Failed to persist offline add:', e);
    }

    renderOfflineMembers();
    updateSelectedCount();
    showToast('\u5df2\u6dfb\u52a0 QQ ' + userId + '\uff08\u5f85\u540c\u6b65\uff09', 'success');
}

async function removeOfflineMember(userId) {
    if (!currentGroupId) return;

    ensureGroupConfig();
    var targetUsers = config[currentGroupId].target_users;
    var index = targetUsers.indexOf(userId);

    if (index > -1) {
        targetUsers.splice(index, 1);
    }

    // 持久化到 IndexedDB
    try {
        await IDB.put(currentGroupId, config[currentGroupId], true);
        groupSavedState[currentGroupId] = 'pending';
    } catch (e) {
        console.warn('[IDB] Failed to persist offline remove:', e);
    }

    renderOfflineMembers();
    updateSelectedCount();
    showToast('\u5df2\u79fb\u9664 QQ ' + userId + '\uff08\u5f85\u540c\u6b65\uff09', 'success');
}

function toggleMember(userId) {
    if (!currentGroupId) return;

    ensureGroupConfig();

    var targetUsers = config[currentGroupId].target_users;
    var index = targetUsers.indexOf(userId);

    if (index > -1) {
        targetUsers.splice(index, 1);
    } else {
        targetUsers.push(userId);
    }

    var el = document.querySelector('.member-item[data-id="' + userId + '"]');
    if (el) el.classList.toggle('selected');

    updateSelectedCount();
}

function updateSelectedCount() {
    var count = config[currentGroupId] && config[currentGroupId].target_users
        ? config[currentGroupId].target_users.length : 0;
    document.getElementById('selectedCount').textContent = count;
}

// === 配置管理 ===
async function loadConfig() {
    var result = await api('/api/config');
    if (result.success) {
        config = result.data;
        // 保留本地待同步状态：不覆盖 pending_sync 记录
        for (var groupId of Object.keys(config)) {
            if (groupSavedState[groupId] !== 'pending' && groupSavedState[groupId] !== false) {
                groupSavedState[groupId] = true;
            }
        }

        // 同步到 IndexedDB，保留本地待同步的记录
        try {
            var existingRecords = await IDB.getAll();
            var pendingIds = {};
            existingRecords.forEach(function (rec) {
                if (rec.pending_sync) {
                    pendingIds[rec.group_id] = true;
                }
            });

            // 只写入非 pending 的记录
            var toSync = {};
            for (var gid of Object.keys(config)) {
                if (!pendingIds[gid]) {
                    toSync[gid] = config[gid];
                }
            }
            if (Object.keys(toSync).length > 0) {
                await IDB.bulkPut(toSync, false);
            }
        } catch (e) {
            console.warn('[IDB] Failed to sync config to IndexedDB:', e);
        }

        // 刷新群列表已配置标记
        var groups = document.querySelectorAll('.group-item');
        groups.forEach(function (g) {
            var id = g.dataset.id;
            var badge = g.querySelector('.configured-badge');
            if (config[id] && !badge) {
                g.insertAdjacentHTML('beforeend', '<span class="configured-badge">\u5df2\u914d\u7f6e</span>');
            }
        });
    }
}

function loadGroupConfig(groupId) {
    var groupConfig = config[groupId] || JSON.parse(JSON.stringify(DEFAULT_GROUP_CONFIG));

    document.getElementById('threshold').value = String(groupConfig.threshold != null ? groupConfig.threshold : 5);
    document.getElementById('comboTimeout').value = String(groupConfig.combo_timeout != null ? groupConfig.combo_timeout : 180);
    document.getElementById('cooldown').value = String(groupConfig.scheduled_mute ? (groupConfig.scheduled_mute.cooldown != null ? groupConfig.scheduled_mute.cooldown : 30) : 30);

    var toggle = document.getElementById('scheduledMuteToggle');
    var isEnabled = groupConfig.scheduled_mute ? groupConfig.scheduled_mute.enabled : false;
    toggle.classList.toggle('active', isEnabled);
    toggle.setAttribute('aria-checked', isEnabled.toString());

    selectedDay = 'default';
    renderDayTabs();
    renderTimeRanges();
    updateSelectedCount();
}

// === 时间段配置 ===
function renderDayTabs() {
    var container = document.getElementById('dayTabs');
    var ranges = config[currentGroupId] && config[currentGroupId].scheduled_mute
        ? config[currentGroupId].scheduled_mute.ranges || {} : {};

    container.innerHTML = DAYS.map(function (d) {
        var hasRanges = ranges[d.key] && ranges[d.key].length > 0;
        return '<button class="day-tab ' + (selectedDay === d.key ? 'active' : '') + '" '
            + 'onclick="selectDay(\'' + d.key + '\')">'
            + d.label + (hasRanges && d.key !== 'default' ? ' \u2022' : '')
            + '</button>';
    }).join('');
}

function selectDay(day) {
    selectedDay = day === 'default' ? 'default' : parseInt(day);
    renderDayTabs();
    renderTimeRanges();
}

function renderTimeRanges() {
    var container = document.getElementById('timeRangeList');
    var groupConfig = config[currentGroupId] || {};
    var ranges = groupConfig.scheduled_mute ? groupConfig.scheduled_mute.ranges || {} : {};
    var dayRanges = ranges[selectedDay] || [];

    container.innerHTML = '';

    if (dayRanges.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding: 20px;"><p>\u6682\u65e0\u65f6\u95f4\u6bb5\uff0c\u70b9\u51fb\u4e0b\u65b9\u6dfb\u52a0</p></div>';
    } else {
        dayRanges.forEach(function (r, i) {
            var item = document.createElement('div');
            item.className = 'time-range-item';

            var startInput = document.createElement('input');
            startInput.type = 'time';
            startInput.value = r[0] || '';
            startInput.addEventListener('change', function () { updateTimeRange(i, 0, startInput.value); });

            var span = document.createElement('span');
            span.textContent = '\u81f3';

            var endInput = document.createElement('input');
            endInput.type = 'time';
            endInput.value = r[1] || '';
            endInput.addEventListener('change', function () { updateTimeRange(i, 1, endInput.value); });

            var btn = document.createElement('button');
            btn.className = 'btn-remove';
            btn.textContent = '\u5220\u9664';
            btn.addEventListener('click', function () { removeTimeRange(i); });

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
    var ranges = config[currentGroupId] && config[currentGroupId].scheduled_mute
        ? config[currentGroupId].scheduled_mute.ranges : null;
    if (ranges && ranges[selectedDay] && ranges[selectedDay][index]) {
        ranges[selectedDay][index][pos] = value;
    }
}

function removeTimeRange(index) {
    if (!currentGroupId) return;
    var ranges = config[currentGroupId] && config[currentGroupId].scheduled_mute
        ? config[currentGroupId].scheduled_mute.ranges : null;
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
var CONFIG_LIMITS = {
    threshold: { min: 0, max: 100, default: 5, label: '\u89e6\u53d1\u9608\u503c' },
    combo_timeout: { min: 1, max: 3600, default: 180, label: '\u8fde\u51fb\u8d85\u65f6' },
    cooldown: { min: 1, max: 3600, default: 30, label: '\u51b7\u5374\u65f6\u95f4' }
};

function validateAndClamp(value, limits) {
    if (Number.isNaN(value)) {
        return { valid: true, value: limits.default, clamped: false };
    }
    if (value < limits.min || value > limits.max) {
        return { valid: false, value: value, min: limits.min, max: limits.max };
    }
    return { valid: true, value: value, clamped: false };
}

async function saveConfig() {
    if (!currentGroupId) {
        showToast('\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u7fa4', 'error');
        return;
    }

    ensureGroupConfig();

    var parsedThreshold = parseInt(document.getElementById('threshold').value);
    var parsedTimeout = parseInt(document.getElementById('comboTimeout').value);
    var parsedCooldown = parseInt(document.getElementById('cooldown').value);

    var thresholdResult = validateAndClamp(parsedThreshold, CONFIG_LIMITS.threshold);
    var timeoutResult = validateAndClamp(parsedTimeout, CONFIG_LIMITS.combo_timeout);
    var cooldownResult = validateAndClamp(parsedCooldown, CONFIG_LIMITS.cooldown);

    var errors = [];
    if (!thresholdResult.valid) {
        errors.push(CONFIG_LIMITS.threshold.label + '\u5fc5\u987b\u5728 ' + thresholdResult.min + '-' + thresholdResult.max + ' \u4e4b\u95f4');
    }
    if (!timeoutResult.valid) {
        errors.push(CONFIG_LIMITS.combo_timeout.label + '\u5fc5\u987b\u5728 ' + timeoutResult.min + '-' + timeoutResult.max + ' \u79d2\u4e4b\u95f4');
    }
    if (!cooldownResult.valid) {
        errors.push(CONFIG_LIMITS.cooldown.label + '\u5fc5\u987b\u5728 ' + cooldownResult.min + '-' + cooldownResult.max + ' \u79d2\u4e4b\u95f4');
    }

    if (errors.length > 0) {
        showToast(errors.join('\uff1b'), 'error');
        return;
    }

    config[currentGroupId].threshold = thresholdResult.value;
    config[currentGroupId].combo_timeout = timeoutResult.value;
    config[currentGroupId].scheduled_mute.cooldown = cooldownResult.value;
    config[currentGroupId].scheduled_mute.enabled = document.getElementById('scheduledMuteToggle').classList.contains('active');

    var result = await api('/api/config/' + currentGroupId, {
        method: 'POST',
        body: JSON.stringify(config[currentGroupId])
    });

    if (result.success) {
        showToast('\u914d\u7f6e\u5df2\u4fdd\u5b58', 'success');
        groupSavedState[currentGroupId] = true;

        // 同步到 IndexedDB（标记已同步）
        try { await IDB.put(currentGroupId, config[currentGroupId], false); } catch (e) { /* silent */ }

        var groupItem = document.querySelector('.group-item[data-id="' + currentGroupId + '"]');
        if (groupItem && !groupItem.querySelector('.configured-badge')) {
            groupItem.insertAdjacentHTML('beforeend', '<span class="configured-badge">\u5df2\u914d\u7f6e</span>');
        }
    } else {
        showToast('\u4fdd\u5b58\u5931\u8d25: ' + result.error, 'error');

        // 离线持久化：将失败的配置写入 IndexedDB 并标记为待同步
        try {
            await IDB.put(currentGroupId, config[currentGroupId], true);
        } catch (e) {
            console.warn('[IDB] Failed to persist pending config:', e);
        }
        groupSavedState[currentGroupId] = 'pending';
    }
}

async function deleteConfig() {
    if (!currentGroupId) return;
    if (!confirm('\u786e\u5b9a\u8981\u5220\u9664\u8be5\u7fa4\u7684\u914d\u7f6e\u5417\uff1f')) return;

    var result = await api('/api/config/' + currentGroupId, { method: 'DELETE' });

    if (result.success) {
        delete config[currentGroupId];
        delete groupSavedState[currentGroupId];

        // 从 IndexedDB 删除
        try { await IDB.delete(currentGroupId); } catch (e) { /* silent */ }

        showToast('\u914d\u7f6e\u5df2\u5220\u9664', 'success');

        var groupItem = document.querySelector('.group-item[data-id="' + currentGroupId + '"]');
        var badge = groupItem ? groupItem.querySelector('.configured-badge') : null;
        if (badge) badge.remove();

        loadGroupConfig(currentGroupId);
        renderMembers();
    } else {
        showToast('\u5220\u9664\u5931\u8d25', 'error');
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
    var toggle = document.getElementById('scheduledMuteToggle');
    toggle.classList.toggle('active');
    var isActive = toggle.classList.contains('active');
    toggle.setAttribute('aria-checked', isActive.toString());
}

function updateStatus(connected) {
    var dot = document.getElementById('statusDot');
    var text = document.getElementById('statusText');
    dot.classList.toggle('connected', connected);
    text.textContent = connected ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5';
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function showToast(message, type) {
    if (!type) type = 'success';
    var container = document.getElementById('toastContainer');
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.innerHTML = type === 'success'
        ? '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'
        : type === 'warning'
        ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'
        : '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>';

    var span = document.createElement('span');
    span.textContent = message;

    toast.appendChild(svg);
    toast.appendChild(span);
    container.appendChild(toast);

    setTimeout(function () {
        toast.style.opacity = '0';
        setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
}

// === 导出文件名生成 ===
function generateExportFilename(groupIds) {
    var now = new Date();
    var year = now.getFullYear().toString();
    var month = String(now.getMonth() + 1).padStart(2, '0');
    var day = String(now.getDate()).padStart(2, '0');
    var hours = String(now.getHours()).padStart(2, '0');
    var minutes = String(now.getMinutes()).padStart(2, '0');
    var seconds = String(now.getSeconds()).padStart(2, '0');

    var prefix;
    if (groupIds.length === 1) {
        prefix = String(groupIds[0]);
    } else {
        prefix = String(groupIds[0]) + '\u7b49' + groupIds.length + '\u7fa4';
    }

    var baseName = prefix + '_' + year + '_' + month + '_' + day + '_' + hours + minutes + seconds;

    // 同一会话内的文件名去重
    if (downloadCounter[baseName] != null) {
        downloadCounter[baseName]++;
        return baseName + '_' + downloadCounter[baseName] + '.json';
    } else {
        downloadCounter[baseName] = 0;
        return baseName + '.json';
    }
}

// === 配置导入导出 ===
function triggerDownload(content, filename) {
    var blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// === 批量导出 ===
function openBatchExportModal() {
    var savedGroups = Object.keys(config).filter(function (gid) { return groupSavedState[gid]; });

    if (savedGroups.length === 0) {
        showToast('\u5f53\u524d\u6ca1\u6709\u5df2\u4fdd\u5b58\u7684\u7fa4\u914d\u7f6e\u53ef\u5bfc\u51fa', 'error');
        return;
    }

    var overlay = document.getElementById('batchExportModal');
    var listContainer = document.getElementById('exportGroupList');

    listContainer.innerHTML = savedGroups.map(function (gid) {
        var name = escapeHtml(groupNameMap[gid] || '\u672a\u77e5\u7fa4\u804a');
        var safeGid = escapeHtml(String(gid));
        return '<label class="export-group-item" data-gid="' + safeGid + '">'
            + '<input type="checkbox" checked value="' + safeGid + '">'
            + '<div class="export-group-info">'
            + '<span class="export-group-name">' + name + '</span>'
            + '<span class="export-group-id">' + safeGid + '</span>'
            + '</div>'
            + '</label>';
    }).join('');

    overlay.style.display = 'flex';
}

function closeBatchExportModal() {
    document.getElementById('batchExportModal').style.display = 'none';
}

function toggleAllExportGroups() {
    var checkboxes = document.querySelectorAll('#exportGroupList input[type="checkbox"]');
    var allChecked = Array.from(checkboxes).every(function (cb) { return cb.checked; });
    checkboxes.forEach(function (cb) { cb.checked = !allChecked; });
}

function executeBatchExport() {
    var checkboxes = document.querySelectorAll('#exportGroupList input[type="checkbox"]:checked');
    var selectedIds = Array.from(checkboxes).map(function (cb) { return cb.value; });

    if (selectedIds.length === 0) {
        showToast('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u7fa4', 'error');
        return;
    }

    var exportData = {};
    selectedIds.forEach(function (gid) {
        if (config[gid]) {
            exportData[gid] = config[gid];
        }
    });

    var now = new Date();
    var isoDate = now.toISOString();

    // 使用新的文件名格式：群号_YYYY_MM_DD_HHmmss.json
    var filename = generateExportFilename(selectedIds);

    // 根节点追加关键数据（需求1）
    var finalExport = {
        meta: {
            version: '1.0',
            date: isoDate,
            type: selectedIds.length === 1 ? 'single' : 'batch',
            generator: 'QQ-Auto-Mute-Script WebUI'
        },
        group_ids: selectedIds.map(function (id) { return String(id); }),
        group_count: selectedIds.length,
        configs: exportData
    };

    var content = JSON.stringify(finalExport, null, 4);
    triggerDownload(content, filename);

    showToast('\u5df2\u5bfc\u51fa ' + selectedIds.length + ' \u4e2a\u7fa4\u7684\u914d\u7f6e', 'success');
    closeBatchExportModal();
}

// === 导入配置验证 ===
const CONFIG_SCHEMA = {
    target_users: { type: 'array', itemType: 'number', default: [] },
    threshold: { type: 'number', min: 0, max: 100, default: 5 },
    combo_timeout: { type: 'number', min: 1, max: 3600, default: 180 },
    scheduled_mute: {
        type: 'object',
        default: { enabled: false, cooldown: 30, ranges: { default: [] } },
        properties: {
            enabled: { type: 'boolean', default: false },
            cooldown: { type: 'number', min: 1, max: 3600, default: 30 },
            ranges: { type: 'object', default: { default: [] } }
        }
    }
};

/**
 * 验证并修复单个群配置，返回 { valid, config, warnings, errors }
 */
function validateGroupConfig(key, cfg) {
    var warnings = [];
    var errors = [];

    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
        return { valid: false, config: null, warnings: [], errors: ['配置必须是对象类型'] };
    }

    var result = {};

    // target_users
    if (cfg.target_users !== undefined) {
        if (!Array.isArray(cfg.target_users)) {
            errors.push('target_users 必须是数组');
            result.target_users = [];
        } else {
            // 过滤掉非数字并去重
            var validUsers = [];
            var seen = {};
            cfg.target_users.forEach(function (u) {
                var num = typeof u === 'string' ? parseInt(u) : u;
                if (typeof num === 'number' && !isNaN(num) && num > 0) {
                    if (!seen[num]) {
                        seen[num] = true;
                        validUsers.push(num);
                    }
                } else {
                    warnings.push('target_users 中的无效值 "' + u + '" 已忽略');
                }
            });
            result.target_users = validUsers;
            if (validUsers.length !== cfg.target_users.length) {
                warnings.push('target_users 已自动去重/修正（' + cfg.target_users.length + ' → ' + validUsers.length + '）');
            }
        }
    } else {
        result.target_users = [];
        warnings.push('缺少 target_users 字段，已使用默认值 []');
    }

    // threshold
    if (cfg.threshold !== undefined) {
        var th = parseInt(cfg.threshold);
        if (isNaN(th)) {
            errors.push('threshold 必须是数字');
            result.threshold = 5;
        } else if (th < 0 || th > 100) {
            warnings.push('threshold 值 ' + th + ' 超出范围 (0-100)，已修正为 ' + Math.max(0, Math.min(100, th)));
            result.threshold = Math.max(0, Math.min(100, th));
        } else {
            result.threshold = th;
        }
    } else {
        result.threshold = 5;
        warnings.push('缺少 threshold 字段，已使用默认值 5');
    }

    // combo_timeout
    if (cfg.combo_timeout !== undefined) {
        var ct = parseInt(cfg.combo_timeout);
        if (isNaN(ct)) {
            errors.push('combo_timeout 必须是数字');
            result.combo_timeout = 180;
        } else if (ct < 1 || ct > 3600) {
            warnings.push('combo_timeout 值 ' + ct + ' 超出范围 (1-3600)，已修正为 ' + Math.max(1, Math.min(3600, ct)));
            result.combo_timeout = Math.max(1, Math.min(3600, ct));
        } else {
            result.combo_timeout = ct;
        }
    } else {
        result.combo_timeout = 180;
        warnings.push('缺少 combo_timeout 字段，已使用默认值 180');
    }

    // scheduled_mute
    if (cfg.scheduled_mute !== undefined) {
        if (typeof cfg.scheduled_mute !== 'object' || cfg.scheduled_mute === null) {
            errors.push('scheduled_mute 必须是对象');
            result.scheduled_mute = { enabled: false, cooldown: 30, ranges: { default: [] } };
        } else {
            var sm = cfg.scheduled_mute;
            result.scheduled_mute = {
                enabled: typeof sm.enabled === 'boolean' ? sm.enabled : false,
                cooldown: 30,
                ranges: { default: [] }
            };

            // cooldown
            if (sm.cooldown !== undefined) {
                var cd = parseInt(sm.cooldown);
                if (!isNaN(cd) && cd >= 1 && cd <= 3600) {
                    result.scheduled_mute.cooldown = cd;
                } else if (!isNaN(cd)) {
                    result.scheduled_mute.cooldown = Math.max(1, Math.min(3600, cd));
                    warnings.push('scheduled_mute.cooldown 已修正为 ' + result.scheduled_mute.cooldown);
                }
            }

            // ranges
            if (sm.ranges && typeof sm.ranges === 'object') {
                var validRanges = {};
                var validDays = ['default', '0', '1', '2', '3', '4', '5', '6'];
                for (var dayKey in sm.ranges) {
                    if (!validDays.includes(String(dayKey))) {
                        warnings.push('scheduled_mute.ranges 中的无效键 "' + dayKey + '" 已忽略');
                        continue;
                    }
                    var dayRanges = sm.ranges[dayKey];
                    if (!Array.isArray(dayRanges)) {
                        warnings.push('scheduled_mute.ranges["' + dayKey + '"] 不是数组，已忽略');
                        continue;
                    }
                    var validDayRanges = [];
                    dayRanges.forEach(function (r) {
                        if (Array.isArray(r) && r.length === 2 &&
                            typeof r[0] === 'string' && typeof r[1] === 'string' &&
                            /^\d{2}:\d{2}$/.test(r[0]) && /^\d{2}:\d{2}$/.test(r[1])) {
                            validDayRanges.push(r);
                        } else {
                            warnings.push('时间段格式无效 [' + JSON.stringify(r) + ']，已忽略');
                        }
                    });
                    if (validDayRanges.length > 0 || dayKey === 'default') {
                        validRanges[dayKey] = validDayRanges;
                    }
                }
                if (!validRanges.default) validRanges.default = [];
                result.scheduled_mute.ranges = validRanges;
            }
        }
    } else {
        result.scheduled_mute = { enabled: false, cooldown: 30, ranges: { default: [] } };
        warnings.push('缺少 scheduled_mute 字段，已使用默认配置');
    }

    return { valid: errors.length === 0, config: result, warnings: warnings, errors: errors };
}

/**
 * 批量验证导入配置，返回 { validConfigs, allWarnings, allErrors, summary }
 */
function validateImportConfig(configsToImport) {
    var validConfigs = {};
    var allWarnings = [];
    var allErrors = [];
    var fixedCount = 0;
    var errorCount = 0;

    for (var key in configsToImport) {
        if (!configsToImport.hasOwnProperty(key)) continue;

        var result = validateGroupConfig(key, configsToImport[key]);

        if (result.valid) {
            validConfigs[key] = result.config;
            if (result.warnings.length > 0) {
                fixedCount++;
                result.warnings.forEach(function (w) {
                    allWarnings.push('[' + key + '] ' + w);
                });
            }
        } else {
            errorCount++;
            result.errors.forEach(function (e) {
                allErrors.push('[' + key + '] ' + e);
            });
            // 即使有错误也尝试使用修正后的配置
            if (result.config) {
                validConfigs[key] = result.config;
                fixedCount++;
            }
        }
    }

    return {
        validConfigs: validConfigs,
        allWarnings: allWarnings,
        allErrors: allErrors,
        summary: {
            total: Object.keys(configsToImport).length,
            valid: Object.keys(validConfigs).length,
            fixed: fixedCount,
            failed: errorCount
        }
    };
}

// === 导入配置 - 两阶段流程（含群号冲突检测）===
let importPreviewData = null;
let importParsedConfig = null;

function importConfig() {
    var fileInput = document.getElementById('configFileInput');
    fileInput.value = '';
    fileInput.onchange = async function (e) {
        var file = e.target.files[0];
        if (!file) return;

        var text;
        try {
            text = await file.text();
        } catch (err) {
            showToast('读取文件失败', 'error');
            return;
        }

        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            showToast('文件不是有效的 JSON 格式', 'error');
            return;
        }

        // 兼容包装格式（WebUI 导出的带 meta/configs 的文件）
        var configsToImport = parsed;
        if (parsed.meta && parsed.configs) {
            configsToImport = parsed.configs;
        }

        if (typeof configsToImport !== 'object' || Array.isArray(configsToImport)) {
            showToast('配置格式错误：应为 { "群号": { ... } } 结构', 'error');
            return;
        }

        var importKeys = Object.keys(configsToImport);
        if (importKeys.length === 0) {
            showToast('配置文件为空，没有可导入的群配置', 'error');
            return;
        }

        // 前端配置验证：检查字段类型、范围，自动修正无效值
        var validation = validateImportConfig(configsToImport);
        if (validation.summary.valid === 0) {
            showToast('所有配置验证失败，无法导入', 'error');
            console.error('[Import] Validation errors:', validation.allErrors);
            return;
        }

        // 使用验证修正后的配置
        configsToImport = validation.validConfigs;
        importParsedConfig = configsToImport;

        if (validation.allWarnings.length > 0) {
            console.warn('[Import] 验证警告:', validation.allWarnings);
        }
        if (validation.allErrors.length > 0) {
            console.warn('[Import] 验证错误（已尝试修正）:', validation.allErrors);
        }

        // 尝试调用后端预览 API
        var previewResult = await api('/api/config/import/preview', {
            method: 'POST',
            body: JSON.stringify(parsed)
        });

        if (previewResult.success && previewResult.data) {
            // 在线：使用服务端预览，打开预览模态框
            importPreviewData = previewResult.data;
            openImportPreviewModal(importPreviewData);
        } else {
            // 离线或预览失败：回退到本地直接合并
            console.warn('[Import] Preview API unavailable, falling back to local merge');
            await importFallbackLocalMerge(configsToImport, validation);
        }
    };
    fileInput.click();
}

async function importFallbackLocalMerge(configsToImport, validation) {
    var applied = 0;
    var overwritten = 0;
    var groupIds = Object.keys(configsToImport);

    for (var i = 0; i < groupIds.length; i++) {
        var gid = groupIds[i];
        if (config[gid]) {
            overwritten++;
        }
        config[gid] = configsToImport[gid];
        applied++;
    }

    // 持久化到 IndexedDB（标记为待同步）
    try {
        await IDB.bulkPut(configsToImport, true);
    } catch (idbErr) {
        console.warn('[IDB] Failed to persist imported config:', idbErr);
    }

    // 逐个群 POST 到后端保存（如果后端可达）
    var serverSaved = 0;
    var serverFailed = 0;
    for (var j = 0; j < groupIds.length; j++) {
        var gid2 = groupIds[j];
        var result = await api('/api/config/' + gid2, {
            method: 'POST',
            body: JSON.stringify(configsToImport[gid2])
        });
        if (result.success) {
            serverSaved++;
            groupSavedState[gid2] = true;
            // 同步成功，更新 IDB 标记
            try { await IDB.put(gid2, configsToImport[gid2], false); } catch (e) { /* silent */ }
        } else {
            serverFailed++;
            groupSavedState[gid2] = 'pending';
        }
    }

    // 刷新 UI
    await loadGroups(true);
    if (currentGroupId && configsToImport[currentGroupId]) {
        loadGroupConfig(currentGroupId);
        renderMembers();
    }

    // 高亮变更项
    groupIds.forEach(function (gid) {
        var el = document.querySelector('.group-item[data-id="' + gid + '"]');
        if (el) {
            el.classList.add('highlight-change');
            setTimeout(function () { el.classList.remove('highlight-change'); }, 3000);
        }
    });

    // 构建提示消息
    var msg = '导入完成：' + applied + ' 个群配置';
    if (overwritten > 0) msg += '（覆盖 ' + overwritten + ' 个）';
    if (validation.summary.fixed > 0) msg += '，修正 ' + validation.summary.fixed + ' 个字段';
    if (serverSaved > 0) msg += '\n已保存到服务器 ' + serverSaved + ' 个';
    if (serverFailed > 0) msg += '\n' + serverFailed + ' 个待同步（服务器不可达）';

    showToast(msg, serverFailed > 0 ? 'warning' : 'success');
}

// 简单哈希函数
function simpleHash(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
        var char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
}

function showImportProgress(show, percent) {
    var bar = document.getElementById('importProgressBar');
    var fill = document.getElementById('importProgressFill');
    if (show) {
        bar.style.display = 'block';
        fill.style.width = (percent || 0) + '%';
    } else {
        bar.style.display = 'none';
        fill.style.width = '0%';
    }
}

function openImportPreviewModal(data) {
    var overlay = document.getElementById('importPreviewModal');

    // Stats
    var statsEl = document.getElementById('importStats');
    var s = data.stats;
    statsEl.innerHTML = '<div class="stats-grid">'
        + '<div class="stat-item"><div class="stat-value">' + data.total_groups + '</div><div class="stat-label">\u603b\u7fa4\u6570</div></div>'
        + '<div class="stat-item stat-success"><div class="stat-value">' + s.exact_match + '</div><div class="stat-label">\u7cbe\u786e\u5339\u914d</div></div>'
        + '<div class="stat-item stat-warning"><div class="stat-value">' + s.fuzzy_match + '</div><div class="stat-label">\u6a21\u7cca\u5339\u914d</div></div>'
        + '<div class="stat-item stat-muted"><div class="stat-value">' + s.no_match + '</div><div class="stat-label">\u672a\u5339\u914d</div></div>'
        + '<div class="stat-item stat-danger"><div class="stat-value">' + s.conflict_count + '</div><div class="stat-label">\u51b2\u7a81</div></div>'
        + '</div>';

    // Validation errors
    var errSection = document.getElementById('importValidationErrors');
    var errList = document.getElementById('validationErrorList');
    if (data.validation_errors && data.validation_errors.length > 0) {
        errSection.style.display = 'block';
        errList.innerHTML = data.validation_errors.map(function (e) {
            return '<div class="validation-error-item"><strong>' + escapeHtml(e.key) + '</strong>: ' + escapeHtml(e.error) + '</div>';
        }).join('');
    } else {
        errSection.style.display = 'none';
    }

    // Match results
    var matchList = document.getElementById('matchResultList');
    var matchResults = data.match_results || {};
    var qqGroups = data.qq_groups || [];

    var qqOptions = qqGroups.map(function (g) {
        return '<option value="' + g.group_id + '">' + escapeHtml(g.group_name) + ' (' + g.group_id + ')</option>';
    }).join('');

    var matchItems = Object.entries(matchResults).map(function (entry) {
        var importKey = entry[0];
        var match = entry[1];
        var statusClass, statusText;
        if (match.match_type === 'exact') {
            statusClass = 'match-exact';
            statusText = '\u7cbe\u786e\u5339\u914d';
        } else if (match.match_type === 'fuzzy') {
            statusClass = 'match-fuzzy';
            statusText = '\u6a21\u7cca\u5339\u914d (' + Math.round(match.confidence * 100) + '%)';
        } else {
            statusClass = 'match-none';
            statusText = '\u672a\u5339\u914d';
        }

        var keepSelected = match.match_type === 'none' && /^\d+$/.test(importKey) ? 'selected' : '';

        return '<div class="match-item" data-import-key="' + escapeHtml(importKey) + '">'
            + '<div class="match-source">'
            + '<span class="match-key">' + escapeHtml(importKey) + '</span>'
            + '<span class="match-status ' + statusClass + '">' + statusText + '</span>'
            + '</div>'
            + '<div class="match-target">'
            + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>'
            + '<select class="match-select" data-key="' + escapeHtml(importKey) + '">'
            + '<option value="">\u8df3\u8fc7\uff08\u4e0d\u5bfc\u5165\uff09</option>'
            + '<option value="__keep__" ' + keepSelected + '>\u4fdd\u6301\u539f\u59cb\u7fa4\u53f7: ' + escapeHtml(importKey) + '</option>'
            + qqOptions
            + '</select>'
            + '</div>'
            + '</div>';
    });

    matchList.innerHTML = matchItems.join('');

    // Pre-select matched groups
    document.querySelectorAll('.match-select').forEach(function (select) {
        var key = select.dataset.key;
        var match = matchResults[key];
        if (match && match.matched_group_id) {
            select.value = String(match.matched_group_id);
        }
    });

    // Conflicts
    var conflictSection = document.getElementById('importConflicts');
    var conflictListEl = document.getElementById('conflictList');
    if (data.conflicts && data.conflicts.length > 0) {
        conflictSection.style.display = 'block';
        conflictListEl.innerHTML = data.conflicts.map(function (c) {
            var existUsers = c.existing_config && c.existing_config.target_users ? c.existing_config.target_users.length : 0;
            var importUsers = c.incoming_config && c.incoming_config.target_users ? c.incoming_config.target_users.length : 0;
            return '<div class="conflict-item" data-group-id="' + c.target_group_id + '">'
                + '<div class="conflict-header">'
                + '<span class="conflict-group-name">' + escapeHtml(c.group_name || c.target_group_id) + '</span>'
                + '<span class="conflict-group-id">' + c.target_group_id + '</span>'
                + '</div>'
                + '<div class="conflict-compare">'
                + '<div class="conflict-side conflict-existing">'
                + '<div class="conflict-side-label">\u73b0\u6709\u914d\u7f6e</div>'
                + '<div class="conflict-detail">\u76d1\u63a7 ' + existUsers + ' \u4eba\uff0c\u9608\u503c ' + (c.existing_config ? (c.existing_config.threshold != null ? c.existing_config.threshold : '-') : '-') + '</div>'
                + '</div>'
                + '<div class="conflict-side conflict-incoming">'
                + '<div class="conflict-side-label">\u5bfc\u5165\u914d\u7f6e</div>'
                + '<div class="conflict-detail">\u76d1\u63a7 ' + importUsers + ' \u4eba\uff0c\u9608\u503c ' + (c.incoming_config ? (c.incoming_config.threshold != null ? c.incoming_config.threshold : '-') : '-') + '</div>'
                + '</div>'
                + '</div>'
                + '<div class="conflict-resolution">'
                + '<label><input type="radio" name="conflict_' + c.target_group_id + '" value="use_imported" checked> \u4f7f\u7528\u5bfc\u5165\u914d\u7f6e</label>'
                + '<label><input type="radio" name="conflict_' + c.target_group_id + '" value="keep_existing"> \u4fdd\u7559\u73b0\u6709\u914d\u7f6e</label>'
                + '</div>'
                + '</div>';
        }).join('');
    } else {
        conflictSection.style.display = 'none';
    }

    showImportProgress(false);
    overlay.style.display = 'flex';
}

function closeImportPreviewModal() {
    document.getElementById('importPreviewModal').style.display = 'none';
    importPreviewData = null;
}

async function executeImport() {
    if (!importParsedConfig || !importPreviewData) return;

    var btn = document.getElementById('confirmImportBtn');
    btn.disabled = true;
    btn.textContent = '\u5bfc\u5165\u4e2d...';
    showImportProgress(true, 30);

    var mapping = {};
    document.querySelectorAll('.match-select').forEach(function (select) {
        var importKey = select.dataset.key;
        var targetId = select.value;
        if (targetId === '__keep__') {
            targetId = importKey;
        }
        if (targetId) {
            mapping[importKey] = targetId;
        }
    });

    var conflictResolution = {};
    if (importPreviewData.conflicts) {
        importPreviewData.conflicts.forEach(function (c) {
            var radio = document.querySelector('input[name="conflict_' + c.target_group_id + '"]:checked');
            if (radio) {
                conflictResolution[c.target_group_id] = radio.value;
            }
        });
    }

    var mode = document.getElementById('importModeSelect').value;

    showImportProgress(true, 50);

    var result = await api('/api/config/import?mode=' + mode, {
        method: 'POST',
        body: JSON.stringify({
            configs: importParsedConfig,
            mapping: mapping,
            conflict_resolution: conflictResolution
        })
    });

    showImportProgress(true, 80);

    if (result.success) {
        var stats = result.stats || {};
        var msg = '\u5bfc\u5165\u5b8c\u6210\uff01\u5e94\u7528 ' + (stats.applied || 0) + ' \u4e2a\uff0c\u8df3\u8fc7 ' + (stats.skipped || 0) + ' \u4e2a'
            + (stats.overwritten ? '\uff0c\u8986\u76d6 ' + stats.overwritten + ' \u4e2a' : '')
            + (result.backup_name ? '\n\u5df2\u81ea\u52a8\u5907\u4efd: ' + result.backup_name : '');
        showToast(msg, 'success');

        // 刷新内存配置和 UI
        await loadConfig();
        await loadGroups();

        // 同步到 IndexedDB（标记已同步）
        var appliedConfigs = result.applied_configs || importParsedConfig;
        try {
            await IDB.bulkPut(appliedConfigs, false);
        } catch (idbErr) {
            console.warn('[IDB] Failed to persist imported config:', idbErr);
        }
        for (var gid of Object.keys(appliedConfigs)) {
            groupSavedState[gid] = true;
        }

        if (currentGroupId) {
            loadGroupConfig(currentGroupId);
            renderMembers();
        }

        showImportProgress(true, 100);
        closeImportPreviewModal();
    } else {
        showToast('\u5bfc\u5165\u5931\u8d25: ' + (result.error || '\u672a\u77e5\u9519\u8bef'), 'error');

        // 导入失败：持久化到 IDB 并标记为 pending
        try {
            await IDB.bulkPut(importParsedConfig, true);
        } catch (idbErr) {
            console.warn('[IDB] Failed to persist pending config:', idbErr);
        }
        for (var pgid of Object.keys(importParsedConfig)) {
            config[pgid] = importParsedConfig[pgid];
            groupSavedState[pgid] = 'pending';
        }
    }

    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        + '<polyline points="20 6 9 17 4 12"></polyline></svg> \u786e\u8ba4\u5bfc\u5165';
    showImportProgress(false);
}

// === 搜索功能 ===
document.addEventListener('DOMContentLoaded', function () {
    var searchInput = document.getElementById('memberSearch');
    if (searchInput) {
        searchInput.addEventListener('input', function (e) {
            renderMembers(e.target.value);
        });
    }
});
