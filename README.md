# 共叙（AI TRPG for Two）

一个由 AI 驱动的 **双人网页跑团游戏**：两位玩家在各自浏览器中接入同一局，AI 担任"主持人(DM)"，根据预先配置的世界观 / 角色卡 / 物品库推进剧情，玩家每回合各自做出选择（可从 AI 给出的选项中选择，也可自定义任意行动），最终由 AI 综合两路选择动态生成结局。

## 特性

- **双人实时联机**：基于 WebSocket（Socket.IO），用 8 位房间码加入，支持断线自动重连与刷新页面恢复进度（localStorage 记忆房间码/昵称）。
- **AI 叙事 DM**：调用 OpenAI 兼容大模型（GLM / DeepSeek / GPT 等均可）作为主持人，支持开场预加载与下一回合预生成。
- **三种回合机制融合**：合作、对抗、暗中选择博弈（见 [docs/方案.md](docs/方案.md)）。
- **酒馆风格世界书**：关键词触发 + 递归激活 + 分组/概率/预算，兼容 SillyTavern 世界书格式（编写规范见 [worldbook/GUIDE.md](worldbook/GUIDE.md)）。
- **自由行动**：玩家可不拘泥于 AI 给出的选项，输入任意自定义行动/台词。
- **后台管理**：管理员登录（账号/密码 + JWT），管理世界书、创建/关闭房间、查看房间进度与历史记录。
- **实时在线**：后台顶部实时展示在线玩家，按房间成对显示昵称与状态，每 5 秒自动刷新。
- **历史持久化**：已结束/关闭的房间自动落盘（`data/room-history/`），后台可查看与删除。
- **结局动态生成**：全程选择被记录，最终结局由 AI 综合判定，不固定。

## 技术栈

- 后端：Node.js + Express + Socket.IO + JSON Web Token + scrypt 密码哈希
- 前端：原生 HTML/CSS/JS（无构建步骤，可直接静态部署），lucide 图标
- AI：OpenAI 兼容接口（可配置模型 / Key / BaseURL）

## 快速开始

```bash
npm install
cp config/config.example.json config/config.json   # 填入 AI API Key，并设置 auth 密码/jwtSecret
npm start        # 或 npm run dev（文件监听重启）
# 浏览器访问 http://localhost:38571
```

- 管理员入口：页面右上角「管理员」（默认账号 `admin`，密码在 `config/config.json` 的 `auth.password`，可写明文，启动时自动升级为 scrypt 哈希）。
- 也可用环境变量覆盖：`TRPG_PORT`、`TRPG_ADMIN_PASSWORD`、`TRPG_AI_API_KEY`、`TRPG_DISABLE_AI=1`（禁用 AI 走演示模式）等（见 `server/config.js`）。
- 玩家：首页输入**房间码 + 昵称**即可加入，无需账号。

## 测试

```bash
npm test           # 后端单元测试
TRPG_ADMIN_PASSWORD=xxx npm run test:smoke   # 集成测试（需先启动服务）
```

## 目录结构

```
ai-trpg-game/
├── server/            # 后端：Express 路由 / Socket.IO 房间状态机 / 世界书引擎 / LLM 调用
│   ├── index.js       # HTTP + Socket.IO 入口
│   ├── game.js        # 房间、状态机、对局推进、历史持久化
│   ├── lorebook.js    # 世界书引擎（关键词匹配、递归、分组、概率、预算）
│   ├── llm.js         # LLM 调用与返回解析（含演示模式 mock）
│   ├── auth.js        # 管理员登录 / JWT / 失败限流
│   ├── admin.js       # 后台 API（世界书/房间/历史/实时在线）
│   └── config.js      # 配置加载（含环境变量覆盖、密码哈希）
├── public/            # 前端（原生 JS，无构建）
│   ├── index.html     # 6 视图状态机：登录/后台/入口/大厅/对局/结局
│   ├── css/style.css
│   └── js/            # client.js（socket 封装）/ app.js（状态机）/ ui.js（DOM 工具）
├── worldbook/         # 世界书（核心：世界观/物品/NPC）
│   ├── GUIDE.md       # 世界书编写规范指南（编写新世界书必读）
│   ├── README.md      # 世界书格式说明
│   ├── schema.json    # 条目 JSON Schema
│   ├── template.json  # 空模板
│   └── examples/      # 示例世界书（fantasy-example 奇幻 / xuanhuan-example 玄幻 202 条）
├── test/              # unit.mjs 单元测试 / smoke.mjs 集成测试
├── deploy/            # 服务器部署脚本与 systemd 服务单元
├── docs/              # 设计文档
└── config/
    └── config.example.json   # AI 模型与服务器配置示例
```

## 世界书编写

本项目世界书**兼容 SillyTavern（酒馆）格式**。编写新世界书前，请务必阅读：
- **[worldbook/GUIDE.md](worldbook/GUIDE.md)** —— 世界书编写规范指南（字段要求、触发机制、关键词治理、递归防爆、随机事件、group 用法等）
- **[worldbook/README.md](worldbook/README.md)** —— 世界书 JSON 格式说明
- 完整示例见 `worldbook/examples/xuanhuan-example/worldbook.json`

## 部署

- 使用 `deploy/` 下的 systemd 服务单元（`ai-trpg-game.service`）与原子切换脚本（`update.sh`），采用 **releases/current/shared** 目录结构：新版本解压到 `releases/<版本>` 后切换 `current` 软链并重启，健康检查失败自动回滚。
- 更新方式：`git archive` 打包提交上传服务器，或 `update.sh` 直接从 GitHub 拉取。
- 详细部署说明见 `deploy/README.md`。

## 状态

- [x] 项目骨架 + 世界书格式 + 示例
- [x] 后端服务（房间 / 状态机 / AI 调用 / 认证）
- [x] 世界书引擎（关键词 + 递归 + 分组/概率 + token 预算）
- [x] 前端界面（剧情展示 / 选项与自由行动 / 双人同步 / 断线重连）
- [x] 后台管理（世界书 / 房间 / 历史 / 实时在线）
- [x] 局域网与公网联机（Socket.IO + 静态资源缓存版本号）
