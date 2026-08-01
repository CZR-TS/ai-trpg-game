# 世界书编写规范指南（Worldbook Authoring Guide）

> 本文档是 **ai-trpg-game 世界书的编写规范**，面向所有为本项目编写世界书的开发者/写手。
> 它综合了 **SillyTavern 官方 World Info 文档**的规范、本项目世界书引擎（`server/lorebook.js`）的**实际实现**，以及编写示例世界书《玄苍大世界》时踩过的坑。

---

## 1. 世界书是什么

世界书（Worldbook / Lorebook，酒馆里也称 World Info / 世界信息）是一份 **JSON 文件**，它不会一次性全部塞给 AI，而是：

- **常驻条目**（`constant: true`）每回合都注入；
- **关键词条目**：当最近的对话/剧情文本里**命中其触发词**时，才被注入；
- 被激活条目的正文还会被再次扫描（递归），形成"提到 A 就连带激活 B"的引用链。

它本质是一个**动态词典**：只把"当前剧情相关的设定"喂给 AI，让叙事与世界观保持一致。SillyTavern 官方强调：*世界书只负责把相关内容送进上下文，模型能否用好取决于模型本身。*

---

## 2. 引擎能力总览（本实现）

本项目引擎（`lorebook.js`）实现了 SillyTavern 世界书的**核心子集**。编写时请注意哪些字段真正生效：

| 字段 | 本引擎是否生效 | 说明 |
|---|---|---|
| `constant`（蓝圈） | ✅ | 常驻，无需关键词 |
| `key` / `keysecondary` + `selectiveLogic` | ✅ | 关键词触发与二次过滤 |
| `order` | ✅ | 排序 + 预算优先级（见 §5.5） |
| `probability` | ✅ | 触发概率（随机事件） |
| `group` / `groupWeight` | ✅ | 包含组：同组只注入一条（随机遭遇） |
| `disable` | ✅ | 关闭单条 |
| `recursive_scanning`（顶层） | ✅ | 是否递归激活 |
| `recursive_depth`（顶层） | ✅ | 递归扫描层数（默认 2） |
| `scan_depth`（顶层） | ✅ | 扫描最近 N 回合历史 |
| `token_budget`（顶层） | ✅ | 注入 token 上限 |
| `excludeRecursion` | ✅ | 不被其他条目递归激活 |
| `preventRecursion` | ✅ | 激活后不再触发其他条目 |
| `delayUntilRecursion` | ✅ | 仅递归阶段可激活 |
| `caseSensitive` / `matchWholeWords` | ✅ | 大小写 / 整词匹配 |
| `position` | ⚠️ 预留 | 本引擎统一注入，未按 0-6 分位置 |
| `vectorized` / 定时效果 / 角色过滤 | ❌ 未实现 | 预留字段 |

> 与 SillyTavern 不同：本引擎扫描文本由 `game.js` 构造，内容为「最近 `scan_depth` 回合的历史叙事 + 双方选择 + 上一轮总结」，不含发送者名字前缀。

---

## 3. 顶层结构

```json
{
  "name": "世界书名称",
  "description": "简介（不会进入 AI 上下文，仅作备忘）",
  "opening_background": "同一世界所有游戏共用的固定初始背景",
  "scan_depth": 6,
  "recursive_scanning": true,
  "recursive_depth": 2,
  "token_budget": 100000,
  "extensions": {},
  "entries": {
    "0": { "...": "条目" },
    "1": { "...": "条目" }
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | string | 文件名 | 世界书名称 |
| `description` | string | "" | 简介，不进 prompt |
| `opening_background` | string | 无 | **必填且不能为空**；开场直接展示的固定世界背景，不调用 AI 重复生成 |
| `scan_depth` | int \| null | 全局默认 | 扫描最近 N 回合找关键词；`0` 表示只扫递归内容 |
| `recursive_scanning` | bool | true | 是否允许条目互相递归激活 |
| `recursive_depth` | int | 2 | 递归扫描层数（越大引用链越深） |
| `token_budget` | int \| null | 全局默认 | 注入 token 上限；设为很大（如 100000）等于不限 |
| `extensions` | object | {} | 扩展字段，预留 |
| `entries` | object | — | **条目字典，键为 uid 的字符串**（必须，否则加载报错） |

### 固定开场背景的更新方式

1. 在 JSON 顶层维护 `opening_background`，不要把玩家姓名或某一局的角色经历写进去。
2. 同一世界的所有新房间都会直接展示这段背景，不会为每个房间重新请求 AI。
3. 玩家完成角色资料后，第一回合才由 AI 结合角色与世界书生成，因此角色部分可以随每局变化。
4. 修改背景后，重新导入世界书或随项目部署更新后的 JSON；已经进行中的房间继续使用开局时保存的背景。
5. `opening_background` 是强制字段；缺少或为空时，世界书会被拒绝导入和加载。

---

## 4. 条目（Entry）字段

```json
{
  "uid": 0,
  "comment": "标题·备注（不进 prompt）",
  "key": ["关键词A", "关键词B"],
  "keysecondary": ["次关键词"],
  "content": "【正文】被激活后注入的完整描述……",
  "constant": false,
  "order": 100,
  "disable": false,
  "probability": 100,
  "group": "",
  "groupWeight": 100,
  "selective": true,
  "selectiveLogic": 0,
  "caseSensitive": false,
  "matchWholeWords": false,
  "excludeRecursion": false,
  "preventRecursion": false,
  "delayUntilRecursion": false
}
```

### 必填三项
| 字段 | 说明 |
|---|---|
| `uid` | 条目唯一 id（整数，`entries` 的键必须与它一致） |
| `key` | 触发词数组。**数组中任一命中即触发**；每个元素为字符串 |
| `content` | **正文**，激活后注入。必须自包含、完整（见 §5.1） |

### 触发控制
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `constant` | bool | false | 常驻注入，无需关键词。**世界书总纲用这个** |
| `keysecondary` | string[] | [] | 次关键词，配合 `selectiveLogic` 做二次过滤 |
| `selectiveLogic` | int | 0 | `0`=AND ANY（主词命中且任一副词命中）/ `1`=NOT ALL / `2`=NOT ANY / `3`=AND ALL |
| `probability` | int | 100 | 命中后的注入概率（0-100）。**随机事件用这个** |
| `group` | string | "" | 包含组名：同组同时命中多条时，只随机注入一条 |
| `groupWeight` | int | 100 | 同组内的加权随机权重 |
| `disable` | bool | false | 关闭本条 |
| `delayUntilRecursion` | bool | false | 仅递归阶段可激活 |

### 排序与防爆
| 字段 | 说明 |
|---|---|
| `order` | 排序权重：**数值越大越靠近注入文本末尾，对 AI 影响越大**；预算不足时优先保留大 order 的条目 |
| `excludeRecursion` | 不被其他条目递归激活。**常驻总纲建议开启**（防止它当"引爆器"） |
| `preventRecursion` | 本条激活后，其正文不再参与递归扫描。**信息密集的主线/总纲类建议开启** |

### 匹配细节
| 字段 | 说明 |
|---|---|
| `caseSensitive` | 关键词大小写敏感（中文一般保持 false） |
| `matchWholeWords` | 整词匹配。**中文/日文必须 false**（无空格分词，SillyTavern 官方明确建议关闭） |

---

## 5. 触发机制详解（必须理解）

每回合引擎执行：

1. **扫描文本** = 最近 `scan_depth` 回合的叙事 + 双方选择 + 上一轮总结。
2. **首轮扫描**（depth 0）：
   - `constant: true` 条目直接激活；
   - 其他条目：任一 `key` 命中 → 用 `keysecondary` + `selectiveLogic` 过滤 → 过 `probability` 概率检定 → 加入候选。
3. **递归扫描**（depth 1..`recursive_depth`）：把已激活条目的 `content` 拼进扫描文本，**再扫一遍**（`excludeRecursion` / `preventRecursion` / `constant` 的内容不参与）。这让你可以"提到圣剑就带出教廷，提到教廷又带出大主教"。
4. **分组**：同 `group` 的候选按 `groupWeight` 加权随机只保留一条。
5. **排序与预算**：按 `order` 升序输出；预算不足时**优先保留 order 大（影响大）的条目**。

> 本引擎预算逻辑已按官方语义修正：**常驻先注入，其次 order 大的优先**，且直接关键词命中的条目优先于递归命中的。预算若设得足够大（本项目示例为 100000），几乎等于全量注入——**适合使用长上下文模型的场景**。

---

## 6. 编写规范与要求

### 6.1 Content 必须自包含（官方 Pro Tips 第 1 条）
`key`、`comment` **不会进入 AI 上下文**，所以 `content` 必须是完整、独立的描述，不能写成"见上一条"。每个被注入的条目，AI 都应该只靠它自己就能读懂。

✅ 好写法：
```
【圣剑·黎明之刃】光明教廷的至高圣物，剑身流转金光……被封存在教廷深处。
```
❌ 坏写法：
```
就是上面提到的那把剑（AI 看不到"上面"）。
```

### 6.2 关键词治理：拒绝单字与泛化词（本项目踩过的最大坑）
中文对话里"妖""鬼""海""剑""丹""月""梦""符"这类**单字**和"关系""势力""修炼"这类**泛化双字**出现频率极高，会无差别触发条目，造成：
- 无关条目反复注入，稀释真正的剧情焦点；
- 开局空文本都可能触发几十条。

要求：
1. **优先用 2-4 字的名词短语**作关键词：`"万妖谷"` 优于 `"妖"`，`"九尾天狐"` 优于 `"狐"`。
2. 单字词必须删除，改用更长别名或短语覆盖。
3. 关键词应选"玩家和 DM 在剧情中**最可能说出的自然表达**"，而不是书目索引词。
4. 若某词必须保留但嫌它太泛，用 `keysecondary` 限定语境（见 6.5）。

### 6.3 善用递归，但给总纲"上锁"
递归是构建丰富世界观的核心手段（A 提到 B 的关键词，B 就跟着激活）。但**信息密集的条目（世界总纲、历史、主线）正文里塞满关键词**，会在递归时成为"引爆器"，一次激活几十条。

要求：
- 常驻总纲条目加 `"excludeRecursion": true`；
- 主线/结局/时代背景等"总览型"条目加 `"preventRecursion": true`；
- 用顶层 `recursive_depth` 控制引用链深度：2 层一般足够，3 层以上谨慎。

### 6.4 随机事件 = 宽泛锚词 + 低概率 + 记录（官方用法）
官方对 `probability` 的定位就是随机事件：*「每条消息有 1% 机会唤醒上古之神（如果它的名字被提及）」*。
- **关键**：概率事件必须**先有关键词命中**才掷骰。所以别用玩家永远说不出口的词（"流星""血月"），要补 1-2 个**情境锚词**（如"夜空""月夜""异动""传闻"），让它在相关情境下有机会掷骰。
- 概率调成 5-15%（低概率=稀有彩蛋）。
- 另外建议在 DM 角色卡 `system_prompt` 里写明「约每 8-12 回合自行掷骰引入一条随机事件」，双保险。

### 6.5 用 keysecondary 消歧
当主关键词会命中"太宽"时，用 `keysecondary` + `selectiveLogic=0`（AND ANY）限定语境。
例：`key:["秘境","机缘"]` + `keysecondary:["开启","出世","现"]` → 只有提到"秘境**开启**"这类语境才触发，单纯说"机缘"不触发。

### 6.6 用 group 做"随机遭遇"
把多条互斥的遭遇放进同一 `group`，同组命中时只随机注入一条：
```
"group": "road_encounter", "groupWeight": 100
```
适合：路遇劫匪/商队/受伤修士/孤女 四选一；森林遭遇 四选一。用 `groupWeight` 调稀有度。

### 6.7 中文必须关整词匹配
`"matchWholeWords": false`（默认已是 false），否则"剑"无法匹配"宝剑""剑气"。

### 6.8 order 语义与预算
- `order` 越大越靠近末尾、影响越大，预算紧张时**优先保留**。
- 建议：常驻总纲 `order` 10-30，核心设定 100，背景杂项 150-250。
- 长上下文模型（本项目目标）直接把 `token_budget` 设成 100000，无需裁剪。

### 6.9 内容风格
- 正文建议以 `【类型·名称】` 开头（如 `【势力·太虚剑宗】`），方便 AI 识别这是设定卡片。
- 每条 100-300 字，信息密度高、无废话。
- 地名/人名/法宝名在 `content` 里要**与关键词一致**，否则递归链断掉。

---

## 7. 编写流程建议

1. **先搭骨架**：世界总纲（constant）→ 大陆/地理 → 修炼体系 → 种族 → 势力 → 重要人物 → 宝物/丹药/功法/灵兽 → 秘境 → 随机事件 → 概率事件。
2. **定基调**：明确世界核心冲突（如"天道残缺 + 魔渊将开"），让它贯穿所有条目。
3. **条目互相引用**：写 A 时在正文里"埋" B 的关键词，形成递归链。
4. **验证**：用 `server/lorebook.js` 的 `activateEntries` 跑几个真实场景（开场、进城、进秘境），检查：
   - 开场只激活常驻；
   - 提到"坠仙谷"时相关条目进入，无关条目可控；
   - 单字词没有引发大面积误触发。
5. **配 DM 角色卡**：`dm_character.json` 的 `system_prompt` 要告诉模型输出格式、叙事风格、何时主动引入随机事件。

---

## 8. 常见错误清单

| 错误 | 后果 | 修正 |
|---|---|---|
| key 用单字（"妖""剑""海"） | 全场景误触发 | 改 2-4 字短语 |
| content 不完整（"见上文"） | AI 读不懂设定 | 每条自包含 |
| 总纲塞满关键词且不加锁 | 递归爆炸，开局激活几十条 | 加 `excludeRecursion` / `preventRecursion` |
| 概率事件用死词当 key | 永远不触发 | 补情境锚词 + DM 卡指示 |
| 中文开 `matchWholeWords` | 关键词匹配失败 | 关闭 |
| 同组条目没设 `group` | 多条随机遭遇同时注入，矛盾 | 归入同一 group |
| 设定前后矛盾（碎片数量、人物时间线） | AI 叙事混乱 | 写前先列"设定一致性清单" |

---

## 9. 模板

可参考 `worldbook/template.json`（空模板）与 `worldbook/examples/xuanhuan-example/worldbook.json`（完整示例，202 条，覆盖全部机制用法）。
