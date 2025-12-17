## Cloudflare Tunnel Monitor
一个功能强大、界面现代的 Cloudflare Tunnel 监控工具。支持多账号管理、美观的卡片式看板、Telegram 报警，以及高性能的并行检查。

## 功能特性
🚀 高性能并行检查：同时检查所有账号，大幅缩短响应时间。
🎨 现代化卡片看板：告别传统表格，使用直观的卡片式布局，一目了然。
🔍 强大的筛选与排序：支持按账号、状态筛选，按名称、账号排序，以及关键词搜索。
🤖 智能 Telegram 报警：支持只在出错时报警，消息清晰，直达问题。
📱 响应式设计：完美适配桌面、平板和手机屏幕。
⚙️ 灵活的配置：支持换行或分号配置多账号，方便管理。
🔄 自动/手动刷新：可开启自动刷新，也可随时手动更新数据。
在线预览
Dashboard Preview
(此处可替换为你自己的截图或演示链接)

## 部署教程
本教程将指导你如何在 5 分钟内将 Cloudflare Tunnel Monitor 部署到 Cloudflare Workers。

### 第 1 步：准备 Cloudflare API 令牌登录 Cloudflare Dashboard。

进入 “我的个人资料” -> “API 令牌” 页面。点击 “创建令牌”，然后选择 “自定义令牌”。给令牌起一个名字，例如 TunnelMonitor。在 “权限” 部分，添加以下权限：

Account / Cloudflare Tunnel:Read
Zone / Zone:Read (可选，某些隧道可能需要)

在 “账户资源” 部分，选择 “所有账户” (如果你的隧道分布在多个账户中) 或指定特定账户。点击 “继续以显示摘要”，然后 “创建令牌”。

重要：立即复制生成的令牌，因为它只会显示一次。
### 第 2 步：准备 Telegram Bot (可选，用于报警)
如果你需要 Telegram 报警功能，请完成此步骤。

在 Telegram 中搜索 @BotFather，并开始对话。
发送 /newbot 命令，按照提示创建你的机器人，并获取 Bot Token。
创建一个 Telegram 群组或与你的机器人进行私聊。
在群组中发送任意消息，然后将你的机器人拉入群组。
在浏览器中访问以下 URL，获取你的 Chat ID：

自动换行

折叠
复制
1
https://api.telegram.org/bot<你的_BOT_TOKEN>/getUpdates
将 <你的_BOT_TOKEN> 替换为上一步获取的 Token。返回的 JSON 结果中的 chat.id 就是你的 Chat ID。
第 3 步：部署到 Cloudflare Workers
登录 Cloudflare Dashboard。
在左侧菜单中选择 “Workers & Pages”。
点击 “创建应用程序”，然后选择 “创建 Worker”。
给你的 Worker 起一个名字，例如 cf-tunnel-monitor，然后点击 “部署”。
部署成功后，点击 “编辑代码” 按钮。
删除编辑器中的默认代码，然后将本项目 worker.js 文件的 完整代码 全部复制并粘贴进去。
点击 “保存并部署”。
第 4 步：配置环境变量
这是最关键的一步，用于告诉 Worker 你的账号信息和报警设置。

在 Worker 的编辑页面，点击顶部选项卡中的 “设置”。
选择左侧的 “变量”，然后点击 “添加变量”。
添加以下环境变量：
变量名
值
必填
说明
ACCOUNTS_LIST	备注1,账户ID1,API令牌1	✅	核心配置。每行一个账号，格式为 备注,账户ID,API令牌。支持换行或分号分隔多个账号。
TG_BOT_TOKEN	你的_BOT_TOKEN	❌	Telegram Bot 的 Token。
TG_CHAT_ID	你的_CHAT_ID	❌	接收报警消息的 Chat ID。
ALERT_ONLY_ON_ERROR	true	❌	(默认: true) 是否只在隧道出错时发送报警。设为 false 则每次定时任务都会发送状态报告。

ACCOUNTS_LIST 配置示例 (支持换行):

自动换行

折叠
复制
1
2
个人博客,xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
公司官网,zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz,wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww
配置完成后，点击 “保存”。
第 5 步：设置定时任务 (用于报警)
在 Worker 的 “设置” 页面，选择左侧的 “触发器”。
在 “Cron 触发器” 部分，点击 “添加触发器”。
输入一个 Cron 表达式来定义检查频率。例如：
*/5 * * * * : 每 5 分钟检查一次
0 */1 * * * : 每 1 小时检查一次
点击 “保存”。
完成！
现在，你可以访问你的 Worker 的 .workers.dev 域名来查看你的监控面板了。如果配置了 Telegram，当隧道状态异常时，你将会收到报警消息。

许可证
MIT License
