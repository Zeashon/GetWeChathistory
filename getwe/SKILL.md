---
name: getwe
description: "微信4.x(NT架构)聊天记录解密提取。使用DLL注入Hook提取密钥，通过koffi+wcdb_api读取SQLCipher加密数据库，提取聊天记录输出为标准JSON。当用户提到'微信4.x聊天记录'、'导出微信记录'、'解密微信数据库'、'提取聊天记录'时触发。分析人格请使用WeMSG技能。支持Weixin.exe 4.x（NT架构），不兼容3.x旧版。"
name_cn: GetWe
description_cn: 微信4.x聊天记录解密提取
create_source: super-agent-skill-creator
---

# GetWe — 微信4.x 聊天记录解密提取

适配 **Weixin.exe 4.x（NT架构）**，不兼容3.x旧版微信。

本技能只负责获取数据（步骤1），分析和人格报告由 **WeMSG技能** 完成（步骤2）。

## 前提条件

- Windows PC 微信客户端 **Weixin.exe 4.x** 正在运行且已登录
- Node.js 18+ + npm（安装 `koffi` 依赖：`npm install koffi`）
- Python 3.9+ 环境
- Python 依赖：`pandas`, `matplotlib`, `jieba`, `wordcloud`
- **管理员权限**（仅密钥提取步骤需要）

## 工作流决策树

```
用户请求
├─ 解密/提取聊天记录 → 步骤1（密钥提取）→ 步骤2（数据读取）→ 步骤4（消息解析）
├─ 分析聊天数据 → 步骤2+4 → 步骤5（分析+可视化）
├─ 人格分析报告 → 步骤1→2→4→5→6（AI人格分析）→7（报告生成）
└─ 综合全流程 → 步骤1→2→3→4→5→6→7
```

## 步骤1：密钥提取

使用 `wx_key.dll` DLL注入Hook方式从 Weixin.exe 提取64字符hex密钥。

**必须以管理员权限运行！**

```python
# 方法A: 使用提取脚本
python scripts/extract_key_pid.py <微信主进程PID>
# ⚠️ 旧 extract_key.py 调用 wx_key.dll 中不存在的 GetWeChatPid，会报
#    "DLL导出函数不存在: function 'GetWeChatPid' not found"，已废弃
# 输出: 64字符hex密钥

# 方法B: 手动调用
import ctypes
wx_key = ctypes.CDLL('assets/wx_key.dll')
pid = <微信主进程PID>          # 获取微信PID
wx_key.InitializeHook(pid)            # 注入Hook
buf = ctypes.create_string_buffer(65)
wx_key.PollKeyData(buf, 64)           # 轮询密钥
key = buf.value.decode('ascii')       # 64字符hex密钥
```

**关键点**：
- 密钥提取需要微信正在运行且已登录
- `PollKeyData` 需要约1-6秒轮询，微信需要触发密钥派生（打开聊天窗口）
- 密钥为64字符hex字符串，**不能**直接用于 Python sqlcipher3
- 如果提取失败，确认微信版本是4.x（Weixin.exe而非WeChat.exe）

## 步骤2：数据读取

使用 Node.js + koffi + `wcdb_api_patched.dll` 读取加密数据库。

```bash
# 安装依赖
cd scripts && npm install koffi

# 读取会话列表
node read_data.js sessions "E:\...\db_storage" "<64hex_key>"

# 搜索联系人
node read_data.js search-contact "E:\...\db_storage" "<64hex_key>" "关键词"

# 提取指定联系人的全部聊天记录（默认保存到 .temp/getwe/）
node read_data.js extract-chat "E:\...\db_storage" "<64hex_key>" "wxid_xxx"

# 指定输出路径
node read_data.js extract-chat "E:\...\db_storage" "<64hex_key>" "wxid_xxx" --output path/to/output.json

# 自定义SQL查询
node read_data.js exec-query "E:\...\db_storage" "<64hex_key>" contact "contact/contact.db" "SELECT * FROM contact WHERE alias LIKE '%keyword%'"
```

**WCDB API 核心调用流程**：
1. `wcdb_init()` → 初始化
2. `wcdb_open_account(session.db路径, hex密钥, &handle)` → 打开账户
3. 各种读取操作（sessions/contact/messages/exec_query）
4. `wcdb_close_account(handle)` → 关闭
5. `wcdb_shutdown()` → 清理

**⚠️ koffi 指针类型极其关键**，用错会导致崩溃：

| 函数 | 输出参数 | JavaScript读取方式 |
|------|---------|-------------------|
| `wcdb_get_sessions` | `char**` | 自动解码为JS string |
| `wcdb_get_contact` | `void**` | `koffi.decode(ptr, 'char', -1)` |
| `wcdb_get_messages` | `void**` | `koffi.decode(ptr, 'char', -1)` |
| `wcdb_exec_query` | `void**` | `koffi.decode(ptr, 'char', -1)` |

## 步骤3：保存位置与命名规则

所有中间产物保存到 `{工作目录}/.temp/getwe/`，最终报告保存到 `{工作目录}`。

**文件命名**：优先用备注名（remark），其次微信号（alias），最后昵称（nickName），非法字符替换为`_`，截断50字符。

```
{工作目录}/
├── .temp/getwe/                           # 中间产物目录
│   ├── 张三_messages.json                 # 提取的原始消息
│   ├── 张三_features.json                 # 程序化特征
│   ├── 张三_personality.json              # AI人格分析结果
│   └── 张三_report/                       # 报告目录
│       ├── 张三_personality_report.html   # 最终HTML报告
│       ├── report.css
│       └── charts/                         # 图表
│           ├── hourly.png
│           ├── monthly_trend.png
│           ├── weekday_bar.png
│           ├── length_dist.png
│           ├── word_cloud.png
│           ├── radar.png
│           └── heatmap_data.json
└── 张三_personality_report.html            # 最终交付（从report/复制）
```

**命名示例**：

| 联系人信息 | 文件名前缀 |
|-----------|-----------|
| remark=张三 | `张三_` |
| alias=zhangsan01（无remark） | `zhangsan01_` |
| nick_name=zhangsan（无remark无alias） | `zhangsan_` |
| 仅wxid=wxid_abc123 | `wxid_abc123_` |

## 步骤4：消息字段映射

WeChat 4.x WCDB 原始字段 → 统一字段名：

| WCDB原始 | 映射后 | 说明 |
|----------|--------|------|
| `computed_is_send` | `isSend` | 1=发出, 0=收到 |
| `create_time` | `createTime` | Unix时间戳(秒) |
| `message_content` | `content` | 消息文本 |
| `local_type` | `localType` | 1=文本 3=图片 34=语音 47=表情 49=应用 |

read_data.js 的 `extract-chat` 命令已自动完成映射。

## 步骤5：多维度分析 + 可视化

使用 matplotlib + jieba + wordcloud 生成OKLCH棕白风格图表：

- 24小时活跃分布 (hourly.png)
- 月度消息趋势 (monthly_trend.png)
- 星期分布 (weekday_bar.png)
- 消息长度分布 (length_dist.png)
- 词云 (word_cloud.png)
- Big5人格雷达图 (radar.png)
- 年度热力图数据 (heatmap_data.json，由HTML/JS渲染)

颜色系统：按 `BRAND` 字典使用 OKLCH 棕白色系。

## 步骤6：AI人格分析

两阶段架构（与WeMSG v2.0一致）：

**阶段一**：程序化特征提取（11个量化指标）
- opinion_rate / positive_emotion / negative_emotion / planning_rate
- certainty_high / certainty_low / question_rate / social_rate
- first_person_rate / avg_length / sample_count

**阶段二**：Agent调用大模型生成结构化JSON
- Big Five: 5维度 × (score + level + evidence + note)
- MBTI: 4字母类型 + 置信度 + 4维度(lean/strength/reason)
- Style: 一句话画像 + 总结 + 特点 + 趣味发现

复用 WeMSG 技能的 `personality.py` 模块，或由Agent直接将采样消息发送给大模型，解析返回JSON。

## 步骤7：HTML报告生成

使用 OKLCH 棕白设计系统生成完整HTML报告：
- 棕白品牌色(self)：#4A3020 → #B8956A → #F0E8DA
- 青绿对比色(partner)：#2E5048 → #5A9B93 → #D8EDEA
- 宋体标题 + 系统无衬线正文
- GitHub风格年度热力图（年份切换）
- 响应式布局

报告包含8个板块：数据概况、消息行为分析、聊天频率热力图、高频词云、Big5人格分析、MBTI推断、AI总结、可靠性说明。

## 已知坑与修复（当前版本验证）

### 1. wx_key.dll 导出函数与旧脚本不匹配
实测 `assets/wx_key.dll` 仅导出 `InitializeHook`、`PollKeyData`、`CleanupHook`，**不导出 `GetWeChatPid`**，旧 `extract_key.py` 因此必然失败（报 `DLL导出函数不存在: function 'GetWeChatPid' not found`）。
- **修复**：改用 `scripts/extract_key_pid.py <微信主进程PID>`，PID 由外部传入
- **微信主进程识别**（多个 Weixin.exe 并存时）：主进程 = 父进程为 `explorer.exe` 且 `MainWindowHandle ≠ 0` 的那个；带 `--type=wxocr/wxutility/wxpublic` 等参数的都是子进程，不能注入
- **验证 DLL 实际导出**（无 dumpbin/pefile 时，读字节搜 ASCII 函数名）：
```powershell
$ascii=[System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($dll))
[regex]::Matches($ascii,'[\x20-\x7e]{5,}') | ForEach-Object {$_.Value} | Where-Object {$_ -match 'Hook|Key|Pid|Initialize|Poll'} | Select-Object -Unique
```

### 2. db_storage 不在默认路径时的定位
默认 `Documents\xwechat_files` 可能不存在（数据目录可被自定义到任意盘符）。定位顺序：
1. 注册表 `HKCU:\Software\Tencent\Weixin` 查 `InstallPath`（只有安装路径，无数据路径）
2. 查 Weixin.exe 子进程命令行的 `--app-path`（暴露 `AppData\Roaming\Tencent\xwechat`，但 db_storage 通常**不**在此）
3. 各盘符根做**浅层**递归搜索：`Get-ChildItem -Path <盘符>\ -Directory -Filter "xwechat_files" -Recurse -Depth 3`
- 账号目录形如 `<wxid>_<suffix>`，其下 `db_storage/` 含 contact/session/message 等子库
- 3.x 旧版目录 `Documents\WeChat Files\<wxid>` 与 4.x 无关，勿混淆

### 3. 会话无管理员权限时的协作流程
密钥提取（DLL注入）必须管理员权限。会话非管理员（IsAdmin=False）时：
1. **不要**尝试自行提权或注入；把完整命令（脚本绝对路径 + PID）写给用户，请其在管理员 PowerShell 中运行
2. 用户把输出的 64 位 hex 密钥粘贴回来，继续步骤2
3. 用户侧报"密钥捕获超时"：让其在微信中打开任意聊天窗口触发密钥派生后重跑

### 4. PowerShell 坑
- `Where-Object {...} -First N` 不存在（Where-Object 无 `-First` 参数），应 `... | Select-Object -First N`
- 对用户目录全量 `-Recurse` 搜索会超时（工具 120s 上限），必须限 `-Depth` 或限定子目录

## 技术细节与陷阱

详细技术参考见 `references/wechat4x_tech.md`，包括：
- 完整函数签名与koffi映射
- contact.db 表结构
- wcdb_exec_query 的4参数签名（非3参数！）
- wcdb_api.dll 过期自毁机制说明

## 安全约束

- **全程本地处理**：所有操作在用户本机完成，不上传任何数据
- **只读操作**：不修改微信原始数据库文件
- **密钥不持久化**：提取后不在本地持久保存密钥

## 下游衔接

GetWe 只负责获取数据（步骤1），分析和报告由 **WeMSG技能** 完成（步骤2）。

数据接口：`extract-chat` 输出的标准JSON，WeMSG 可直接读取。
完整流程：GetWe获取 → `.temp/getwe/{联系人名}_messages.json` → WeMSG分析+报告。
