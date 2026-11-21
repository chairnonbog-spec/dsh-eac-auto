# EAC Auto —— 安装说明

给使用 DeepSeek Harness 的其他客户端。

## 这是什么

一个插件,给模型选择器新增**一个**可选模型:**EAC AUTO**。

EAC AUTO 不是某个具体模型,而是一个**集合模型**:它每次对话自动从
`dsh-our-free-model` 提供的免费 EAC 模型里挑一个来回答;**某个模型报错时
自动切换到下一个**,所以配额墙、上游 5xx、超时都不会中断你这一轮。

## 前置条件

必须先安装并登录 **`dsh-our-free-model`**(EAC 通道由它提供)。
没有它,模型名单是空的,EAC AUTO 会明确报告"没有可用的 EAC 模型",
而不是假装可用。

## 安装

### 方式一:npm 包(推荐)

```bash
dsh plugin add dsh-eac-auto
```

或在 DSH 的 **插件** → **添加插件** 里填入包名 `dsh-eac-auto`。

### 方式二:本地 tgz

**插件** → **添加插件** → 选择对应的 `.tgz` 文件。

```bash
dsh plugin add /绝对路径/dsh-eac-auto-1.0.0.tgz
```

> tarball 路径必须是**绝对路径**,且以 `.tgz` 或 `.tar.gz` 结尾;相对路径会被拒绝。

### 方式三:手动放进 profile

把包安装或解包到 profile 的 `node_modules/dsh-eac-auto`,并在
profile 的 `package.json` 的 `dsh.profile.bundles` 里加上
`"dsh-eac-auto"`。

## 安装后

重启 DSH(或等待插件管理器应用变更),然后在**模型选择器**里就能看到
**EAC AUTO** 这一项,和 `Our Free Model` 并列。

## 可选配置

插件的每一行配置都在 profile 的 `cordis.patch.yml` 里:

```yaml
- id: eac-auto
  name: 'dsh-eac-auto'
  config:
    strategy: balanced          # balanced | speed | quality
    preferredModels: []         # 置顶的模型 id,按你的顺序
    excludedModels: []          # 完全排除的模型 id
    silenceTimeoutMs: 120000    # 候选模型静默多久算失败
    enabled: true               # 是否提供 EAC AUTO
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否提供 EAC AUTO |
| `strategy` | `balanced` | 切换顺序:`balanced` 按通道自己的顺序;`speed` 输出上限大的优先;`quality` 上下文大的优先 |
| `preferredModels` | `[]` | 置顶的模型 id |
| `excludedModels` | `[]` | 完全排除的模型 id |
| `silenceTimeoutMs` | `120000` | 候选模型静默多久算失败 |

所有值都由插件自己校验,写错会退回默认值,不会让这一行启动失败。

## 查看当前名单

插件暴露一个只读接口:

```bash
curl http://127.0.0.1:<端口>/api/eac-auto/status
```

返回当前名单(来源、模型列表)和最近一轮的尝试记录。刷新名单:

```bash
curl -X POST http://127.0.0.1:<端口>/api/eac-auto/refresh
```

## 设计要点(给二次开发者)

- 插件**不持有任何凭据、不开任何 socket、不说任何厂商协议**。真实请求由
  `dsh-our-free-model` 自己的适配器发出,本插件只做**选择**。
- 失败切换的可见性规则:候选模型在产出"答案级 delta"之前,它的所有输出
  都被缓冲;一旦它失败,整段丢弃,用户看不到任何残片。**推理(reasoning)
  片段不算提交** —— "想了一分钟才撞上配额墙"正是最该切换的场景。
- 一旦某个模型已经产出了答案,后续失败就结束这一轮,**不会**换个模型重写
  答案(否则 transcript 会对不上)。
- 名单来源是通道自己的适配器(`listModels`),并以通道的 `EAC ` 渠道标签
  区分 —— 免费通道的同名模型和 Kilo 通道的模型都不会混进来。
- 插件**零外部依赖**(只用 `node:` 内置模块),所以在别的机器上装不需要联网
  拉依赖,也不需要匹配宿主版本。

## 排查

| 现象 | 原因 |
|---|---|
| 模型选择器里没有 EAC AUTO | 插件没激活。看插件管理器的行状态;桌面端刚改完配置需要重启 |
| 选了 EAC AUTO 报"没有可用的 EAC 模型" | `dsh-our-free-model` 没装、没登录,或通道的名单是空的 |
| 某个模型总被跳过 | 把它加进 `excludedModels`;或者它本来就是通道侧标记为不可用的 |
| 一次对话里换了模型 | 这是设计行为。`/api/eac-auto/status` 的 `lastRun` 里有完整的尝试记录 |

## 许可

MIT。
