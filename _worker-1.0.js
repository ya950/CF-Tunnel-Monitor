/**
 * Cloudflare Tunnel Monitor v8.0 (Final Repair & Integration)
 * 1. 修复 GitHub Action 触发逻辑（确保定时任务和手动按钮均有效）
 * 2. 完整保留账号筛选、搜索功能
 * 3. 完整保留 KV 静音同步 (🔔/🔕)
 * 4. 隧道名称黄色加粗，GitHub 完整信息按钮回归
 */

// ================= 1. 配置验证模块 (保持 v5.8 原始逻辑) =================

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

    let ghInfo = { owner: null, repo: null, pat: null };
    if (ghPart) {
      const ghClean = ghPart.replace(/^GitHub:/i, '').trim();
      const ghDetails = ghClean.split(',').map(s => s.trim());
      if (ghDetails.length >= 3) {
        ghInfo.owner = ghDetails[0]; ghInfo.repo = ghDetails[1]; ghInfo.pat = ghDetails[2];
      }
    }

    if (tunnelNames.length > 0) {
      for (const tName of tunnelNames) {
        tunnels.push({ name: tName, accountId, apiToken, accountName: accountAlias, githubOwner: ghInfo.owner, githubRepo: ghInfo.repo });
        if (ghInfo.pat) {
          patMap.set(tName, { pat: ghInfo.pat, owner: ghInfo.owner, repo: ghInfo.repo, alias: accountAlias });
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
      chatId: env.TG_CHAT_ID 
    },
    alertOnlyOnError: env.ALERT_ONLY_ON_ERROR !== "false"
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

  const promises = Array.from(accountsMap.values()).map(acc => fetchAccountData(acc));
  const results = await Promise.allSettled(promises);
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
            name: realT.name, id: realT.id, status: realT.status, accountName, 
            githubOwner: conf ? conf.githubOwner : null, 
            githubRepo: conf ? conf.githubRepo : null 
          });
        });
      }
    }
  }
  return { tunnels: finalData, stats };
}

async function fetchAccountData(ctx) {
  try {
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ctx.accountId}/tunnels?is_deleted=false`, {
      headers: { "Authorization": `Bearer ${ctx.apiToken}`, "Content-Type": "application/json" }
    });
    const json = await resp.json();
    return { ...ctx, apiData: json.result || [], error: json.success ? null : "API Error" };
  } catch (e) { return { ...ctx, apiData: [], error: e.message }; }
}

// ================= 3. GitHub 触发模块 (修复后的原始逻辑) =================

async function triggerGitHub(patMap, tunnelName, status) {
  const info = patMap.get(tunnelName);
  if (!info) return { success: false, msg: "未配置 GitHub 触发规则" };
  if (status === 'healthy') return { success: false, msg: "状态正常" };

  const { owner, repo, pat } = info;
  const workflowFile = 'mian.yml'; 
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'CF-Monitor'
      },
      body: JSON.stringify({ ref: "main" })
    });
    
    if (resp.status === 204) {
      return { success: true, msg: "触发成功" };
    } else {
      const errText = await resp.text();
      return { success: false, msg: `GitHub 错误 ${resp.status}: ${errText}` };
    }
  } catch (e) {
    return { success: false, msg: `网络错误: ${e.message}` };
  }
}

// ================= 4. HTML 看板渲染 (UI 完整版) =================

function generateHtml(data, mutedList) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const { total, healthy } = data.stats;
  const allAccounts = [...new Set(data.tunnels.map(t => t.accountName))];
  const accOptions = allAccounts.map(a => `<option value="${a}">${a}</option>`).join('');

  let cards = "";
  data.tunnels.sort((a, b) => (a.status !== 'healthy' ? -1 : 1)).forEach(t => {
    const isHealthy = t.status === 'healthy';
    const isMuted = mutedList.includes(t.name);
    const shortId = t.id && t.id !== 'N/A' ? t.id.slice(0, 8) : 'N/A';
    const hasGh = !!t.githubOwner;

    const ghBadge = hasGh 
      ? `<a href="https://github.com/${t.githubOwner}/${t.githubRepo}" target="_blank" class="repo-badge">
           <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16" style="margin-right:4px;"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
           ${t.githubOwner}/${t.githubRepo}
         </a>`
      : `<span class="no-repo">🚫 仅监控 (无触发)</span>`;

    cards += `
    <div class="card ${isHealthy ? '' : 'card-warn'}" data-acc="${t.accountName}" data-name="${t.name}">
      <div class="status-dot-container"><div class="dot ${isHealthy ? 'dot-healthy' : 'dot-unhealthy'}"></div></div>
      <div class="card-head"><span>${t.accountName}</span><span>${shortId}</span></div>
      <div class="card-body">
        <div class="name-row">
          <span class="stat-txt">${t.name}</span>
          <button class="tg-toggle ${isMuted ? '' : 'active'}" onclick="toggleKV('${t.name}', this)">${isMuted ? '🔕' : '🔔'}</button>
        </div>
        <div style="margin: 8px 0;">${ghBadge}</div>
        <div class="actions">
          ${hasGh ? `<button class="btn-test" onclick="triggerAction('${t.name}', this)">🧪 触发修复</button>` : `<button class="btn-test" disabled style="opacity:0.3">🚫 无修复配置</button>`}
        </div>
      </div>
    </div>`;
  });

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Monitor v8.0</title>
  <style>
    :root { --bg:#f3f4f6; --card:#fff; --text:#1f2937; --mute:#6b7280; --ok:#10b981; --err:#ef4444; --warn:#f59e0b; --btn:#3b82f6; --link-bg:#eff6ff; --link-fg:#2563eb; }
    body { font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); margin:0; padding:15px; }
    .container { max-width:1200px; margin:0 auto; background:var(--card); border-radius:16px; box-shadow:0 4px 10px rgba(0,0,0,0.05); overflow:hidden; }
    .header { padding:20px 25px; color:#fff; background: linear-gradient(135deg, #6366f1, #3b82f6); }
    .header.header-warn { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:15px; padding:20px; }
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:15px; transition: 0.2s; }
    .card-warn { border-color: #fecaca; background: #fffafb; }
    .status-dot-container { display:flex; justify-content:center; margin-bottom:10px; }
    .dot { width:11px; height:11px; border-radius:50%; }
    .dot-healthy { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot-unhealthy { background: var(--err); box-shadow: 0 0 10px var(--err); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    .card-head { display:flex; justify-content:space-between; font-size:0.75rem; color:var(--mute); margin-bottom:12px; font-weight:600; text-transform:uppercase; }
    .name-row { display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:10px; }
    .stat-txt { font-weight:800; font-size:1.15rem; color: var(--warn); word-break: break-all; }
    .tg-toggle { background:none; border:none; cursor:pointer; font-size:1.2rem; opacity:0.4; filter:grayscale(1); transition:0.2s; padding:0; }
    .tg-toggle.active { opacity:1; filter:grayscale(0); }
    .repo-badge { display:inline-flex; align-items:center; background:var(--link-bg); color:var(--link-fg); padding:5px 10px; border-radius:6px; font-size:0.8rem; text-decoration:none; font-weight:600; border:1px solid #dbeafe; }
    .repo-badge:hover { background: #dbeafe; }
    .btn-test { width:100%; background:var(--btn); color:#fff; border:none; padding:8px; border-radius:8px; cursor:pointer; font-size:0.8rem; font-weight:600; margin-top:10px; }
    .footer { padding:12px 25px; font-size:0.75rem; color:var(--mute); text-align:right; border-top:1px solid #e5e7eb; background:#f9fafb; }
    .controls { padding:12px 25px; background:#f9fafb; border-bottom:1px solid #e5e7eb; display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    select, input { padding:6px 12px; border:1px solid #ddd; border-radius:8px; font-size:0.85rem; }
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

    async function toggleKV(name, btn) {
      const isMuting = btn.classList.contains('active');
      btn.style.opacity = '0.2';
      try {
        const res = await fetch(\`/toggle-mute?name=\${encodeURIComponent(name)}&action=\${isMuting ? 'mute' : 'unmute'}\`);
        if(res.ok) {
            btn.classList.toggle('active');
            btn.innerText = isMuting ? '🔕' : '🔔';
        }
      } catch(e) { alert('KV同步失败'); }
      finally { btn.style.opacity = isMuting ? '0.4' : '1'; }
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

// ================= 5. Worker 入口逻辑 (集成 KV 与触发) =================

export default {
  async scheduled(event, env, ctx) {
    try {
      const config = validateConfig(env);
      const data = await checkAllTunnels(config);
      const mutedRaw = await env.TUNNEL_KV.get("muted_tunnels");
      const mutedList = JSON.parse(mutedRaw || "[]");

      let alertMessages = [];
      for (const t of data.tunnels) {
        if (t.status !== 'healthy') {
          // 1. 定时任务触发修复 (不受静音影响)
          if (config.patMap.has(t.name)) {
            console.log(`[Scheduled] 隧道 ${t.name} 异常，触发修复...`);
            await triggerGitHub(config.patMap, t.name, t.status);
          }
          // 2. 收集报警 (受静音列表过滤)
          if (!mutedList.includes(t.name)) {
            alertMessages.push(`🚨 **${t.name}** (${t.accountName}): ${t.status}`);
          }
        }
      }

      if (alertMessages.length > 0 && env.TG_BOT_TOKEN) {
        await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: alertMessages.join("\n"), parse_mode: "Markdown" })
        });
      }
    } catch (e) { console.error("Scheduled Error:", e); }
  },

  async fetch(request, env, ctx) {
    try {
      const config = validateConfig(env);
      const url = new URL(request.url);

      // KV 交互
      if (url.pathname === '/toggle-mute') {
        const name = url.searchParams.get('name');
        const action = url.searchParams.get('action');
        let mutedList = JSON.parse(await env.TUNNEL_KV.get("muted_tunnels") || "[]");
        if (action === 'mute' && !mutedList.includes(name)) mutedList.push(name);
        else if (action === 'unmute') mutedList = mutedList.filter(n => n !== name);
        await env.TUNNEL_KV.put("muted_tunnels", JSON.stringify(mutedList));
        return new Response("OK");
      }

      // 手动触发
      if (url.pathname === '/trigger-test') {
        const tName = url.searchParams.get('name');
        if (!tName) return new Response(JSON.stringify({success:false, msg:'Missing name'}), {status:400});
        const result = await triggerGitHub(config.patMap, tName, 'MANUAL_TEST');
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      }

      // 渲染主页
      const data = await checkAllTunnels(config);
      const mutedList = JSON.parse(await env.TUNNEL_KV.get("muted_tunnels") || "[]");
      return new Response(generateHtml(data, mutedList), { headers: { "Content-Type": "text/html;charset=utf-8" } });
    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  }
};
