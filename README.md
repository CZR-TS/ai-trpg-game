# AI 双人跑团游戏（AI TRPG for Two）

一个由 AI 驱动的 **双人网页跑团游戏**：两位玩家在各自浏览器中接入同一局，AI 担任"主持人(DM)"，根据预先配置的世界观 / 角色卡 / 物品库推进剧情，玩家每回合各自做出选择，最终由 AI 综合两路选择动态生成结局。

## 特性

- **双人实时联机**：基于 WebSocket（Socket.IO），同一局域网下用房间码加入。
- **AI 叙事 DM**：调用 OpenAI 兼容大模型（GLM / DeepSeek / GPT 等均可）作为主持人。
- **三种回合机制融合**：合作、对抗、暗中选择博弈（见 [docs/方案.md](docs/方案.md)）。
- **酒馆风格世界书**：关键词触发 + 递归激活 + token 预算，兼容 SillyTavern 世界书格式（见 [worldbook/README.md](worldbook/README.md)）。
- **结局动态生成**：全程选择被记录，最终结局由 AI 综合判定，不固定。

## 技术栈

- 后端：Node.js + Express + Socket.IO
- 前端：原生 HTML/CSS/JS（后续可升级 React）
- AI：OpenAI 兼容接口（可配置模型 / Key / BaseURL）

## 目录结构

```
ai-trpg-game/
├── docs/                # 设计文档
│   └── 方案.md          # 游戏机制与架构方案
├── worldbook/           # 世界书（核心：世界观/物品/NPC）
│   ├── README.md        # 世界书格式说明（必读）
│   ├── schema.json      # 条目 JSON Schema
│   ├── template.json    # 空模板
│   └── examples/        # 示例世界书
│       └── fantasy-example/
│           ├── worldbook.json
│           └── dm_character.json
├── server/              # 后端（待实现）
├── public/              # 前端（待实现）
└── config/
    └── config.example.json   # AI 模型配置示例
```

## 快速开始（待实现）

> 后端 / 前端代码尚未编写，此处为预期流程，开发完成后可用。

```bash
npm install
cp config/config.example.json config/config.json   # 填入你的 API Key
npm start
# 浏览器访问 http://localhost:3000
```

## 状态

- [x] 项目骨架 + 世界书格式 + 示例
- [ ] 后端服务（房间 / 状态机 / AI 调用）
- [ ] 世界书引擎（关键词 + 递归 + token 预算）
- [ ] 前端界面（剧情展示 / 选择 / 双人同步）
- [ ] 局域网联机测试
