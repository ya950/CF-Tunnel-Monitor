/**
 * Cloudflare Tunnel Monitor v10.3 (改进版)
 * 新增：界面支持"永不用通知"功能
 */

// ================= 1. 配置验证模块 =================

function validateConfig(env) {
  if (!env.ACCOUNTS_LIST) throw new Error("未配置 ACCOUNTS_LIST");
  let rawList = env.ACCOUNTS_LIST.replace(/：/g, ':').replace(/，/g, ',').replace(/；/g, ';');
  const lines = rawList.split('\n').map(s => s.trim()).filter(s => s !== "");
  
  let tunnels = [];
  let patMap = new Map(); 

  for (const line of lines) {
    const parts = line.split(';');
    const cfPart = parts[0].trim();
    const ghPart = parts.length > 1 ? parts[1].trim() : null;
    const firstColon = cfPart.indexOf(':');
    if (firstColon === -1) continue;
    
    const accountAlias = cfPart.substring(0, firstColon).trim();
    const cfDetails = cfPart.substring(firstColon + 1).split(',').map(s => s.trim());
    if (cfDetails.length < 2) continue; 

    const accountId = cfDetails[0];
    const apiToken = cfDetails[1];
    const tunnelNames = cfDetails.slice(2).filter(t => t !== "");

    let ghInfo = { owner: null, repo: null, pat: null, branch: "main" }; // 默认分支为 main
    if (ghPart) {
      const ghClean = ghPart.replace(/^GitHub:/i, '').trim();
      const ghDetails = ghClean.split(',').map(s => s.trim());
      if (ghDetails.length >= 3) {
        ghInfo.owner = ghDetails[0]; 
        ghInfo.repo = ghDetails[1]; 
        ghInfo.pat = ghDetails[2];
        // 支持自定义分支
        if (ghDetails.length >= 4) {
          ghInfo.branch = ghDetails[3];
        }
      }
    }

    if (tunnelNames.length > 0) {
      for (const tName of tunnelNames) {
        tunnels.push({ 
          name: tName, 
          accountId, 
          apiToken, 
          accountName: accountAlias, 
          githubOwner: ghInfo.owner, 
          githubRepo: ghInfo.repo,
          githubBranch: ghInfo.branch
        });
        if (ghInfo.pat) {
          patMap.set(tName, { 
            pat: ghInfo.pat, 
            owner: ghInfo.owner, 
            repo: ghInfo.repo, 
            alias: accountAlias,
            branch: ghInfo.branch
          });
        }
      }
    }
  }
  return { 
    tunnels, 
    patMap, 
    telegram: { 
      enabled: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID), 
      botToken: env.TG_BOT_TOKEN, 
      chatId: env.TG_CHAT_ID,
      webhookSecret: env.TG_WEBHOOK_SECRET || null // 新增 webhook 密钥验证
    },
    alertOnlyOnError: env.ALERT_ONLY_ON_ERROR !== "false",
    maxConcurrentRequests: parseInt(env.MAX_CONCURRENT_REQUESTS || "5") // 新增并发控制
  };
}

// ================= 2. 核心检查逻辑 =================

async function checkAllTunnels(config) {
  const accountsMap = new Map();
  config.tunnels.forEach(t => {
    if (!accountsMap.has(t.accountId)) {
      accountsMap.set(t.accountId, { accountId: t.accountId, apiToken: t.apiToken, accountName: t.accountName, configTunnels: [] });
    }
    accountsMap.get(t.accountId).configTunnels.push(t);
  });

  // 使用并发控制
  const maxConcurrent = config.maxConcurrentRequests;
  const accounts = Array.from(accountsMap.values());
  const results = [];
  
  // 分批处理请求
  for (let i = 0; i < accounts.length; i += maxConcurrent) {
    const batch = accounts.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(acc => fetchAccountData(acc));
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
  }
  
  let finalData = [], stats = { total: 0, healthy: 0 };

  for (const res of results) {
    if (res.status === 'fulfilled') {
      const { accountName, apiData, error, configTunnels } = res.value;
      if (!error) {
        const configMap = new Map(configTunnels.map(t => [t.name, t]));
        apiData.forEach(realT => {
          stats.total++;
          const conf = configMap.get(realT.name);
          if (realT.status === 'healthy') stats.healthy++;
          finalData.push({ 
            name: realT.name, 
            id: realT.id, 
            status: realT.status, 
            accountName, 
            githubOwner: conf ? conf.githubOwner : null, 
            githubRepo: conf ? conf.githubRepo : null,
            githubBranch: conf ? conf.githubBranch : "main"
          });
        });
      }
    }
  }
  return { tunnels: finalData, stats };
}

async function fetchAccountData(ctx) {
  try {
    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
    
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ctx.accountId}/tunnels?is_deleted=false`, {
      headers: { "Authorization": `Bearer ${ctx.apiToken}`, "Content-Type": "application/json" },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!resp.ok) {
      throw new Error(`API Error: ${resp.status} ${resp.statusText}`);
    }
    
    const json = await resp.json();
    return { ...ctx, apiData: json.result || [], error: json.success ? null : "API Error" };
  } catch (e) { 
    let errorMsg = e.message;
    if (e.name === 'AbortError') {
      errorMsg = "请求超时";
    }
    return { ...ctx, apiData: [], error: errorMsg }; 
  }
}

// ================= 3. GitHub 触发模块 =================

async function triggerGitHub(patMap, tunnelName, status) {
  const info = patMap.get(tunnelName);
  if (!info) return { success: false, msg: "未配置 GitHub 触发规则" };
  
  // status 为 'MANUAL_TEST' 时强制执行
  if (status === 'healthy' && status !== 'MANUAL_TEST') return { success: false, msg: "状态正常" };

  const { owner, repo, pat, branch } = info;
  // 注意：使用用户自定义的工作流文件名 mian.yml（不是拼写错误）
  const workflowFile = 'mian.yml'; 
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  try {
    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
    
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'CF-Monitor'
      },
      body: JSON.stringify({ ref: branch }), // 使用配置的分支
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (resp.status === 204) {
      return { success: true, msg: "触发成功" };
    } else {
      const errText = await resp.text();
      return { success: false, msg: `GitHub 错误 ${resp.status}: ${errText}` };
    }
  } catch (e) {
    let errorMsg = e.message;
    if (e.name === 'AbortError') {
      errorMsg = "请求超时";
    }
    return { success: false, msg: `网络错误: ${errorMsg}` };
  }
}

// ================= 4. Telegram 交互模块 (改进版) =================

async function sendTelegramAlert(env, chatId, text, tunnelName, hasAction) {
  // 构建按钮
  const inlineKeyboard = [];
  const row = [];
  
  if (hasAction) {
    row.push({ text: "🛠 强制修复", callback_data: `fix:${tunnelName}` });
  }
  row.push({ text: "🔕 静音通知", callback_data: `mute:${tunnelName}` });
  inlineKeyboard.push(row);

  try {
    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
    
    const resp = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: text, 
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: inlineKeyboard }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Telegram 发送消息失败: ${resp.status} ${errText}`);
    }
  } catch (e) {
    console.error(`Telegram 发送消息异常: ${e.message}`);
  }
}

async function handleTelegramWebhook(request, env) {
  try {
    // 验证 webhook secret（如果配置了）
    if (env.TG_WEBHOOK_SECRET) {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.TG_WEBHOOK_SECRET) {
        return new Response('Unauthorized', {status: 403});
      }
    }
    
    const update = await request.json();
    // 验证是否是回调查询 (按钮点击)
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data; // e.g., "fix:foxgla-eu"
      const chatId = cq.message.chat.id;
      
      // 安全检查：只有配置的 ChatID 可以操作
      if (String(chatId) !== String(env.TG_CHAT_ID)) return new Response('Unauthorized', {status: 403});

      const [action, tName] = data.split(':');
      let replyText = "";

      if (action === 'fix') {
        // 强制修复逻辑
        const config = validateConfig(env);
        const res = await triggerGitHub(config.patMap, tName, 'MANUAL_TEST');
        replyText = res.success ? `✅ 已发送 GitHub 修复请求: ${tName}` : `❌ 修复请求失败: ${res.msg}`;
      } 
      else if (action === 'mute') {
        // 静音逻辑 - 添加过期时间（24小时）
        const muteExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        let mutedList = JSON.parse(await env.TUNNEL_KV.get("muted_tunnels") || "[]");
        
        // 检查是否已经在静音列表中
        const existingIndex = mutedList.findIndex(item => item.name === tName);
        if (existingIndex === -1) {
            mutedList.push({ name: tName, expiry: muteExpiry });
            await env.TUNNEL_KV.put("muted_tunnels", JSON.stringify(mutedList));
            replyText = `🔕 已静音: ${tName} (24小时内不再接收报警)`;
        } else {
            replyText = `⚠️ 该隧道已在静音列表中`;
        }
      }

      // 回应 Telegram (消除按钮加载状态) 并发送提示
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ callback_query_id: cq.id, text: "操作已接收" })
      });
      
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ chat_id: chatId, text: replyText })
      });
    }
    return new Response('OK');
  } catch(e) {
    console.error(`处理 Telegram Webhook 异常: ${e.message}`);
    return new Response('Error', {status: 500});
  }
}

// ================= 5. HTML 看板 (UI 改进版) =================

function generateHtml(data, mutedList, permanentMutedList) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const { total, healthy } = data.stats;
  const allAccounts = [...new Set(data.tunnels.map(t => t.accountName))];
  const accOptions = allAccounts.map(a => `<option value="${a}">${a}</option>`).join('');

  // 提取隧道名称用于检查是否静音
  const mutedNames = mutedList.map(item => typeof item === 'string' ? item : item.name);
  const permanentMutedNames = permanentMutedList || [];

  // 优化排序逻辑：异常隧道优先排在最前面
  data.tunnels.sort((a, b) => {
    // 首先按状态排序：非健康的排在前面
    if (a.status !== 'healthy' && b.status === 'healthy') return -1;
    if (a.status === 'healthy' && b.status !== 'healthy') return 1;
    
    // 如果状态相同，按名称排序
    if (a.status === b.status) {
      return a.name.localeCompare(b.name);
    }
    
    return 0;
  });

  let cards = "";
  data.tunnels.forEach(t => {
    const isHealthy = t.status === 'healthy';
    const isMuted = mutedNames.includes(t.name);
    const isPermanentMuted = permanentMutedNames.includes(t.name);
    const shortId = t.id && t.id !== 'N/A' ? t.id.slice(0, 8) : 'N/A';
    const hasGh = !!t.githubOwner;

    const ghBadge = hasGh 
      ? `<a href="https://github.com/${t.githubOwner}/${t.githubRepo}" target="_blank" class="repo-badge">
           <svg width="15" height="15" fill="currentColor" viewBox="0 0 16 16" style="margin-right:6px;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
           ${t.githubOwner}/${t.githubRepo}:${t.githubBranch}
         </a>`
      : `<span class="no-repo">🚫 仅监控 (无触发)</span>`;

    // 通知状态显示逻辑
    let notificationStatus = '';
    if (isPermanentMuted) {
      notificationStatus = '<span class="notification-status permanent-muted">🚫 永不通知</span>';
    } else if (isMuted) {
      notificationStatus = '<span class="notification-status temp-muted">🔕 临时静音</span>';
    } else {
      notificationStatus = '<span class="notification-status active">🔔 接收通知</span>';
    }

    cards += `
    <div class="card ${isHealthy ? '' : 'card-warn'}" data-acc="${t.accountName}" data-name="${t.name}">
      <div class="status-dot-container">
        <div class="dot ${isHealthy ? 'dot-healthy' : 'dot-unhealthy'}" title="${t.status}"></div>
      </div>
      <div class="card-head"><span>${t.accountName}</span><span>${shortId}</span></div>
      <div class="card-body">
        <div class="name-row">
          <span class="stat-txt">${t.name}</span>
        </div>
        <div class="notification-row">
          ${notificationStatus}
          <div class="notification-buttons">
            <button class="btn-temp-mute ${isMuted && !isPermanentMuted ? 'active' : ''}" onclick="toggleTempMute('${t.name}', this)" title="临时静音24小时">🔕</button>
            <button class="btn-permanent-mute ${isPermanentMuted ? 'active' : ''}" onclick="togglePermanentMute('${t.name}', this)" title="永不通知">🚫</button>
          </div>
        </div>
        <div style="margin: 12px 0;">${ghBadge}</div>
        <div class="actions">
          ${hasGh ? `<button class="btn-test" onclick="triggerAction('${t.name}', this)">🧪 触发修复</button>` : `<button class="btn-test" disabled style="opacity:0.3">🚫 无修复配置</button>`}
        </div>
      </div>
    </div>`;
  });

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Monitor v10.3</title>
  <style>
    :root { 
      --bg:#f3f4f6; --card:#fff; --text:#1f2937; --mute:#6b7280; 
      --ok:#10b981; --err:#ef4444; --warn:#f59e0b; 
      --yellow-bold: #d97706; 
      --btn:#3b82f6; --link-bg:#eff6ff; --link-fg:#2563eb; 
    }
    body { font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); margin:0; padding:15px; }
    .container { max-width:1200px; margin:0 auto; background:var(--card); border-radius:16px; box-shadow:0 4px 10px rgba(0,0,0,0.05); overflow:hidden; }
    .header { padding:20px 25px; color:#fff; background: linear-gradient(135deg, #6366f1, #3b82f6); }
    .header.header-warn { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:15px; padding:20px; } /* 调整为和之前一样的大小 */
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:15px; transition: 0.2s; position: relative; }
    .card-warn { border-color: #fecaca; background: #fffafb; }
    
    .status-dot-container { display:flex; justify-content:center; margin-bottom:8px; }
    .dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.15); }
    .dot-healthy { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot-unhealthy { background: var(--err); box-shadow: 0 0 10px var(--err); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(1.1); } }
    
    .card-head { display:flex; justify-content:space-between; font-size:0.75rem; color:var(--mute); margin-bottom:12px; font-weight:600; text-transform:uppercase; border-bottom: 1px dashed #e5e7eb; padding-bottom: 8px; }
    .name-row { display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:10px; }
    .stat-txt { font-weight: 800; font-size: 1.3rem; color: var(--yellow-bold); word-break: break-all; text-shadow: 0 1px 0 rgba(0,0,0,0.05); }
    
    .notification-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; padding:6px 8px; background:#f9fafb; border-radius:8px; }
    .notification-status { font-size:0.75rem; font-weight:600; } /* 减小字体 */
    .notification-status.active { color: var(--ok); }
    .notification-status.temp-muted { color: var(--warn); }
    .notification-status.permanent-muted { color: var(--err); }
    .notification-buttons { display:flex; gap:4px; } /* 减小间距 */
    .btn-temp-mute, .btn-permanent-mute { background:none; border:none; cursor:pointer; font-size:1rem; opacity:0.4; filter:grayscale(1); transition:0.2s; padding:3px; border-radius:4px; } /* 减小字体和内边距 */
    .btn-temp-mute:hover, .btn-permanent-mute:hover { background:#e5e7eb; }
    .btn-temp-mute.active, .btn-permanent-mute.active { opacity:1; filter:grayscale(0); }
    .btn-temp-mute.active { color: var(--warn); }
    .btn-permanent-mute.active { color: var(--err); }
    
    .repo-badge { display:inline-flex; align-items:center; background:var(--link-bg); color:var(--link-fg); padding:4px 8px; border-radius:6px; font-size:0.75rem; text-decoration:none; font-weight:700; border:1px solid #dbeafe; transition:0.2s; } /* 减小内边距和字体 */
    .repo-badge:hover { background: #dbeafe; transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    
    .btn-test { width:100%; background:var(--btn); color:#fff; border:none; padding:6px; border-radius:6px; cursor:pointer; font-size:0.75rem; font-weight:600; margin-top:5px; } /* 减小内边距和字体 */
    .footer { padding:12px 25px; font-size:0.75rem; color:var(--mute); text-align:right; border-top:1px solid #e5e7eb; background:#f9fafb; }
    .controls { padding:12px 25px; background:#f9fafb; border-bottom:1px solid #e5e7eb; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    select, input { padding:6px 12px; border:1px solid #ddd; border-radius:8px; font-size:0.85rem; }
    
    /* 响应式设计 */
    @media (max-width: 768px) {
      .grid { grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); } /* 移动端更小 */
      .controls { flex-direction: column; align-items: stretch; }
      .controls > * { margin-bottom: 8px; }
      .notification-row { flex-direction: column; gap:6px; }
    }
  </style></head>
  <body><div class="container">
    <div class="header ${healthy === total ? '' : 'header-warn'}">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div><h2 style="margin:0;font-size:1.4rem;">☁️ Tunnel Monitor</h2><small>运行状态: ${healthy}/${total} 正常</small></div>
        <button onclick="location.reload()" style="background:rgba(255,255,255,0.2);border:none;color:#fff;padding:8px 15px;border-radius:6px;cursor:pointer;font-weight:600;">🔄 刷新数据</button>
      </div>
    </div>
    
    <div class="controls">
      <select id="accFilter"><option value="">所有账号</option>${accOptions}</select>
      <input type="text" id="search" placeholder="过滤隧道名称...">
      <label style="font-size:0.85rem; margin-left:auto; cursor:pointer;"><input type="checkbox" id="autoRef"> 自动刷新 (60s)</label>
    </div>

    <div class="grid">${cards}</div>
    <div class="footer">Update: ${now} | 已连接 Cloudflare KV 云端存储</div>
  </div>

  <script>
    const accFilter = document.getElementById('accFilter');
    const search = document.getElementById('search');

    function doFilter() {
      const acc = accFilter.value;
      const key = search.value.toLowerCase();
      document.querySelectorAll('.card').forEach(c => {
        const cAcc = c.dataset.acc;
        const cName = c.dataset.name.toLowerCase();
        let show = true;
        if(acc && cAcc !== acc) show = false;
        if(key && !cName.includes(key)) show = false;
        c.style.display = show ? 'block' : 'none';
      });
    }

    accFilter.onchange = doFilter;
    search.oninput = doFilter;

    async function toggleTempMute(name, btn) {
      // 检查当前状态，避免重复操作
      if (btn.classList.contains('active')) {
        // 如果已经是激活状态，说明用户想取消静音
        var isMuting = false;
      } else {
        // 检查是否已经被永久静音，如果是则不允许临时静音
        const permanentBtn = btn.closest('.notification-row').querySelector('.btn-permanent-mute');
        if (permanentBtn.classList.contains('active')) {
          alert('此隧道已永久静音，请先取消永久静音');
          return;
        }
        var isMuting = true;
      }
      
      btn.style.opacity = '0.2';
      try {
        const res = await fetch(\`/toggle-mute?name=\${encodeURIComponent(name)}&action=\${isMuting ? 'mute' : 'unmute'}\`);
        if(res.ok) {
            btn.classList.toggle('active');
            // 更新状态显示
            const statusEl = btn.closest('.notification-row').querySelector('.notification-status');
            
            if (isMuting) {
                statusEl.className = 'notification-status temp-muted';
                statusEl.innerText = '🔕 临时静音';
            } else {
                statusEl.className = 'notification-status active';
                statusEl.innerText = '🔔 接收通知';
            }
        } else {
          alert('操作失败，请重试');
        }
      } catch(e) { 
        alert('网络异常，操作失败'); 
      }
      finally { 
        btn.style.opacity = isMuting ? '1' : '0.4'; 
      }
    }

    async function togglePermanentMute(name, btn) {
      // 检查当前状态，避免重复操作
      const isMuting = !btn.classList.contains('active');
      
      if (isMuting && !confirm('确定要永久禁用此隧道通知吗？需要手动取消才能恢复通知。')) {
        return;
      }
      
      btn.style.opacity = '0.2';
      try {
        const res = await fetch(\`/toggle-permanent-mute?name=\${encodeURIComponent(name)}&action=\${isMuting ? 'mute' : 'unmute'}\`);
        if(res.ok) {
            btn.classList.toggle('active');
            // 更新状态显示
            const statusEl = btn.closest('.notification-row').querySelector('.notification-status');
            const tempBtn = btn.closest('.notification-row').querySelector('.btn-temp-mute');
            
            if (isMuting) {
                statusEl.className = 'notification-status permanent-muted';
                statusEl.innerText = '🚫 永不通知';
                tempBtn.classList.remove('active');
                tempBtn.style.opacity = '0.4';
            } else {
                statusEl.className = 'notification-status active';
                statusEl.innerText = '🔔 接收通知';
            }
        } else {
          alert('操作失败，请重试');
        }
      } catch(e) { 
        alert('网络异常，操作失败'); 
      }
      finally { 
        btn.style.opacity = isMuting ? '1' : '0.4'; 
      }
    }

    async function triggerAction(name, btn) {
      if(!confirm('确定触发 GitHub Action 修复？')) return;
      const originalText = btn.innerText;
      btn.innerText = '发送请求...';
      btn.disabled = true;
      try {
        const res = await fetch(\`/trigger-test?name=\${encodeURIComponent(name)}\`);
        const json = await res.json();
        if(res.ok && json.success) {
          alert('✅ 成功！GitHub Action 已触发。');
        } else {
          alert('❌ 失败: ' + json.msg);
        }
      } catch(e) { alert('❌ 网络异常'); }
      finally { btn.innerText = originalText; btn.disabled = false; }
    }

    if(localStorage.getItem('autoRef') === 'true') {
        document.getElementById('autoRef').checked = true;
        setInterval(() => location.reload(), 60000);
    }
    document.getElementById('autoRef').onchange = (e) => {
        localStorage.setItem('autoRef', e.target.checked);
        location.reload();
    };
  </script></body></html>`;
}

// ================= 6. Worker 入口逻辑 (改进版) =================

export default {
  async scheduled(event, env, ctx) {
    try {
      const config = validateConfig(env);
      const data = await checkAllTunnels(config);
      
      // 处理静音列表，清理过期的静音项
      let mutedList = JSON.parse(await env.TUNNEL_KV.get("muted_tunnels") || "[]");
      const now = new Date();
      
      // 过滤掉过期的静音项
      mutedList = mutedList.filter(item => {
        if (typeof item === 'string') {
          // 兼容旧版本，字符串格式默认24小时过期
          return true; // 保留旧格式，下次更新时会转换为新格式
        }
        return new Date(item.expiry) > now;
      });
      
      // 更新静音列表
      await env.TUNNEL_KV.put("muted_tunnels", JSON.stringify(mutedList));
      
      // 获取永久静音列表
      const permanentMutedList = JSON.parse(await env.TUNNEL_KV.get("permanent_muted_tunnels") || "[]");
      
      const todayDate = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
      const mutedNames = mutedList.map(item => typeof item === 'string' ? item : item.name);

      for (const t of data.tunnels) {
        if (t.status !== 'healthy') {
          // 如果已永久静音或临时静音，直接跳过所有操作
          if (permanentMutedList.includes(t.name) || mutedNames.includes(t.name)) continue;

          // 检查今日触发次数（对所有隧道，无论是否有GitHub配置）
          const limitKey = `trigger_stats:${t.name}`;
          let stats = await env.TUNNEL_KV.get(limitKey, {type: 'json'});
          
          if (!stats || stats.date !== todayDate) {
            stats = { count: 0, date: todayDate };
          }

          // 如果今日已达到3次上限，跳过此隧道
          if (stats.count >= 3) {
            console.log(`[Scheduled] 隧道 ${t.name} 异常，但今日已达到3次通知上限，跳过`);
            continue;
          }

          // 增加触发计数
          stats.count++;
          await env.TUNNEL_KV.put(limitKey, JSON.stringify(stats));

          let triggerMsg = "";
          let hasAction = false;
          
          if (config.patMap.has(t.name)) {
            // 有GitHub配置的隧道，尝试触发修复
            hasAction = true;
            console.log(`[Scheduled] 隧道 ${t.name} 异常，触发修复 (${stats.count}/3)...`);
            const result = await triggerGitHub(config.patMap, t.name, t.status);
            if (result.success) {
              triggerMsg = ` (触发修复 ${stats.count}/3)`;
            } else {
              triggerMsg = ` (触发失败: ${result.msg})`;
            }
          } else {
            // 没有GitHub配置的隧道，仅记录通知次数
            console.log(`[Scheduled] 隧道 ${t.name} 异常，发送通知 (${stats.count}/3)`);
            triggerMsg = ` (仅监控 ${stats.count}/3)`;
          }

          // 发送带按钮的报警
          if (env.TG_BOT_TOKEN) {
             const alertText = `🚨 **${t.name}** (${t.accountName}): ${t.status}\n${triggerMsg}`;
             await sendTelegramAlert(env, env.TG_CHAT_ID, alertText, t.name, hasAction);
          }
        }
      }
    } catch (e) { 
      console.error("Scheduled Error:", e.message);
      // 可以在这里添加错误通知逻辑，比如发送到 Telegram
    }
  },

  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // 1. 处理 Telegram Webhook (按钮点击)
      if (url.pathname === '/telegram-webhook') {
        return handleTelegramWebhook(request, env);
      }

      // 2. KV 交互 (网页端) - 临时静音
      if (url.pathname === '/toggle-mute') {
        const name = url.searchParams.get('name');
        const action = url.searchParams.get('action');
        let mutedList = JSON.parse(await env.TUNNEL_KV.get("muted_tunnels") || "[]");
        
        // 转换旧格式为新格式
        if (mutedList.length > 0 && typeof mutedList[0] === 'string') {
          mutedList = mutedList.map(item => ({ name: item, expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }));
        }
        
        if (action === 'mute') {
          // 检查是否已经在静音列表中
          const existingIndex = mutedList.findIndex(item => item.name === name);
          if (existingIndex === -1) {
            const muteExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            mutedList.push({ name: name, expiry: muteExpiry });
          }
        } else if (action === 'unmute') {
          mutedList = mutedList.filter(item => item.name !== name);
        }
        
        await env.TUNNEL_KV.put("muted_tunnels", JSON.stringify(mutedList));
        return new Response("OK");
      }

      // 3. KV 交互 (网页端) - 永久静音
      if (url.pathname === '/toggle-permanent-mute') {
        const name = url.searchParams.get('name');
        const action = url.searchParams.get('action');
        let permanentMutedList = JSON.parse(await env.TUNNEL_KV.get("permanent_muted_tunnels") || "[]");
        
        if (action === 'mute') {
          if (!permanentMutedList.includes(name)) {
            permanentMutedList.push(name);
          }
        } else if (action === 'unmute') {
          permanentMutedList = permanentMutedList.filter(item => item !== name);
        }
        
        await env.TUNNEL_KV.put("permanent_muted_tunnels", JSON.stringify(permanentMutedList));
        return new Response("OK");
      }

      // 4. 手动触发 (网页端 - 不受限制)
      if (url.pathname === '/trigger-test') {
        const config = validateConfig(env);
        const tName = url.searchParams.get('name');
        if (!tName) return new Response(JSON.stringify({success:false, msg:'Missing name'}), {status:400});
        const result = await triggerGitHub(config.patMap, tName, 'MANUAL_TEST');
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      }

      // 5. 渲染主页
      const config = validateConfig(env);
      const data = await checkAllTunnels(config);
      const mutedList = JSON.parse(await env.TUNNEL_KV.get("muted_tunnels") || "[]");
      const permanentMutedList = JSON.parse(await env.TUNNEL_KV.get("permanent_muted_tunnels") || "[]");
      return new Response(generateHtml(data, mutedList, permanentMutedList), { headers: { "Content-Type": "text/html;charset=utf-8" } });
    } catch (e) {
      console.error("Fetch Error:", e.message);
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }
};
