# 世界书（Worldbook）格式说明

> **编写世界书前请先阅读 [GUIDE.md](./GUIDE.md)（编写规范指南）**：它包含字段要求、触发机制、关键词治理、递归防爆、随机事件与 group 用法等编写规范。

本项目的条目结构**兼容 SillyTavern（酒馆）的世界书 JSON 格式**，但本项目额外强制要求顶层 `opening_background`。酒馆导出的文件若没有该字段，补充固定开场背景后才能导入。

## 顶层结构

```json
{
  "name": "世界书名称",
  "description": "可选描述",
  "opening_background": "同一世界所有游戏共用的固定初始背景",
  "scan_depth": null,
  "token_budget": null,
  "recursive_scanning": false,
  "extensions": {},
  "entries": {
    "0": { "...": "条目" },
    "1": { "...": "条目" }
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | 世界书名称 |
| description | string | 描述（不进 prompt） |
| opening_background | string | **必填且不能为空**；固定初始背景，开场直接展示，不调用 AI 重复生成 |
| scan_depth | int\|null | 扫描最近 N 条消息找关键词；null=用全局默认 |
| token_budget | int\|null | 世界书占用 token 上限；null=用全局默认 |
| recursive_scanning | bool | 是否允许条目互相递归激活 |
| entries | object | 条目字典，键为条目 uid（字符串） |

## 固定背景与角色生成

- `opening_background` 是同一个世界始终一致的开场背景，创建房间后直接读取并展示。
- 所有世界书都必须填写非空的 `opening_background`；缺少该字段的文件不能导入或加载。
- 玩家在背景页完成角色资料后，AI 才根据双方角色生成第一回合；固定背景不交给 AI 重新改写。
- 更新世界背景时，直接修改 JSON 顶层的 `opening_background`，再重新导入或部署该世界书。
- `opening_background` 只负责玩家最开始看到的固定介绍；后续世界设定仍由 `constant` 条目和关键词条目注入 AI。
- 建议用 4-6 个自然段、至少约 500 个中文字符，覆盖主要地理、社会/种族、力量体系、重要历史、主要势力、当前危机和普通人的生存处境；不写某一局角色经历、隐藏真相或后台状态。
- 可以用 `\n\n` 分段并用 `**重点文字**` 少量强调专有名词。完整要求见 [GUIDE.md](./GUIDE.md#固定开场背景的内容要求)。

## 配套DM角色卡与通用叙事要求

- 创建新世界时，同时复制 [`dm_character.template.json`](./dm_character.template.json) 作为配套角色卡，只填写本世界特有的题材风格、规则和随机事件策略。
- 所有世界统一继承项目全局系统提示词：`narrative` 通常为 3-5 段、约 450-800 个中文字符；`summary` 通常为 3-4 段、约 300-550 个中文字符。
- 玩家正文只能包含角色可以感知或推断的故事内容。“互信建立、目标更新、探索方向、内部状态、幕后规划”等系统结论只能进入 `story_state/shared/flags`，不能直接写给玩家。
- 世界专属 `system_prompt` 不得覆盖或削弱上述通用要求。详细边界与示例见 [GUIDE.md](./GUIDE.md#系统提示词与玩家正文边界所有世界通用)。

## 条目（Entry）字段

| 字段 | 类型 | 默认 | 说明 | MVP |
|---|---|---|---|:--:|
| uid | int | — | 条目唯一 id | ✅ |
| key | string[] | — | **主关键词**（触发词，数组；每个元素可逗号分隔多个词） | ✅ |
| keysecondary | (string\|null)[] | [] | **次关键词**，配合 selectiveLogic 做过滤 | ✅ |
| comment | string | "" | 标题/备注（不进 prompt） | ✅ |
| content | string | — | **正文**，激活后注入 prompt | ✅ |
| constant | bool | false | 🔵蓝圈：常驻注入（世界观总纲常用） | ✅ |
| order | int | 100 | 插入顺序，数字越大越靠近 prompt 末尾（影响越大） | ✅ |
| position | int | 0 | 插入位置（见下） | ✅ |
| disable | bool | false | 禁用此条目 | ✅ |
| probability | int | 100 | 触发概率(0-100)，用于随机事件 | ✅ |
| group | string | "" | 包含组名：同组只激活一条（随机选） | ✅ |
| groupWeight | int | 100 | 组内随机权重 | ✅ |
| selective | bool | true | 是否启用次关键词过滤 | ✅ |
| selectiveLogic | int | 0 | 0=AND ANY,1=NOT ALL,2=NOT ANY,3=AND ALL | ✅ |
| role | int\|null | null | 注入消息角色 0=system,1=user,2=assistant | ✅ |
| depth | int | 4 | position=4(@depth) 时插入深度 | ✅ |
| caseSensitive | bool\|null | null | 关键词大小写敏感 | ✅ |
| matchWholeWords | bool\|null | null | 整词匹配（中文建议关闭） | ✅ |
| vectorized | bool | false | 🔗向量相似度匹配 | ⏳ |
| excludeRecursion | bool | false | 不被其他条目递归激活 | ⏳ |
| preventRecursion | bool | false | 激活后不再触发其他条目 | ⏳ |
| delayUntilRecursion | bool | false | 仅递归阶段才可激活 | ⏳ |
| stickiness / cooldown / delay | int | 0 | 定时效果（持续/冷却/延迟消息数） | ⏳ |
| automationId | string | "" | 自动化 id（本项目暂不用） | ⏳ |

> ✅ = MVP 支持；⏳ = 预留字段，后续迭代。

### position 取值

| 值 | 含义 |
|---|---|
| 0 | 角色卡定义**之前**（before char defs） |
| 1 | 角色卡定义**之后**（after char defs，影响更大） |
| 2 | Author's Note 顶部 |
| 3 | Author's Note 底部 |
| 4 | @depth：插入到历史消息指定 depth 处 |
| 5 | 示例对话之前 |
| 6 | 示例对话之后 |

## 激活流程（每回合）

1. 收集**常驻**条目（constant=true）。
2. 扫描最近 `scan_depth` 条消息文本，匹配各条目 `key`。
3. 命中的条目按 `selectiveLogic` 用 `keysecondary` 过滤。
4. 通过 `probability` 概率检定。
5. 同 `group` 的条目只保留一条（按 groupWeight 随机 / 或优先级）。
6. （可选）`recursive_scanning` 时，被激活条目的 content 也会被扫描，递归激活其他条目。
7. 按 `order` 排序，在 `token_budget` 内注入对应 `position`。

## 编写建议

- **世界观总纲**用 `constant=true`（蓝圈），始终在场。
- **物品/地点/NPC** 用关键词触发，按需注入，省 token。
- 利用递归：A 条目 content 提到 B 条目的关键词，可链式激活。
- 中文世界书建议 `matchWholeWords=false`（中文无空格分词）。
- content 要**自包含、完整**，因为 key/comment 不进 prompt。

## 示例

见 `template.json`、`dm_character.template.json` 与 `examples/xuanhuan-example/worldbook.json`。
