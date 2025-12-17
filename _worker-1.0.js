/**
 * Cloudflare Tunnel Monitor v5.7 (Fix: Full Account Monitor + Selective Trigger)
 * 功能：
 * 1. 监控账号下所有隧道（无论是否在配置列表）
 * 2. 只有配置了 GitHub 的隧道才触发 Action
 */

// ================= 1. 配置验证模块 (保持不变) =================

function validateConfig(env) {
  if (!env.ACCOUNTS_LIST) throw new Error("未配置 ACCOUNTS_LIST");

  let rawList = env.ACCOUNTS_LIST
    .replace(/：/g, ':').replace(/，/g, ',').replace(/；/g, ';');
  
  const lines = rawList.split('\n').map(s => s.trim()).filter(s => s !== "");
  if (lines.length === 0) throw new Error("ACCOUNTS_LIST 为空");

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

    if (cfDetails.length < 2) continue; // 只要有 ID 和 Token 即可

    const accountId = cfDetails[0];
    const apiToken = cfDetails[1];
    // 获取配置中指定的隧道（如果有）
    const tunnelNames = cfDetails.slice(2).filter(t => t !== "");

    let ghInfo = { owner: null, repo: null, pat: null };
    if (ghPart) {
      const ghClean = ghPart.replace(/^GitHub:/i, '').trim();
      const ghDetails = ghClean.split(',').map(s => s.trim());
      if (ghDetails.length >= 3) {
        ghInfo.owner = ghDetails[0];
        ghInfo.repo = ghDetails[1];
        ghInfo.pat = ghDetails[2];
      }
    }

    // 即使没有指定隧道名，我们也记录账号信息以便 API 获取
    // 如果指定了隧道名，就建立映射关系
    if (tunnelNames.length > 0) {
      for (const tName of tunnelNames) {
        tunnels.push({
          name: tName,
          accountId: accountId,
          apiToken: apiToken,
          accountName: accountAlias,
          githubOwner: ghInfo.owner,
          githubRepo: ghInfo.repo
        });

        if (ghInfo.pat) {
          patMap.set(tName, {
            pat: ghInfo.pat,
            owner: ghInfo.owner,
            repo: ghInfo.repo,
            alias: accountAlias
          });
        }
      }
    } else {
      // 如果只配了账号没配具体隧道，添加一个占位符以确保账号被扫描
      tunnels.push({
        name: "__ACCOUNT_SCANNER__", 
        accountId: accountId, 
        apiToken: apiToken, 
        accountName: accountAlias,
        isScanner: true
      });
    }
  }

  return { tunnels, patMap, telegram: { enabled: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID), botToken: env.TG_BOT_TOKEN, chatId: env.TG_CHAT_ID }, alertOnlyOnError: env.ALERT_ONLY_ON_ERROR !== "false" };
}

// ================= 2. 核心检查逻辑 (重大逻辑修正) =================

async function checkAllTunnels(config) {
  const accountsMap = new Map();
  
  // 1. 按账号 ID 分组
  config.tunnels.forEach(t => {
    if (!accountsMap.has(t.accountId)) {
      accountsMap.set(t.accountId, {
        accountId: t.accountId, 
        apiToken: t.apiToken, 
        accountName: t.accountName, 
        configTunnels: [] // 这里存放显式配置的隧道
      });
    }
    if (!t.isScanner) {
      accountsMap.get(t.accountId).configTunnels.push(t);
    }
  });

  const promises = Array.from(accountsMap.values()).map(acc => fetchAccountData(acc));
  const results = await Promise.allSettled(promises);

  let finalData = [];
  let stats = { total: 0, healthy: 0 };
  let hasError = false;
  let alertMessages = [];

  for (const res of results) {
    if (res.status === 'fulfilled') {
      const { accountName, apiData, error, configTunnels } = res.value;

      if (error) {
        hasError = true;
        alertMessages.push(`❌ **${accountName}** API 失败: ${error}`);
        // 如果 API 挂了，至少把配置里的隧道显示为错误
        configTunnels.forEach(t => finalData.push({ ...t, status: 'api_error', id: 'N/A' }));
      } else {
        // === 逻辑修正核心：以 API 数据为准，全量展示 ===
        
        // 1. 建立配置映射 (用于查找 GitHub 配置)
        const configMap = new Map(configTunnels.map(t => [t.name, t]));
        
        // 2. 遍历 API 返回的每一个隧道 (不管是否配置，全都要)
        apiData.forEach(realT => {
          stats.total++;
          const conf = configMap.get(realT.name);
          
          // 状态判断
          let currentStatus = realT.status;
          if (currentStatus === 'healthy') {
            stats.healthy++;
          } else {
            hasError = true;
            // 区分：是配置了监控的隧道报错，还是未配置的隧道报错
            const prefix = conf ? '🚨' : '⚠️';
            alertMessages.push(`${prefix} **${realT.name}** (${accountName}): ${currentStatus}`);
          }

          // 合并数据：API数据 + 配置的GitHub信息(如果有)
          finalData.push({
            name: realT.name,
            id: realT.id,
            status: currentStatus,
            accountName: accountName,
            accountId: realT.account_id, // 确保有 ID
            // 只有匹配到的才会有 GitHub 信息
            githubOwner: conf ? conf.githubOwner : null,
            githubRepo: conf ? conf.githubRepo : null
          });

          // 从 map 中移除，剩下的就是“配置了但没找到”的
          if (conf) configMap.delete(realT.name);
        });

        // 3. 处理“配置里有，但 API 里没找到”的死隧道
        configMap.forEach(confT => {
          hasError = true;
          alertMessages.push(`❓ **${confT.name}** (${accountName}): 未找到 (已删除?)`);
          finalData.push({ ...confT, status: 'not_found', id: 'N/A' });
        });
      }
    } else {
      hasError = true;
      alertMessages.push(`❌ 系统错误: ${res.reason.message}`);
    }
  }
  return { tunnels: finalData, stats, hasError, alertMessages };
}

async function fetchAccountData(ctx) {
  try {
    const data = await fetchCFAPI(ctx.accountId, ctx.apiToken);
    return { ...ctx, apiData: data, error: null };
  } catch (e) {
    return { ...ctx, apiData: [], error: e.message };
  }
}

async function fetchCFAPI(accountId, token) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/tunnels?is_deleted=false`, {
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      signal: controller.signal
    });
    clearTimeout(id);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.errors[0]?.message || "API Error");
    return json.result;
  } catch (e) {
    clearTimeout(id);
    throw e.name === 'AbortError' ? new Error("Timeout") : e;
  }
}

// ================= 3. GitHub 触发模块 (mian.yml) =================

async function triggerGitHub(patMap, tunnelName, status) {
  const info = patMap.get(tunnelName);
  
  // 关键：如果没有配置 PAT，直接返回 false，不报错，也不触发
  if (!info) return { success: false, msg: "未配置 GitHub 触发规则 (忽略)" };
  
  if (status === 'healthy') return { success: false, msg: "状态正常" };

  const { owner, repo, pat } = info;
  const workflowFile = 'mian.yml'; 
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const body = { ref: "main" };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'CF-Monitor'
      },
      body: JSON.stringify(body)
    });
    
    if (resp.status === 204) {
      return { success: true, msg: "触发成功 (Workflow Dispatch)" };
    } else {
      const errText = await resp.text();
      return { success: false, msg: `GitHub 错误 ${resp.status}: ${errText}` };
    }
  } catch (e) {
    return { success: false, msg: `网络错误: ${e.message}` };
  }
}

// ================= 4. TG 消息模块 =================

async function sendTelegram(config, text) {
  if (!config.telegram.enabled) return;
  await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegram.chatId, text: text, parse_mode: "Markdown" })
  }).catch(console.error);
}

// ================= 5. HTML 看板模块 =================

function generateHtml(data) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const { total, healthy } = data.stats;
  const isOk = total > 0 && total === healthy;
  const statusClass = isOk ? 'header-ok' : 'header-warn';
  const statusText = isOk ? '🛡️ 系统运行正常' : '⚠️ 存在异常隧道';

  let cards = "";
  if (data.tunnels.length === 0) {
    cards = `<div class="alert-box error">未检测到隧道，请检查配置或 Token 权限。</div>`;
  } else {
    // 排序：异常的在前，配置了GitHub的在前
    data.tunnels.sort((a, b) => {
        if (a.status !== 'healthy' && b.status === 'healthy') return -1;
        if (a.status === 'healthy' && b.status !== 'healthy') return 1;
        if (a.githubOwner && !b.githubOwner) return -1;
        if (!a.githubOwner && b.githubOwner) return 1;
        return 0;
    });

    data.tunnels.forEach(t => {
      let cssClass = 'card-unhealthy', icon = '🚨', txt = t.status;
      const hasGh = !!t.githubOwner;
      // 这里的显示逻辑：如果有GitHub配置，显示仓库名；没有则显示“仅监控”
      const ghText = hasGh ? `<code>${t.githubOwner}/${t.githubRepo}</code>` : '<span style="color:#9ca3af">仅监控</span>';
      const shortId = t.id && t.id !== 'N/A' ? t.id.slice(0, 8) : 'N/A';

      if (t.status === 'healthy') { cssClass = 'card-healthy'; icon = '✅'; txt = 'Healthy'; }
      if (t.status === 'api_error') { cssClass = 'card-error'; icon = '❌'; txt = 'API Error'; }
      if (t.status === 'not_found') { cssClass = 'card-error'; icon = '❓'; txt = 'Not Found'; }

      const testBtn = hasGh 
        ? `<button class="btn-test" onclick="testAction('${t.name}', this)">🧪 触发 Workflow</button>` 
        : `<button class="btn-test" disabled style="opacity:0.5;cursor:default">🚫 无触发配置</button>`;

      cards += `
      <div class="card ${cssClass}" data-acc="${t.accountName}" data-stat="${t.status}" data-name="${t.name}">
        <div class="card-head">
          <span class="acc-name">${t.accountName}</span>
          <span class="tun-id">${shortId}</span>
        </div>
        <div class="card-body">
          <div class="icon">${icon}</div>
          <div class="stat-txt">${txt}</div>
          <div class="meta">GH: ${ghText}</div>
          <div class="meta">Name: <strong>${t.name}</strong></div>
          <div class="actions">${testBtn}</div>
        </div>
      </div>`;
    });
  }

  const accs = [...new Set(data.tunnels.map(t => t.accountName))];
  const options = accs.map(a => `<option value="${a}">${a}</option>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Tunnel Monitor</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#f3f4f6; --card:#fff; --text:#1f2937; --mute:#6b7280; --ok:#10b981; --err:#ef4444; --warn:#f59e0b; --btn:#3b82f6; }
    body { font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); margin:0; padding:20px; }
    .container { max-width:1200px; margin:0 auto; background:var(--card); border-radius:16px; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1); overflow:hidden; }
    .header { padding:30px; color:#fff; background: linear-gradient(135deg, #6366f1, #3b82f6); }
    .header.header-warn { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .header-content { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:15px; }
    .title h1 { margin:0; font-size:1.5rem; }
    .subtitle { margin-top:5px; opacity:0.9; font-size:0.9rem; display:flex; gap:15px; }
    .controls { padding:20px; background:#f9fafb; border-bottom:1px solid #e5e7eb; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    select, input { padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:0.9rem; }
    .btn-refresh { background:rgba(255,255,255,0.2); border:1px solid rgba(255,255,255,0.3); color:#fff; text-decoration:none; padding:8px 16px; border-radius:8px; cursor:pointer; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:20px; padding:30px; }
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; display:flex; flex-direction:column; transition:transform 0.2s; box-shadow:0 2px 4px rgba(0,0,0,0.05); }
    .card-healthy { border-top:4px solid var(--ok); }
    .card-unhealthy { border-top:4px solid var(--err); background:#fef2f2; }
    .card-error { border-top:4px solid var(--warn); background:#fffbeb; }
    .card-head { display:flex; justify-content:space-between; margin-bottom:15px; font-size:0.85rem; color:var(--mute); font-weight:600; text-transform:uppercase; }
    .card-body { text-align:center; flex-grow:1; display:flex; flex-direction:column; gap:5px; align-items:center; }
    .icon { font-size:2rem; }
    .stat-txt { font-weight:700; font-size:1.1rem; margin-bottom:5px; }
    .meta { font-size:0.85rem; color:var(--mute); }
    code { background:rgba(0,0,0,0.05); padding:2px 4px; border-radius:4px; }
    .actions { margin-top:10px; width:100%; }
    .btn-test { width:100%; background:var(--btn); color:#fff; border:none; padding:8px; border-radius:6px; cursor:pointer; font-size:0.85rem; transition:0.2s; }
    .btn-test:hover { filter:brightness(0.9); }
    .btn-test:disabled { background:#cbd5e1; cursor:not-allowed; }
    .footer { padding:15px 30px; background:#f9fafb; border-top:1px solid #e5e7eb; text-align:right; font-size:0.85rem; color:var(--mute); }
    .switch-wrapper { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:0.9rem; }
    @media (max-width: 768px) { .header-content { flex-direction:column; align-items:flex-start; } .switch-wrapper { margin-left:0; margin-top:10px; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header ${statusClass}">
      <div class="header-content">
        <div class="title">
          <h1>☁️ CF Tunnel Monitor</h1>
          <div class="subtitle">
            <span>${statusText}</span>
            <span>Total: ${total}</span>
            <span>Healthy: ${healthy}</span>
          </div>
        </div>
        <div class="btn-refresh" onclick="location.reload()">🔄 Refresh</div>
      </div>
    </div>

    <div class="controls">
      <select id="accFilter"><option value="">所有账号</option>${options}</select>
      <select id="statFilter">
        <option value="">所有状态</option>
        <option value="healthy">正常</option>
        <option value="unhealthy">异常</option>
      </select>
      <input type="text" id="search" placeholder="搜索隧道...">
      <div class="switch-wrapper">
        <label><input type="checkbox" id="autoRef"> 自动刷新 (60s)</label>
      </div>
    </div>

    <div class="grid">${cards}</div>
    <div class="footer">Update: ${now}</div>
  </div>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const cards = Array.from(document.querySelectorAll('.card'));
      const accFilter = document.getElementById('accFilter');
      const statFilter = document.getElementById('statFilter');
      const search = document.getElementById('search');
      
      function filter() {
        const acc = accFilter.value;
        const stat = statFilter.value;
        const txt = search.value.toLowerCase();
        cards.forEach(c => {
          const cAcc = c.dataset.acc;
          const cStat = c.dataset.stat;
          const cName = c.dataset.name.toLowerCase();
          let show = true;
          if (acc && cAcc !== acc) show = false;
          if (stat === 'healthy' && cStat !== 'healthy') show = false;
          if (stat === 'unhealthy' && cStat === 'healthy') show = false;
          if (txt && !cName.includes(txt)) show = false;
          c.style.display = show ? 'flex' : 'none';
        });
      }
      accFilter.onchange = filter;
      statFilter.onchange = filter;
      search.oninput = filter;
      
      const cb = document.getElementById('autoRef');
      let timer;
      cb.onchange = () => {
        if(cb.checked) timer = setInterval(() => location.reload(), 60000);
        else clearInterval(timer);
      };
    });

    async function testAction(tunnelName, btn) {
      if(!confirm('确定要手动触发 GitHub Action (mian.yml) 吗？')) return;
      const originalText = btn.innerText;
      btn.innerText = '发送请求...';
      btn.disabled = true;
      try {
        const res = await fetch(\`./trigger-test?name=\${encodeURIComponent(tunnelName)}\`);
        const json = await res.json();
        if(res.ok && json.success) {
          alert('✅ 成功！GitHub Action 已触发。');
        } else {
          alert('❌ 失败: ' + json.msg);
        }
      } catch(e) {
        alert('❌ 网络请求错误: ' + e.message);
      } finally {
        btn.innerText = originalText;
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

// ================= 6. Worker 入口 =================

export default {
  async scheduled(event, env, ctx) {
    try {
      const config = validateConfig(env);
      ctx.waitUntil(handleScheduled(config));
    } catch (e) { console.error("Cron Error:", e); }
  },

  async fetch(request, env, ctx) {
    try {
      const config = validateConfig(env);
      const url = new URL(request.url);

      if (url.pathname === '/trigger-test') {
        const tName = url.searchParams.get('name');
        if (!tName) return new Response(JSON.stringify({success:false, msg:'Missing name'}), {status:400});
        // 强制触发 (状态设为 MANUAL_TEST)
        const result = await triggerGitHub(config.patMap, tName, 'MANUAL_TEST');
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      }

      const data = await checkAllTunnels(config);
      return new Response(generateHtml(data), {
        headers: { "Content-Type": "text/html;charset=utf-8" }
      });
    } catch (e) {
      return new Response(`Config Error: ${e.message}`, { status: 500 });
    }
  }
};

async function handleScheduled(config) {
  // 注意：这里获取的是【全量】隧道数据
  const data = await checkAllTunnels(config);
  
  for (const t of data.tunnels) {
    if (t.status !== 'healthy') {
      // 只有在 patMap 里存在的隧道（即显式配置了 GitHub 的），才去触发工作流
      if (config.patMap.has(t.name)) {
        console.log(`[Trigger] 隧道 ${t.name} 异常，触发 GitHub Action`);
        await triggerGitHub(config.patMap, t.name, t.status);
      } else {
        console.log(`[Skip] 隧道 ${t.name} 异常，但未配置 GitHub 触发规则，跳过。`);
      }
    }
  }

  // Telegram 依然发送所有报警，除非设置了屏蔽
  if (data.alertMessages.length > 0) {
    if (!config.alertOnlyOnError || data.hasError) {
      await sendTelegram(config, data.alertMessages.join("\n"));
    }
  }
}
