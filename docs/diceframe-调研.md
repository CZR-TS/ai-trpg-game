# DiceFrame 调研报告

> 调研对象：https://github.com/diceframe/diceframe
> 调研方式：`git clone --depth 1` 到本地，逐一阅读源码（本文所有代码路径均来自本地 clone 亲眼确认，基准版本 v1.7.6，commit 5ea48d0）
> 调研视角：为我们「AI 双人跑团网页游戏」（Node.js + Express + Socket.IO + OpenAI 兼容 LLM + 世界书机制）寻找可借鉴逻辑

---

## 1. 项目概览

**一句话定位**：DiceFrame 是一个可自部署的 AI 跑团引擎，支持 DND/COC/自定义规则、多人 WebUI 和 QQ 群聊 Bot，把"角色卡、世界书、骰子、状态变动、剧情日志"全部接进同一个游戏状态，由 LLM 充当 GM（主持人）。

| 项 | 值 |
|---|---|
| 语言 | Python（后端 aiohttp）+ Vue 3 / TypeScript（前端） |
| 许可证 | AGPL-3.0 |
| Star / Fork | 6 / 0（早期项目） |
| 创建时间 | 2026-07-15 |
| 最后推送 | 2026-07-30（活跃开发中） |
| 当前版本 | v1.7.6（README 自述仍处早期发布阶段，接口/存档结构还会变动） |

**与我们项目的关系**：这是目前能找到的与「AI 跑团 + 世界书 + 多人」需求最贴合的开源项目——它做的事情几乎就是我们想做的事情的超集（我们还多出"管理员后台导入世界书"这一层，它有但不深）。它用 Python 而非 Node.js，代码不能直接复用，但**核心玩法逻辑（世界书匹配、GM 输出协议、回合状态机、骰子裁决、SSE 同步）全部值得逐条借鉴**。

---

## 2. 技术栈与架构

### 2.1 技术栈

- 后端：Python 3.10+ / aiohttp（异步 Web 框架，SSE 流式推送），SQLite（世界书、记忆库、存档 JSON 文件）
- LLM：直接 `aiohttp` 手写 OpenAI 兼容 Chat Completions 客户端，同时支持 Anthropic 协议；多供应商 fallback
- 前端：Vue 3 + TypeScript + Vite + Pinia + naive-ui + vue-i18n（`frontend-v2/package.json`）
- 部署：Docker / Windows 便携版（C# 启动器）/ 源码运行

### 2.2 目录结构与模块职责（src/）

```
src/
├── engine/        # 游戏状态机（GameInstance）、骰子、剧情追踪、谜题
├── commands/      # 回合处理：RoundProcessor、骰子裁决、标签解析、状态应用、swipe 重生成
├── generation/    # AI 生成世界/规则/角色/世界书条目
├── llm/           # LLM 客户端、上下文拼接器（Token 预算分配）、输出解析器
├── lorebook/      # 世界书 SQLite 存储 + 关键词匹配器  ← 与我们的世界书机制直接对应
├── memory/        # 长期记忆（三元组 SQLite + 向量/文本召回）、摘要压缩
├── rules/         # JSON 数据驱动的规则系统
├── webui/         # HTTP API、路由、服务层、SSE、登录、防滥用
└── bots/          # QQ/NapCat 群聊适配（WebSocket + 卡片渲染）
prompts/           # GM 系统提示词（gm_system_zh.md / gm_system_en.md）
templates/
├── worlds/        # 世界模板 JSON（含 starter_lorebook 初始世界书条目）
└── rules/         # 规则模板 JSON（dnd5e / freeform_coc / freeform_wuxia 等，支持 extends 继承）
```

架构要点：**单一 GameInstance 内存对象承载一局游戏的全部状态，所有状态变更通过方法 + asyncio.Lock 完成；每轮玩法 = 收集玩家行动 → 世界书匹配 → 骰子裁决 → 拼接 context → LLM 生成 → 解析结构化标签 → 应用状态 → 写日志 → 进入下一轮**。

---

## 3. 功能清单

- 游戏全生命周期：创建（选语言/世界模板/规则/难度）、加入（邀请链接/房间密码）、游玩、暂停、重置、结束
- 多人回合：所有活跃玩家提交行动后才推进（或 GM 强制推进）、暂离/回来、玩家行动可修改
- 骰子：d20（DND 5e）与 d100（CoC）检定、优势/劣势、奖励/惩罚骰、大成功/大失败
- 状态系统：HP/理智/金币/物品/经验/死亡复活/技能成长，全部由 LLM 输出标签驱动
- 世界书：NPC/地点/物品/事件/谜题/势力条目，关键词触发动态注入，支持递归触发、概率、分组、时间效应
- 记忆：长期记忆三元组 + 摘要压缩（每 10 回合）+ 可选 embedding 语义召回
- AI 生成：世界、规则、角色卡、世界书条目均可由模型辅助生成
- 实时同步：SSE 分用户推送叙事/私聊/状态，断线续传（Last-Event-ID）
- 信息不对称：PRIVATE 标签 → 指定玩家私聊消息（仅该玩家可见）
- swipe：同一轮可重新生成多个候选叙事（最多 5 个）并回滚状态
- 群聊 Bot（QQ/NapCat）、插件系统、自动更新、Docker 部署

---

## 4. 可借鉴点详解

### 4.1 世界书机制（与我们最直接相关）

**是什么**：SQLite 存储世界书条目 + 关键词匹配器，每轮把玩家的行动文本拿去匹配，命中的条目注入 LLM 上下文。

**为什么好**：字段设计完整覆盖了"关键词触发注入"的各种现实需求：触发逻辑（AND/ALL/NOT）、触发条件（概率、分组互斥）、注入优先级（tier）、时间效应（sticky 粘住 N 轮/cooldown 冷却/delay 延迟）、角色可见性（visible_to）、NPC 可信度（unreliable）、递归联动（triggers_recursive）。

**代码位置**：

- 条目表结构（世界书字段全集）：`src/lorebook/store.py:14-60`（SCHEMA，`lorebook_entries` 表：type 枚举 npc/location/item/event/puzzle/faction/other、keywords JSON、tier core/background/archived、match_mode、is_constant、sticky/cooldown/delay、probability、group/group_weight、visible_to、unreliable、triggers_recursive、connected_to）
- 匹配器 `KeywordMatcher`：`src/lorebook/matcher.py:17-71`（`build` 建索引 25-47 行；`match` 主流程 49-71 行）
  - 精确/正则匹配：`matcher.py:73-81`（`/pattern/` 格式正则关键词）
  - 模糊子串回退：`matcher.py:154-163`（`_fuzzy_match`，无命中时双字符子串回退）
  - AND/NOT 逻辑：`matcher.py:83-109`（`_apply_match_mode`）
  - 概率过滤：`matcher.py:111-124`（`_apply_probability`）
  - 分组竞争：`matcher.py:126-149`（`_apply_group_competition`，同 group 只留 group_weight 最高者）
  - **递归触发**（条目 A 命中后强制带出条目 B）：`matcher.py:165-225`（`match_with_recursive`，BFS 深度 ≤ 3）
  - **时间效应**（sticky/cooldown/delay）：`matcher.py:227-261`；每轮递减的消费逻辑在 `src/engine/game_instance.py:643-650`（`update_lorebook_timed_state`）
  - tier 排序注入优先级：`matcher.py:263-271`（`_sort_by_tier`）
- 世界书条目由世界模板 JSON 导入：`src/lorebook/bootstrap.py:14-42`；模板结构见 `templates/worlds/default_fantasy.json:9-82`（`starter_lorebook` 数组，每个条目的 id/name/type/keywords/content/tier/unreliable）
- 世界书条目注入 prompt 的格式化方式：`src/llm/context_builder.py:190-207`（`[type] [仅xx可见] name: content`，按 token 预算裁剪）

### 4.2 GM 输出双通道协议：叙事 + 结构化状态标签

**是什么**：GM 的回复 = 玩家可见的叙事文本 + `---` 分隔符 + 一行一个的状态标签（HP/GOLD/SCENE/NPC/LOOT/QUICK_ACTIONS/MEMORY/PRIVATE…），后端解析标签驱动游戏状态；解析失败自动降级为 JSON 回退或纯叙事。这是整个项目最精巧的设计——**LLM 负责创作，代码负责状态，两者通过受控协议解耦**。

**为什么好**：
1. 不强制模型输出严格 JSON（弱模型也能用标签），但保留 JSON 通道（强模型）；标签协议自带可读性，出错时可人工修复
2. 叙事与状态分离后，前端流式打字机可以直接渲染叙事，不用解析
3. 标签带数值上限校验（`LIMITS_BY_COMBAT_MODEL`），防止模型乱改数值

**代码位置**：

- GM 系统提示词（协议定义，逐标签说明）：`prompts/gm_system_zh.md:18-62`（"每轮回复末尾必须包含 --- 分隔符和状态标签"；无变化也要写 `---\nNONE`；MEMORY 标签每轮必填；QUICK_ACTIONS 每轮必填 2-4 个快捷行动选项）
- 标签协议解析（标签行 → 结构化 state_update/memory_delta/plot_update）：`src/commands/tag_parser.py:38-84`（`_extract_tag_lines` 只认 `---` 之后的内容，`NONE` 表示无变更）+ `src/commands/tag_handlers.py:15-36`（标签全集 `KNOWN_TAGS` 与分类 `PLAYER_TAGS/WORLD_TAGS/LOOT_TAGS/ACTION_TAGS`、数值上限表 `LIMITS_BY_COMBAT_MODEL:21-25`）
- 状态应用链：`src/commands/round_processor.py:171-203`（`apply_state_update` / `apply_confirmed_items` / `apply_puzzle_updates` / `apply_memory_delta` / `apply_plot_update` / `store_private_messages` 等，全部消费解析出的结构化数据）
- JSON 兜底解析 + 解析失败降级：`src/llm/parser.py:305-376`（`parse_llm_response`：取末尾 ```json 块 → 失败则裸 JSON → 失败则括号计数 → 失败则纯叙事 `is_narration_only`）
- LLM 常见 JSON 错误自动修复：`src/llm/parser.py:203-230`（`_repair_json`：补末尾引号/去尾逗号/补花括号/单引号转双引号/转义裸引号/去注释）
- 叙事净化（滤掉模型泄漏的内部上下文）：`src/llm/parser.py:126-174`（`sanitize_narration`）
- 流式推送时把 `---` 后的协议段拦下不推给前端：`src/commands/round_llm.py:39-97`（`_NarrationDeltaFilter`，处理分隔符跨 chunk 被拆开的问题）
- 解析失败的重试提示：`src/llm/parser.py:379-387`（`make_retry_message`）
- 解析连续失败的健康事件告警（streak ≥ 3）：`src/commands/round_llm.py:348-377`

### 4.3 骰子判定：服务端裁决 + 硬约束注入 + 矛盾重试

**是什么**：骰子由服务端代码掷出（绝不让 LLM 生成随机数），把裁决结果以【系统检定·必须遵循】块注入 prompt，LLM 只负责按结果叙事；若 LLM 叙事与裁决矛盾，自动重试一次。

**为什么好**：这是"让 AI 当 DM 又不失控"的关键——检定成败是游戏公平性的根基，必须走代码；但叙事必须由 LLM 完成，所以用"约束注入 + 校验 + 重试"三件套保证 LLM 叙事服从裁决。

**代码位置**：

- 纯代码掷骰：`src/engine/dice.py:23-49`（`roll`：d20/d100/2d6+1 等公式）、`dice.py:52-68`（`check_d20`：修正+DC 判定、大成功/大失败）、`dice.py:71-107`（`check_d20_advantage`：优势劣势）、`dice.py:110-144`（`check_d100` / `check_coc`：CoC 成功等级）、`dice.py:147-180`（`check_d100_bonus`：奖励/惩罚骰）
- 检定请求 → 玩家手动掷骰 → 骰值附加到行动（先掷骰后叙事，玩家只掷一次）：`src/engine/game_instance.py:430-463`（`apply_action_roll`，骰值以 `(系统掷骰: d20=14)` 行写入行动文本）
- 用已确认骰值结算检定、生成硬约束文本：`src/commands/dice_resolver.py:34-149`（`resolve_action_check`，输出 `【系统检定·必须遵循】\n检定: … vs DC …\n结果: …` 注入 prompt）
- 约束注入 actions_text：`src/commands/round_processor.py:139-142`（`build_dice_constraint_block`）
- 叙事与检定矛盾检测 + 重试：`src/commands/round_llm.py:233-324`（`call_llm_with_tag_retry`：矛盾时追加"⚠️ 上一轮回复与【系统检定·必须遵循】矛盾，请严格遵循检定结果重新叙述"再调用一次；`validate_dice_constraint` 见 `src/commands/round_helpers.py`）
- 战斗结算同理：`src/commands/combat_resolver.py`（服务端结算 HP 变化，`round_processor.py:144-150` 注入 `【系统战斗结算·必须遵循】`）

### 4.4 多人回合状态机（双人房间的核心骨架）

**是什么**：一局游戏是一个 `GameInstance` 内存对象，状态机在"行动阶段 ↔ 判定阶段"之间流转；行动阶段收集玩家行动，**所有存活且未暂离的玩家都提交后才自动推进**（或 GM 强制推进），判定阶段 LLM 生成叙事并应用状态，随后开启新一轮。

**为什么好**：这个状态机几乎可以直接套用到我们的"两位玩家各自做选择推进剧情"：`ready_players` 集合天然表达"双方都提交了"，`away_players` 解决"队友挂机"问题，`_process_lock` 防止回合并发处理。

**代码位置**：

- 状态枚举：`src/engine/game_instance.py:22-30`（GameState：CREATED/WAITING/ACTIVE_ACTION/ACTIVE_JUDGMENT/PUZZLE/PAUSED/ENDED）
- 推进条件：`src/engine/game_instance.py:261-266`（`all_alive_ready`：未暂离存活玩家 ⊆ ready_players）+ `game_instance.py:325-331`（`should_advance`：单人模式任一行动即推进）
- 原子推进（检查+推进同一锁内，消除竞态）：`src/engine/game_instance.py:496-514`（`try_advance` / `_do_advance_locked`）
- 行动提交（支持修改自己的行动、带骰子 pending、判定阶段提交则缓存到下一轮）：`src/engine/game_instance.py:346-414`（`add_action`）
- 暂离/回来：`src/engine/game_instance.py:478-489`（`set_player_away`）
- 每实例双锁：`src/engine/game_instance.py:212-215`（`_lock` 状态锁 + `_process_lock` 回合互斥锁）
- 多人状态对外视图（前端轮询/推送用）：`src/engine/game_instance.py:268-321`（`multiplayer_status`：ready_count/waiting_players/away_players/action_count…）
- 回合记录（每轮存 actions + gm_response + 状态快照 + check_results + swipes）：`src/engine/game_instance.py:516-538`（`finish_judgment`）

### 4.5 SSE 实时同步（替代 Socket.IO 的参考设计）

**是什么**：基于 SSE 的分用户实时推送：每个玩家一个持久连接，服务端 0.5s 轮询一次实例状态，变化时推送类型化事件（narration / private / state / public_actions / players / refresh / rollback），事件带游标（`r{round}.p{private_count}.a{action_digest}`）支持 Last-Event-ID 断线续传；流式叙事通过 `narration_delta` / `narration_reset` 事件逐段推送。

**为什么好**：它证明了"**不用 WebSocket 也能做多人实时跑团**"——SSE 天然支持自动重连和事件 ID 续传，比手写 Socket.IO 心跳简单可靠；`_play_public_signature` 签名比较法（对关键字段做 JSON 序列化比对，变了才推 refresh）是很省流量的做法。我们若坚持 Socket.IO 也建议沿用"事件游标 + 签名比对 + 断线重连"的思维。

**代码位置**：

- 分用户推送主循环：`src/webui/routes/sse.py:154-233`（`sse_play`：轮询比对 round/私聊数/行动签名/玩家数/公开签名）
- 游标编解码：`src/webui/routes/sse.py:255-266`（`_event_cursor` / `_parse_event_cursor`）
- 公开状态签名：`src/webui/routes/sse.py:236-252`（`_play_public_signature`）
- 连接池管理：`src/webui/connection_pool.py:14-49`（`ConnectionPool`：game_key → user_id → 连接集合，支持按用户定向推送）
- 流式叙事增量事件 + 行动提交流（提交即推送检查结果/叙事/recap）：`src/webui/routes/sse.py:67-151`（`sse_stream_action`）
- SSE 票据（订阅前换取临时票据）：`src/webui/routes/sse.py:19-29`（`api_sse_ticket`）+ `src/webui/sse_ticket.py`
- 前端订阅 + 断线兜底（30s 轮询 + 5s 重连）：`frontend-v2/src/composables/useGame.ts:142-172`（`connect`）

### 4.6 Token 预算硬分配的上下文拼接

**是什么**：按模型上下文窗口（保守估计，留 20% 余量）把上下文切成固定比例预算：系统提示 20% / 游戏状态 JSON 12% / 世界书 20% / 摘要 8% / 记忆 6% / 历史 ≥22%；先拼高优先级部分，最后把剩余预算全部给对话历史；历史再做三级压缩（最近 5 轮全量 + 关键轮次全量 + 其余 80 字摘要）。

**为什么好**：比"截断最旧消息"聪明得多——保证世界书/状态/摘要永远在场，只有历史会被压缩；关键轮次（战斗、购买、谜题、线索）识别让重要剧情不被挤掉。

**代码位置**：

- 预算比例与模型上下文检测表：`src/llm/context_builder.py:15-38`
- 中文 token 估算（CJK 1 token/字）：`src/llm/context_builder.py:53-56`
- 历史三级压缩：`src/llm/context_builder.py:81-137`（`_format_history`）+ 关键轮次识别 `context_builder.py:67-79`（`_is_key_round`：关键词命中 combat/gold/puzzle/clue 等）
- 完整拼接顺序：`src/llm/context_builder.py:140-269`（`build_context`：游戏状态 → 世界书 → 摘要+关键事实 → 已确认事项 → 记忆召回 → 对话历史 → 玩家发言）
- 状态 JSON 超预算时丢弃 inventory 保语法：`context_builder.py:182-187`

### 4.7 房间码机制（玩家凭码进房）

**是什么**：GM 设房间密码（`room_password`），玩家提交密码验证成功后由服务端颁发一次性的 `room_token`（`secrets.token_urlsafe(24)`）作为会话凭证；密码变更即撤销所有旧 token；GM 还能一键关闭 `player_access_open` 让分享链接全部失效。

**为什么好**：简单且安全——密码只用于"换凭证"，之后全靠凭证访问，`secrets.compare_digest` 防时序攻击；凭证失效机制天然支持踢人/改密。

**代码位置**：

- 字段定义：`src/engine/game_instance.py:145-147`（`room_password` / `room_token`）+ `game_instance.py:144`（`player_access_open`）
- 设密码/撤销旧 token：`src/webui/routes/games.py:162-175`（`api_set_room_password`）
- 密码验证 + 颁发凭证：`src/webui/routes/games.py:642-657`（`api_verify_room_password`，`secrets.compare_digest` 比较）
- 创建游戏时带密码：`src/webui/routes/games.py:287-313`（`api_create_game`）

### 4.8 长期记忆 + 摘要压缩（长团不丢设定）

**是什么**：两层记忆系统——①每轮 GM 输出 MEMORY 标签写入"实体-关系-值"三元组记忆库（SQLite），后续轮次用向量或文本召回注入上下文；②每 10 轮把对话历史压缩为"叙事摘要 + 关键事实列表"，滚动累积（旧摘要+新日志融合），且压缩在后台异步执行不阻塞玩家。

**为什么好**：MEMORY 标签强制 GM 每轮沉淀记忆（prompt 规定必填），比纯摘要更细粒度；三元组结构（entity/relation/value + confidence + status）让记忆可以增删改与遗忘；召回用"向量 + 实体/ngram 文本"合并互补。

**代码位置**：

- 记忆表结构：`src/memory/delta.py:14-35`（`memory_entries`：entity/relation/value/confidence/status/source_round/embedding）
- delta 应用与冲突消解：`src/memory/delta.py:101-131`（`apply_delta`：add/update/forget）+ `delta.py:133-150`（`_insert_or_update`）
- 召回（向量 + 文本合并）：`src/memory/recall.py:93-130`（`recall_best`）+ 实体提取/ngram 打分 `recall.py:15-70, 135-183`
- 摘要压缩：`src/memory/summarizer.py:112-114`（`needs_summary` 每 10 轮）+ `summarizer.py:117-158`（`summarize`：新旧摘要融合 prompt）；**后台异步调度**见 `src/commands/round_processor.py:94-113`（`_summarize_background` / `_maybe_schedule_summary`）
- MEMORY 标签注入位置：`src/llm/context_builder.py:232-249`（召回源 = 玩家消息 + 最近 3 轮 GM 回复）

### 4.9 LLM 客户端健壮性（多供应商 / 重试 / 截断放大）

**是什么**：自写 LLM 客户端：主供应商 + 任意个 fallback 供应商；429/5xx/超时按状态码退避重试；`finish_reason=length` 时抛 `OutputTruncatedError`，重试按 1×→2×→4× 放大 max_tokens；流式与非流式同一套解析管道，结果同构。

**为什么好**：这些细节决定了 AI 跑团的实际体验——输出被截断若当成功接收，会得到没有结尾的烂叙事；放大 max_tokens 重试是成本最低的兜底。我们接 OpenAI 兼容接口时值得照搬这套策略。

**代码位置**：

- 截断重试预算序列：`src/llm/client.py:20-32`（`length_retry_budgets`）
- 多供应商 fallback 主循环：`src/llm/client.py:108-202`（`call`）
- 流式实现（SSE 解析 + 截断检测）：`src/llm/client.py:428-509`（`_stream_openai_compatible`）
- OpenAI 兼容 + Anthropic 双协议切换：`client.py:287-296`（`_call_one` 按 `api_format` 分派）
- 回合内流式截断的 1×/2×/4× 重试：`src/commands/round_llm.py:191-230`（`_call_stream_with_length_retry`）

### 4.10 其他值得借鉴的小设计

| 设计 | 是什么 | 代码位置 |
|---|---|---|
| 信息不对称（私聊） | PRIVATE 标签 → `private_log` 按用户存 → SSE 只推给目标玩家 | `src/commands/tag_handlers.py:30`（PRIVATE 属于 WORLD_TAGS）、`src/engine/game_instance.py:148`（private_log 字段）、`src/webui/routes/sse.py:222-227`（私聊增量推送） |
| 已确认事项防重复讨论 | CONFIRMED 标签累积进 `confirmed_items`，再问相同内容时 prompt 指示直接推进 | `src/llm/context_builder.py:227-230`、`prompts/gm_system_zh.md:87-91` |
| 超长叙事二次压缩 | 叙事 >700 字时再调一次 LLM 压缩到 260/400 字（战斗场景放宽） | `src/commands/round_llm.py:100-159`（`_compress_long_narration`） |
| swipe 重生成 | 对历史轮重新生成候选叙事（≤5 个），配 `pre_state_snapshot` 状态回滚 | `src/commands/swipe_generator.py`、`src/engine/game_instance.py:33-67`（`_snapshot_players` / `restore_players`）、`game_instance.py:540-566`（`finish_judgment_with_swipe` / `switch_swipe`） |
| 规则数据驱动 | 规则模板 JSON + `extends` 继承 + 安全表达式求值（ast 白名单）；规则附 GM prompt 附录与难度指令 | `src/rules/rule_system.py:40-67`（模板继承解析）、`rule_system.py:70-104`（`_safe_eval`）、`src/commands/prompt_composer.py:74-99`（`load_rule_context` 把规则附录拼进 system prompt） |
| 存档原子写 + 崩溃恢复 | tmp → backup → rename 三步写；启动时扫描恢复所有未结束对局为 PAUSED | `src/engine/game_instance.py:921-934`（`GameRegistry.save`）、`game_instance.py:985-1013`（`recover_all`） |
| AI 辅助生成 | 世界/规则/角色/世界书条目都由模型生成草稿再人工修改 | `src/generation/creator.py` |
| 快捷行动选项 | 每轮 GM 必填 QUICK_ACTIONS 标签给玩家 2-4 个可选行动，降低新手门槛 | `prompts/gm_system_zh.md:49, 93-95` |
| 世界模板即"世界书包" | 一个 JSON 文件 = 世界设定 + 开场场景 + 默认规则 + 初始世界书条目，可一键建游戏 | `templates/worlds/default_fantasy.json` |
| GM 私密指令 | GM 可注入只给 LLM 看的剧情操控指令，不作为玩家行动记录 | `src/engine/game_instance.py:176`（gm_directives）、`src/commands/round_processor.py:155-157`（`collect_gm_directives_text`） |
| 属性修正自动计算 | `to_llm_view` 时把属性换算成修正值（`(v-10)//2`）与护甲值，LLM 无需自己算 | `src/engine/game_instance.py:715-795`（`to_llm_view`） |

---

## 5. 不值得借鉴的点

1. **整体代码语言**：后端是 Python/aiohttp，我们是 Node.js/Express，代码不能直接复用，只能移植设计。
2. **架构复杂度**：插件宿主（`src/plugin_host/`，6 万行）、QQ/NapCat Bot 适配（`src/bots/`）、自动更新器、健康事件系统——这些对"双人网页跑团"都是过度设计，借鉴时一律砍掉。
3. **多线程限制**：SQLite `check_same_thread=False` 仅限单线程 asyncio 环境（代码注释自述），存数据库连接用 `threading.Lock`/`asyncio.Lock` 混合，Node.js 侧不必照搬。
4. **访问控制偏弱**：WebUI 是全局 access_token 口令模式（`src/webui/access_password.py`），多人房间只靠房间密码+会话 cookie，没有用户账号体系——公开部署不安全，我们做管理员后台时应设计独立账号。
5. **测试/版本状态**：README 自述"接口、存档结构还会继续整理"，commit 历史显示功能迭代很快，不建议深度依赖它的 API 或存档格式。
6. **依赖了非通用模型能力**：`json_mode` 依赖 DeepSeek/OpenAI 的 `response_format: json_object`，部分兼容服务不支持，我们应把"标签协议 + JSON 回退"作为主路径（这恰是它的默认设计）。

---

## 6. 对我们「AI 双人跑团游戏」的具体借鉴建议

按实现优先级排列：

1. **世界书机制（首期必须）**：照搬 `src/lorebook/store.py:14-60` 的表字段（keywords/tier/match_mode/visible_to/unreliable/is_constant/sticky/cooldown/delay/probability/group）和 `src/lorebook/matcher.py:17-71` 的匹配流程（精确→AND/NOT→模糊回退→概率→分组→tier 排序）。起步阶段可以砍掉递归触发和时间效应，但要保留 `match_mode`、`tier`、`visible_to`（两位玩家各自可见的私密线索非常出彩）。管理员后台的"导入世界书"可以做成世界模板 JSON（`templates/worlds/default_fantasy.json` 的 `starter_lorebook` 结构）批量导入。

2. **GM 输出双通道协议（首期必须）**：prompt 要求 GM 输出 `叙事 + --- + 标签`（参考 `prompts/gm_system_zh.md:18-62`），后端实现 `src/llm/parser.py:305-376` 的解析（JSON 块优先 → 裸 JSON → 纯叙事降级）+ `src/commands/tag_parser.py:38-84` 的标签解析 + `src/llm/parser.py:203-230` 的 JSON 修复 + `sanitize_narration` 净化。我们的双人游戏甚至只需要 6-8 个标签：SCENE/NPC/LOOT/KEY_ITEM/PRIVATE/MEMORY/QUICK_ACTIONS/DECISION（COC 加 SAN）。

3. **回合状态机（首期必须）**：`ACTIVE_ACTION → ACTIVE_JUDGMENT` 循环（`src/engine/game_instance.py:22-30, 496-514`），用 `ready_players` 表达"双人各自提交选择后才推进"，`away_players` 解决挂机，`set_player_away`（`game_instance.py:478-489`）让单人也能继续。GM 强制推进 = `advance_round`（`game_instance.py:491-494`）。Node 侧用单房间一个对象 + 异步锁即可。

4. **骰子裁决（二期内）**：服务端掷骰 + 【系统检定·必须遵循】硬约束注入（`src/commands/dice_resolver.py:34-149` + `src/commands/round_llm.py:255-319` 的矛盾重试）。先实现 d20 检定即可，COC 的 d100 可后续加。

5. **SSE/Socket.IO 同步（二期内）**：借鉴 `src/webui/routes/sse.py:154-233` 的游标设计（`r{round}.p{private}.a{digest}`）+ `_play_public_signature` 签名比对（`sse.py:236-252`）+ 前端断线兜底（`frontend-v2/src/composables/useGame.ts:162-171`）。Socket.IO 里把 `Last-Event-ID` 换成客户端 lastRound 游标即可。

6. **Token 预算分配（二期内）**：照搬 `src/llm/context_builder.py:15-38` 的比例分配和 `context_builder.py:81-137` 的历史三级压缩（最近 N 轮全量 + 关键轮全量 + 其余截断），保证世界书和状态永远在场。

7. **记忆 + 摘要（后期）**：先做每 10 轮摘要压缩（`src/memory/summarizer.py`），MEMORY 标签三元组记忆库（`src/memory/delta.py:14-35`）视体验再上；embedding 召回（`src/memory/recall.py:93-130`）可最后再加，文本匹配在双人短团里通常够用。

8. **房间码（一期顺手做）**：`room_password` 验证换 `room_token` 凭证（`src/webui/routes/games.py:642-657`），管理员改密即撤销旧凭证（`games.py:162-175`），比"永久房间码"安全。

---

## 附：调研信息源

- 本地 clone 路径：`C:\Users\24730\AppData\Local\Temp\opencode\diceframe`（`git clone --depth 1`，v1.7.6 / 5ea48d0）
- 项目元数据来自 GitHub API（`api.github.com/repos/diceframe/diceframe`）：star 6、AGPL-3.0、最近推送 2026-07-30
- 本文所有 `文件路径:行号` 均经本地文件实际核对
