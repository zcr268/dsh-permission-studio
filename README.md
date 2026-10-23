<div align="center">

<img src="docs/banner.png" alt="dsh-permission-studio" width="100%" />

# dsh-permission-studio

**给 DSH 的权限档位工作室** —— 把「三个固定档位」变成任意多档、每档独立细配、会话内随时切换

分类 · 工具 · 命令 · 文件路径，四层收束，每一条拒绝都能告诉模型该怎么改

[![CI](https://github.com/zcr268/dsh-permission-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/zcr268/dsh-permission-studio/actions/workflows/ci.yml)
[![Release](https://github.com/zcr268/dsh-permission-studio/actions/workflows/release.yml/badge.svg)](https://github.com/zcr268/dsh-permission-studio/releases)
[![Version](https://img.shields.io/github/v/release/zcr268/dsh-permission-studio?color=B03A28)](https://github.com/zcr268/dsh-permission-studio/releases/latest)
[![Tests](https://img.shields.io/badge/tests-147%20passing-7D8A6E)](#开发)
[![License](https://img.shields.io/badge/license-MIT-A98056)](LICENSE)

[中文](README.md) · [English](README.en.md) · [更新日志](CHANGELOG.md)

</div>

---

## 这是什么

DSH（DeepSeek Harness）自带 `@deepseek-ai/dsh-permission-presets`，提供「任意多个权限档位」和会话内 `/permission` 切换。
但档位表只能手改 YAML，而且粒度只到**沙箱**（`read-only` / `workspace-write` / `danger-full-access`）。

这个插件补上两件事：

1. **一个能点的界面** —— 在 DSH 设置里增删改档位，保存即生效，不用重启
2. **更细的判定** —— 从「整个沙箱开或关」，细化到**哪一类操作、哪一个工具、哪一条命令、哪一个文件**

关键在于：**拒绝不是终点，而是一次说明**。每条规则都能写一句提示词，原样回给模型，
它就知道「这条路不通，换一条」——而不是撞墙重试。

<br />

<div align="center">
<img src="docs/screenshot-file-rules.png" alt="文件规则界面" width="88%" />
<br />
<sub>文件规则：同一个模式，读和写可以分别设为允许 / 询问 / 拒绝，拒绝时写自己的提示词</sub>
</div>

<br />

## 四层权限

| 层 | 管什么 | 典型用法 |
|---|---|---|
| **分类规则**（13 类） | 按操作类型批量决定 | 「执行命令一律询问」「读取区外文件一律拒绝」 |
| **逐工具覆盖** | 按工具名单独决定，可**剔除** | 「`bash` 从这个会话里彻底消失」 |
| **正则规则** | 按工具名 / 命令 / 路径 / 参数匹配 | 「`git push` 必须询问」「`rm -rf` 直接拒绝」 |
| **文件规则** | 按文件路径，读和写分别判定 | 「只准改 `docs/**`，`*.env` 一律拒绝」 |

四层从上到下依次检查，命中即定论；**层内多条同时命中时按「拒绝 > 询问 > 允许」取最严**。

<br />

<div align="center">
<img src="docs/architecture.png" alt="判定链" width="100%" />
</div>

<br />

## 能力

<table>
<tr><td width="50%" valign="top">

### 档位
- 任意多档，每档独立设置沙箱与审批策略
- 显示名、描述、是否设为默认
- 卡片可折叠，头部直接显示「拒绝 N · 询问 M · 共 13 类」
- 每档可选徽标，显示在设置页、原生下拉与档位触发器

### 分类规则
13 类操作，每类可设 **询问 / 允许 / 拒绝**：
执行命令 · 读取文件 · 查找文件 · 修改文件 · 读取区外文件 · 写入区外文件 ·
读取图片 · 联网访问 · 撤销操作 · 子代理 · 团队协作 · 其他工具 · 重复操作

</td><td width="50%" valign="top">

### 逐工具覆盖
工具清单来自运行时注册表（全局层 + 所有作用域层的并集），**不是写死的名字**。
每个工具可设为 **跟随分类 / 询问 / 允许 / 拒绝 / 剔除**。

**剔除**不是「调用时拒绝」——它用 DSH 的 `tools.restrict()` 把工具从这个会话的可见清单里真正移除，
模型连它的 schema 都收不到。切换档位时重新计算，先撤销旧限制再施加新的。

### 正则规则
按工具名、命令内容、路径或任意参数匹配，动作同样是三态，优先级高于分类与工具覆盖。

</td></tr>
</table>

### 文件规则：白名单与黑名单是同一件事

一条规则 = **路径模式 + 读动作 + 写动作 + 可选提示词**。

- 设成「允许」就是白名单，设成「拒绝」就是黑名单，不需要两套东西
- 读写独立判定，**写不隐含读**
- 「未列出的文件」单独一档策略：跟随分类规则（默认，不会把自己锁死）或一律拒绝（纯白名单）
- **列表为空时兜底依然生效**：空表 + 一律拒绝 = 全锁，理由会说明原因
- 界面上有「开启读取 / 开启写入」两个独立开关，缺读、缺写时各出一条提醒

### 备份与迁移

配置页底部有三个按钮：**导出备份 / 导入备份 / 保存全部**。

- 导出得到一个 JSON：全部档位（沙箱、审批、十三类规则、逐工具覆盖、正则规则、文件规则、图标、默认档位）一次带走
- 导出取的是**当前界面状态**，所以先把想改的改完再导出也没问题
- 导入会用它替换当前全部档位配置，内置三档始终保留；写入前会弹确认
- 备份带 `format` 与 `formatVersion`，导入别的 JSON、空文件、来自更高版本的备份都会被拒绝并说明原因

<br />

<div align="center">
<img src="docs/screenshot-tools.png" alt="工具清单" width="88%" />
<br />
<sub>逐工具覆盖：48 个工具动态发现，批量操作，可整条剔除</sub>
</div>

<br />

## 安装

### 装最新发布版（推荐）

```sh
dsh plugin --profile desktop add \
  https://github.com/zcr268/dsh-permission-studio/releases/latest/download/dsh-permission-studio.tgz
```

这个地址永远指向**最新发布版本**。它拿的是 Release 附件里的打包产物，
不是 `main` 分支上还没发布的提交——分支上可能有半成品，发布版不会。

### 锁定某个版本

```sh
dsh plugin --profile desktop add \
  https://github.com/zcr268/dsh-permission-studio/releases/download/v0.2.3/dsh-permission-studio.tgz
```

### 从源码装（开发用）

```sh
git clone https://github.com/zcr268/dsh-permission-studio.git
cd dsh-permission-studio
npm pack
dsh plugin --profile desktop add "$(pwd)/dsh-permission-studio-0.2.3.tgz"
```

装完重启 DSH，设置里出现 **权限档位** 一页。

### 在桌面版里点界面装

DSH 桌面版的 profile 由 Electron 独占，命令行改不了，要用界面装：

**设置 → 插件 → 添加插件**，在「包名或地址」里粘贴：

```
https://github.com/zcr268/dsh-permission-studio/releases/latest/download/dsh-permission-studio.tgz
```

这个地址是打包产物（`.tgz` 结尾），安装器会按 tarball 处理，拿到的就是最新发布版本。
**不要填仓库地址**（`https://github.com/zcr268/dsh-permission-studio`）——那会按 git 源安装，
装的是 `main` 分支当前代码，可能包含还没发布的提交。

> 把 `desktop` 换成你的 profile 名。查看有哪些 profile：`dsh profile list`

<br />

## 使用

**设置里配** → 设置 → 权限档位 → 展开任一档位

**会话里切** → `/permission`（不带参数列出全部档位）

```
/permission 只碰指定文件
```

切换当场生效，不用重启。徽标会跟着变，旧档位的图标不会留下来。

<br />

<div align="center">
<img src="docs/screenshot-native-dropdown.png" alt="原生下拉里的徽标" width="70%" />
<br />
<sub>徽标直接长在 DSH 原生下拉的图标位置上；内置档位保留自带图标，互不冲突</sub>
</div>

<br />

## 拒绝理由

每条拒绝都能说话。优先级是：

```
该项自己的理由  >  档位兜底理由  >  分类默认引导语
```

兜底理由是**判定时**解析的，不是保存时写死的——所以改一次兜底，
所有没单独填写的项立刻跟着变，不用逐条改。

模型收到的是一句可执行的引导，比如：

> 本档位只允许读写文件规则里列出的路径，`src/a.ts` 未被列出。
> 现有规则：`docs/**`(读:allow 写:allow)、`*.md`(读:allow 写:deny)；
> 未列出的文件按「一律拒绝」处理。请让用户调整文件规则，或切换到其它档位。

<br />

## 配置存在哪

| 内容 | 位置 |
|---|---|
| 档位表、默认档 | profile 的 `cordis.patch.yml`（DSH 原生配置，热重载） |
| 分类 / 工具 / 正则 / 文件规则、徽标 | `$DSH_HOME/permission-studio/config.json` |

分开存是有意的：细粒度规则的结构 DSH 不认识，塞进原生配置会触发 schema 校验失败。

<br />

## 工作方式

```
设置页 iframe ──POST──> /permission-studio/api ──> 写配置 ──> 热重载
                                                        │
会话每次工具调用 ── tools/pre-execute（global 钩子）──> decide()
        ├─ 1. 正则规则（deny > ask > allow）
        ├─ 2. 文件规则（三态，未列出按备用策略）
        ├─ 3. 逐工具覆盖（含剔除）
        ├─ 4. 区外读写拆分
        ├─ 5. 重复操作阈值
        └─ 6. 分类规则
```

- 判定 `deny` → 返回 `{ kind: 'deny', reason }`，reason 就是回给模型的话
- 判定 `ask` → 交回 DSH 原生审批，由该档位的审批策略决定是否弹窗
- 插件自身异常 → fail-safe 拒绝本次调用，不放行可疑操作

### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/permission-studio/` | 自包含管理页（HTML + CSS + JS 内联） |
| GET | `/permission-studio/api` | 档位表、默认档、工具清单、分类枚举 |
| POST | `/permission-studio/api` | 保存全部设置 |

<br />

## 开发

```sh
npm test          # 147 个回归用例
npm pack          # 打包
```

测试直接调用导出的纯函数（`decide` / `matchFileRule` / `globToRegExp` /
`planHiddenTools` / `syncHiddenTools` 等），不需要起服务，秒级跑完。

每个修过的 bug 都留下了对应的回归用例——包括几个不容易想到的：

- `restrict` 的限制是取交集累加的，切档不撤销就永远回不去
- 徽标只插不删，切到别的档位会和原生图标并排
- 兜底理由若在保存时物化，改兜底就影响不到已有条目
- 文件规则若把「有规则才生效」写成前提，空列表时兜底等于失效

<br />

## 兼容性

本插件声明对以下 DSH 宿主版本的兼容（`peerDependencies`）：

| 包 | 兼容区间 |
|---|---|
| `@deepseek-ai/cordis` | `>=4.0.2 <5.0.0` |
| `@deepseek-ai/dsh-client-ui-renderer` | `0.2.0-rc.1` · `0.2.0-rc.2` · `0.2.1-rc.1` · `0.2.1-rc.2` |
| `@deepseek-ai/dsh-client-ui-settings` | 同上 |
| `react` / `react-dom` | `^18.2.0` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

宿主自带的包（cordis、客户端 UI 包）在 profile 里不会被重复安装，
因此这些 peer 声明标为 `optional`——安装时不会报缺失警告，但版本区间仍是明确承诺。

已验证：在干净的 `0.2.1-rc.2` 宿主上安装并启动，服务自检
`permissionPresets=yes tools=yes sessions=yes`，设置页与接口均正常。

> 声明兼容不等于每个版本都做过完整实测。上表是支持范围，实际验证过的宿主版本见上方「已验证」。

## 已知边界

- **工具清单**反映当前进程里可见的工具。被 `tool_policy` 收窄的团队成员看到更少，但拒绝规则照样生效
- **文件规则**只认得工具参数里的路径。shell 里 `rm`、`sed -i` 这类命令拿不到可靠路径——
  要彻底收死，请把 `bash` 剔除或整类拒绝
- **徽标**是在原生下拉里插入装饰节点实现的（DSH 的图标按固定 id 写死）。
  DSH 若改版换了 DOM 结构，徽标可能不再显示——只是不显示，不影响功能
- **剔除**对当前轮的下一轮生效：工具清单在每轮开始时下发

<br />

## 许可

[MIT](LICENSE)

<div align="center">
<br />
<sub>为「让模型知道为什么不行」而写</sub>
</div>
