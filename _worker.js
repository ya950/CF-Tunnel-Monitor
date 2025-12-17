好的，这是集成了所有优化（包括卡片式UI）的完整、可直接使用的 `worker.js` 代码。

你只需要将以下所有内容复制，替换你 `worker.js` 文件中的全部代码，然后重新部署即可。

---

### 完整 `worker.js` 代码

```javascript
/**
 * Cloudflare Tunnel Monitor v3.3 (Card UI & Optimized)
 * 功能：多账号监控 + 现代化卡片式Web看板 + TG报警 + 支持换行配置 + 性能与UI优化
 */

/**
 * 模块 1: 配置验证
 * 验证并解析环境变量，返回一个结构化的配置对象。
 */
function validateConfig(env) {
  if (!env.ACCOUNTS_LIST) {
    throw new Error("未配置环境变量 ACCOUNTS_LIST");
  }

  // 支持换行符或分号分割，过滤空行
  const rawList = env.ACCOUNTS_LIST.replace(/，/g, ',');
  const lines = rawList.split(/[\n;]/).map(s => s.trim()).filter(s => s !== "");

  if (lines.length === 0) {
    throw new Error("ACCOUNTS_LIST 为空，请至少配置一个账号");
  }

  const accounts = lines.map(line => {
    const parts = line.split(',');
    if (parts.length < 3) {
      throw new Error(`账号配置格式错误: "${line}"。正确格式: "备注,账号ID,API令牌"`);
    }
    return {
      name: parts[0].trim(),
      id: parts[1].trim(),
      token: parts[2].trim(),
    };
  });

  return {
    accounts,
    telegram: {
      enabled: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID),
      botToken: env.TG_BOT_TOKEN,
      chatId: env.TG_CHAT_ID,
    },
    alertOnlyOnError: env.ALERT_ONLY_ON_ERROR !== "false",
  };
}

/**
 * 模块 2: 隧道检查核心逻辑
 * 并行检查所有账号的隧道状态。
 */
async function checkAllTunnels(config) {
  // 使用 Promise.allSettled 并行请求，即使某个失败也不影响其他
  const accountPromises = config.accounts.map(account =>
    fetchTunnelsWithAccount(account)
  );

  const results = await Promise.allSettled(accountPromises);
  
  let accountsData = [];
  let totalTunnels = 0;
  let healthyCount = 0;
  let hasError = false;
  let alertMessages = [];

  results.forEach((result, index) => {
    const accountName = config.accounts[index].name;
    if (result.status === 'fulfilled') {
      const { tunnels, error } = result.value;
      if (error) {
        hasError = true;
        accountsData.push({ name: accountName, tunnels: [], error });
        alertMessages.push(`❌ **${accountName}** API 错误: ${error}`);
      } else {
        totalTunnels += tunnels.length;
        healthyCount += tunnels.filter(t => t.status === 'healthy').length;
        const downTunnels = tunnels.filter(t => t.status !== 'healthy');
        if (downTunnels.length > 0) {
          hasError = true;
          let msg = `🚨 **${accountName}** 隧道异常:\n`;
          downTunnels.forEach(t => msg += `- ${t.name}: ${t.status}\n`);
          alertMessages.push(msg);
        }
        accountsData.push({ name: accountName, tunnels, error: null });
      }
    } else {
      hasError = true;
      const errorMsg = result.reason.message || "未知错误";
      accountsData.push({ name: accountName, tunnels: [], error: errorMsg });
      alertMessages.push(`❌ **${accountName}** 请求失败: ${errorMsg}`);
    }
  });

  return {
    accounts: accountsData,
    stats: { total: totalTunnels, healthy: healthyCount },
    hasError,
    alertMessages,
  };
}

/**
 * 封装单个账号的隧道获取逻辑，便于并行调用
 */
async function fetchTunnelsWithAccount(account) {
  try {
    const tunnels = await fetchTunnels(account.id, account.token);
    return { tunnels, error: null };
  } catch (e) {
    return { tunnels: [], error: e.message };
  }
}

/**
 * 调用 CF API 获取隧道信息，增加了超时控制
 */
async function fetchTunnels(accountId, apiToken) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/tunnels?is_deleted=false`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒超时

  try {
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.errors[0]?.message || "API Error");
    }
    return data.result;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error("请求超时");
    }
    throw error;
  }
}

/**
 * 模块 3: Telegram 通知
 */
async function sendTelegramMessage(config, text) {
  if (!config.telegram.enabled) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text: text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("发送 Telegram 消息失败:", e);
  }
}

/**
 * 模块 4: 现代化卡片式仪表盘生成
 */
function generateModernDashboardHtml(data) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const stats = data.stats || { total: 0, healthy: 0 };
  const isAllHealthy = stats.total > 0 && stats.total === stats.healthy;
  const headerStatusIcon = isAllHealthy ? '🛡️ 系统运行正常' : '⚠️ 存在异常隧道';
  const headerStatusClass = isAllHealthy ? 'header-ok' : 'header-warn';

  let cards = "";
  if (data.error) {
    cards = `<div class="alert-box error">${data.error}</div>`;
  } else {
    data.accounts.forEach(acc => {
      if (acc.error) {
        cards += `
          <div class="tunnel-card card-error" data-account="${acc.name}" data-status="error">
            <div class="card-header">
              <div class="card-title">${acc.name}</div>
            </div>
            <div class="card-body">
              <div class="status-icon">❌</div>
              <div class="status-text">API 请求失败</div>
              <div class="detail-text">${acc.error}</div>
            </div>
          </div>`;
      } else if (acc.tunnels.length === 0) {
        cards += `
          <div class="tunnel-card card-empty" data-account="${acc.name}" data-status="empty">
            <div class="card-header">
              <div class="card-title">${acc.name}</div>
            </div>
            <div class="card-body">
              <div class="status-icon">ℹ️</div>
              <div class="status-text">无活跃隧道</div>
            </div>
          </div>`;
      } else {
        acc.tunnels.forEach(t => {
          const isHealthy = t.status === 'healthy';
          const statusIcon = isHealthy ? '✅' : '🚨';
          const statusText = isHealthy ? 'Healthy' : t.status;
          const cardClass = isHealthy ? 'card-healthy' : 'card-unhealthy';

          cards += `
            <div class="tunnel-card ${cardClass}" data-account="${acc.name}" data-name="${t.name}" data-status="${isHealthy ? 'healthy' : 'unhealthy'}">
              <div class="card-header">
                <div class="card-account">${acc.name}</div>
                <div class="card-title">${t.name}</div>
              </div>
              <div class="card-body">
                <div class="status-icon">${statusIcon}</div>
                <div class="status-text">${statusText}</div>
                <div class="detail-text">ID: <code>${t.id.substring(0, 8)}</code></div>
              </div>
            </div>`;
        });
      }
    });
  }

  // 生成账号筛选选项
  const accountNames = [...new Set(data.accounts.map(acc => acc.name))];
  const accountFilterOptions = ['<option value="">所有账号</option>', ...accountNames.map(name => `<option value="${name}">${name}</option>`)].join('');

  return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CF Tunnel Monitor</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      :root {
        --primary-bg: #f3f4f6;
        --card-bg: #ffffff;
        --text-main: #1f2937;
        --text-muted: #6b7280;
        --border-color: #e5e7eb;
        --success-color: #10b981;
        --success-bg: #d1fae5;
        --danger-color: #ef4444;
        --danger-bg: #fee2e2;
        --gradient-blue: linear-gradient(135deg, #6366f1 0%, #3b82f6 100%);
        --gradient-warn: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
      }
      
      * { box-sizing: border-box; }
      body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        background: var(--primary-bg);
        color: var(--text-main);
        margin: 0;
        padding: 20px;
        min-height: 100vh;
      }

      .dashboard-card {
        background: var(--card-bg);
        width: 100%;
        max-width: 1200px;
        margin: 0 auto;
        border-radius: 16px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        overflow: hidden;
        animation: fadeIn 0.5s ease-out;
      }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

      .card-header { /* Header of the main dashboard card */
        padding: 30px;
        background: var(--gradient-blue);
        color: white;
      }
      .card-header.header-warn { background: var(--gradient-warn); }

      .header-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 20px; }
      .header-title h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
      .header-subtitle { margin-top: 8px; opacity: 0.9; font-size: 0.9rem; display: flex; gap: 15px; }
      .stat-item { font-weight: 500; }
      .refresh-btn {
        background: rgba(255,255,255,0.2);
        border: 1px solid rgba(255,255,255,0.3);
        color: white;
        padding: 8px 16px;
        border-radius: 8px;
        text-decoration: none;
        font-weight: 500;
        font-size: 0.9rem;
        transition: all 0.2s;
        cursor: pointer;
      }
      .refresh-btn:hover { background: rgba(255,255,255,0.3); transform: translateY(-1px); }

      .controls-bar {
        padding: 20px 30px;
        background: #f9fafb;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        gap: 15px;
        flex-wrap: wrap;
        align-items: center;
      }
      .control-group { display: flex; align-items: center; gap: 8px; }
      .control-group label { font-size: 0.9rem; color: var(--text-muted); }
      .control-input, .control-select {
        padding: 8px 12px;
        border: 1px solid var(--border-color);
        border-radius: 6px;
        font-size: 0.9rem;
        background: white;
      }
      .control-input { width: 200px; }
      .sort-btn { padding: 8px 12px; border: 1px solid var(--border-color); background: white; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
      .sort-btn:hover, .sort-btn.active { background: var(--gradient-blue); color: white; border-color: transparent; }
      .auto-refresh-toggle { display: flex; align-items: center; gap: 8px; margin-left: auto; }
      .switch { position: relative; display: inline-block; width: 48px; height: 24px; }
      .switch input { opacity: 0; width: 0; height: 0; }
      .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 24px; }
      .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .4s; border-radius: 50%; }
      input:checked + .slider { background-color: var(--success-color); }
      input:checked + .slider:before { transform: translateX(24px); }

      /* --- New Card Grid Styles --- */
      .tunnel-grid-container {
        padding: 30px;
      }
      .tunnel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 20px;
      }
      .tunnel-card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 12px;
        padding: 20px;
        transition: all 0.3s ease;
        display: flex;
        flex-direction: column;
        cursor: pointer;
        overflow: hidden;
      }
      .tunnel-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 10px 20px rgba(0,0,0,0.08);
      }
      .tunnel-card.card-healthy { border-left: 5px solid var(--success-color); }
      .tunnel-card.card-unhealthy { border-left: 5px solid var(--danger-color); background: var(--danger-bg); }
      .tunnel-card.card-error { border-left: 5px solid #fbbf24; background: #fef3c7; }
      .tunnel-card.card-empty { border-left: 5px solid var(--text-muted); background: #f3f4f6; }

      .tunnel-card .card-header { /* Header inside each tunnel card */
        padding: 0;
        background: none;
        color: var(--text-main);
        margin-bottom: 15px;
      }
      .tunnel-card .card-account {
        font-size: 0.8rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
      }
      .tunnel-card .card-title {
        font-size: 1.1rem;
        font-weight: 600;
        margin-top: 4px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tunnel-card .card-body {
        text-align: center;
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
      }
      .tunnel-card .status-icon {
        font-size: 2.5rem;
        margin-bottom: 10px;
      }
      .tunnel-card .status-text {
        font-size: 1rem;
        font-weight: 600;
        margin-bottom: 8px;
      }
      .tunnel-card .detail-text {
        font-size: 0.85rem;
        color: var(--text-muted);
      }
      .tunnel-card .detail-text code {
        background: #e5e7eb;
        padding: 2px 6px;
        border-radius: 4px;
        font-family: 'ui-monospace', monospace;
      }
      .tunnel-card.hidden { display: none; }

      .alert-box { padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; font-weight: 500; }
      .alert-box.error { background: var(--danger-bg); color: var(--danger-color); border: 1px solid var(--danger-color); }
      
      .card-footer { /* Footer of the main dashboard card */
        padding: 15px 30px;
        background: #f9fafb;
        color: var(--text-muted);
        font-size: 0.85rem;
        text-align: right;
        border-top: 1px solid var(--border-color);
      }

      @media (max-width: 768px) {
        body { padding: 10px; }
        .header-top { flex-direction: column; align-items: flex-start; }
        .controls-bar { flex-direction: column; align-items: stretch; }
        .control-group { width: 100%; justify-content: space-between; }
        .control-input { width: 100%; }
        .auto-refresh-toggle { margin-left: 0; margin-top: 10px; }
        .tunnel-grid-container { padding: 15px; }
        .tunnel-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="dashboard-card">
      <div class="card-header ${headerStatusClass}">
        <div class="header-top">
          <div>
            <h1>☁️ CF Tunnel Monitor</h1>
            <div class="header-subtitle">
              <span>${headerStatusIcon}</span>
              <span class="stat-item">共监控: ${stats.total} 条</span>
              <span class="stat-item">正常: ${stats.healthy} 条</span>
            </div>
          </div>
          <a href="." class="refresh-btn" id="manual-refresh-btn">🔄 立即刷新</a>
        </div>
      </div>

      <div class="controls-bar">
        <div class="control-group">
          <label for="account-filter">账号:</label>
          <select id="account-filter" class="control-select">${accountFilterOptions}</select>
        </div>
        <div class="control-group">
          <label for="status-filter">状态:</label>
          <select id="status-filter" class="control-select">
            <option value="">所有状态</option>
            <option value="healthy">正常</option>
            <option value="unhealthy">异常</option>
            <option value="error">错误</option>
            <option value="empty">空</option>
          </select>
        </div>
        <div class="control-group">
          <label for="tunnel-search">搜索:</label>
          <input type="text" id="tunnel-search" class="control-input" placeholder="隧道名称...">
        </div>
        <div class="control-group">
          <button class="sort-btn" data-sort="account">按账号排序</button>
          <button class="sort-btn" data-sort="name">按名称排序</button>
        </div>
        <div class="auto-refresh-toggle">
          <label for="auto-refresh-switch">自动刷新</label>
          <label class="switch">
            <input type="checkbox" id="auto-refresh-switch">
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="tunnel-grid-container">
        <div class="tunnel-grid">
          ${cards}
        </div>
      </div>

      <div class="card-footer">
        最后更新时间: ${now}
      </div>
    </div>

    <script>
      document.addEventListener('DOMContentLoaded', function() {
        const grid = document.querySelector('.tunnel-grid');
        const cards = Array.from(grid.querySelectorAll('.tunnel-card'));
        const accountFilter = document.getElementById('account-filter');
        const statusFilter = document.getElementById('status-filter');
        const searchInput = document.getElementById('tunnel-search');
        const sortButtons = document.querySelectorAll('.sort-btn');
        const autoRefreshSwitch = document.getElementById('auto-refresh-switch');
        const manualRefreshBtn = document.getElementById('manual-refresh-btn');
        let refreshInterval;

        function applyFilters() {
          const accountValue = accountFilter.value.toLowerCase();
          const statusValue = statusFilter.value.toLowerCase();
          const searchValue = searchInput.value.toLowerCase();

          cards.forEach(card => {
            const account = (card.dataset.account || '').toLowerCase();
            const status = (card.dataset.status || '').toLowerCase();
            const name = (card.dataset.name || '').toLowerCase();

            const matchAccount = !accountValue || account.includes(accountValue);
            const matchStatus = !statusValue || status.includes(statusValue);
            const matchSearch = !searchValue || name.includes(searchValue);

            if (matchAccount && matchStatus && matchSearch) {
              card.classList.remove('hidden');
            } else {
              card.classList.add('hidden');
            }
          });
        }

        function sortGrid(sortBy) {
          sortButtons.forEach(btn => btn.classList.remove('active'));
          event.target.classList.add('active');

          const visibleCards = cards.filter(card => !card.classList.contains('hidden'));
          visibleCards.sort((a, b) => {
            let aVal, bVal;
            switch(sortBy) {
              case 'account': aVal = a.dataset.account; bVal = b.dataset.account; break;
              case 'name': aVal = a.dataset.name; bVal = b.dataset.name; break;
              default: return 0;
            }
            return aVal.localeCompare(bVal);
          });
          grid.append(...visibleCards);
        }

        accountFilter.addEventListener('change', applyFilters);
        statusFilter.addEventListener('change', applyFilters);
        searchInput.addEventListener('input', applyFilters);
        sortButtons.forEach(btn => btn.addEventListener('click', (e) => sortGrid(e.target.dataset.sort)));

        autoRefreshSwitch.addEventListener('change', function() {
          if (this.checked) {
            refreshInterval = setInterval(() => {
              window.location.reload();
            }, 60000); // 60秒
          } else {
            clearInterval(refreshInterval);
          }
        });

        manualRefreshBtn.addEventListener('click', () => window.location.reload());
      });
    </script>
  </body>
  </html>
  `;
}


/**
 * Worker 入口点
 */
export default {
  // 1. 定时任务 -> 只负责报警
  async scheduled(event, env, ctx) {
    try {
      const config = validateConfig(env);
      ctx.waitUntil(handleScheduled(config));
    } catch (e) {
      console.error("配置验证失败，无法执行定时任务:", e.message);
    }
  },

  // 2. 浏览器访问 -> 生成现代化 HTML 面板
  async fetch(request, env, ctx) {
    try {
      const config = validateConfig(env);
      const checkResult = await checkAllTunnels(config);
      const html = generateModernDashboardHtml(checkResult);
      return new Response(html, {
        headers: { "content-type": "text/html;charset=UTF-8" },
      });
    } catch (e) {
      console.error("处理请求失败:", e);
      const errorHtml = `
        <!DOCTYPE html><html><head><title>错误</title><meta charset="utf-8"></head>
        <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; text-align: center;">
          <div><h1>服务配置错误</h1><p>${e.message}</p></div>
        </body></html>`;
      return new Response(errorHtml, {
        status: 500,
        headers: { "content-type": "text/html;charset=UTF-8" },
      });
    }
  },
};

/**
 * 核心逻辑：处理定时任务报警
 */
async function handleScheduled(config) {
  const result = await checkAllTunnels(config);
  if (config.alertOnlyOnError && !result.hasError) {
    return;
  }
  if (result.alertMessages.length > 0) {
    await sendTelegramMessage(config, result.alertMessages.join("\n"));
  }
}
```
