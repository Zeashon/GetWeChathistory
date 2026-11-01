# GetWe — 微信 4.x 聊天记录解密提取

在 Windows 本机提取微信 4.x（NT 架构）的聊天记录：从运行中的 Weixin.exe 提取数据库密钥，读取 SQLCipher 加密的 WCDB 数据库，输出标准化 JSON。

全程本机运行、只读原库、密钥不落盘。

## 功能特性

- 支持 **Weixin.exe 4.x**（NT 架构，不兼容 3.x 旧版）
- 密钥提取：DLL 注入 Hook 方式，无需手翻内存
- 数据读取：会话列表 / 联系人搜索 / 指定联系人全部消息 / 自定义 SQL
- 输出统一字段格式的 JSON，可直接接入下游分析流程
- 以 TeleAgent Skill 形态组织（SKILL.md 定义触发词与工作流），脚本亦可独立使用

## 实现思路

微信 4.x 将聊天数据存储在 `xwechat_files/<账号id>_<suffix>/db_storage/` 下的约 20 个 WCDB 数据库文件中，采用 SQLCipher 4 加密。

两个关键难点：

1. **密钥拿不到**：密钥存在进程内存中，仅在密钥派生时短暂出现；
2. **密钥用不了**：64 位 hex 密钥不能直接喂给 Python sqlcipher3——WCDB 对每个库做了 per-database PBKDF2 派生，必须走微信自身的 WCDB API 才能解开。

本工具的实现路径就围绕这两个难点展开：

### 第一步：密钥提取（`scripts/extract_key_pid.py` + `assets/wx_key.dll`）

- `wx_key.dll` 注入 Weixin.exe 主进程，Hook 密钥派生流程
- `InitializeHook(pid)` 启动 Hook，`PollKeyData` 以 120ms 轮询捕获 64 字符 hex 密钥，约 1–6 秒内完成
- 需要管理员权限、微信已登录并打开过聊天窗口
- 主进程识别：多个 Weixin.exe 并存时，取父进程为 explorer.exe 且 `MainWindowHandle ≠ 0` 的那个，带 `--type=` 参数的都是子进程，不能注入

### 第二步：数据读取（`scripts/read_data.js` + koffi + `assets/wcdb_api_patched.dll`）

- 通过 koffi FFI 调用 `wcdb_api_patched.dll`（逆向自 WeFlow 的 wcdbWorker，已修补过期自毁逻辑）
- 调用链：`wcdb_init` → `wcdb_open_account(session.db, 密钥)` → 各类读取 → `wcdb_close_account` → `wcdb_shutdown`
- 指针类型是最大的坑：`char**` 输出参数 koffi 会自动解码成 JS string；`void**` 必须用 `koffi.decode(ptr, 'char', -1)` 读取。用错类型直接进程崩溃

### 第三步：消息标准化（`extract-chat` 命令）

- 按 500 条/批分页拉取指定联系人的全部消息
- WCDB 原始字段映射为统一格式：

| WCDB 原始字段 | 统一字段 | 说明 |
|---|---|---|
| `computed_is_send` | `isSend` | 1=发出，0=收到 |
| `create_time` | `createTime` | Unix 时间戳（秒） |
| `message_content` | `content` | 消息文本 |
| `local_type` | `localType` | 1=文本 3=图片 34=语音 47=表情 49=应用 |
| `sender_username` | `senderUsername` | 发送者 wxid |

- 按信息优先级命名输出文件：备注名（remark）> 微信号（alias）> 昵称 > wxid

## 目录结构

```
getwe/
├── SKILL.md                     # 技能定义（TeleAgent 触发词、工作流、已知坑）
├── assets/
│   ├── wx_key.dll               # 密钥提取注入 DLL
│   ├── wcdb_api_patched.dll     # WCDB 读取 API（已修补过期自毁）
│   └── WCDB.dll
├── references/
│   └── wechat4x_tech.md         # 技术参考：函数签名、表结构、字段映射、坑位
└── scripts/
    ├── extract_key_pid.py       # 密钥提取（推荐）
    ├── extract_key.py           # 旧版脚本（依赖不存在的导出函数，勿用）
    ├── read_data.js             # 数据读取模块（koffi + WCDB API）
    ├── package.json
    └── package-lock.json
```

## 环境要求

- Windows，微信客户端 **Weixin.exe 4.x** 正在运行且已登录
- Node.js 18+：`cd getwe/scripts && npm install koffi`
- Python 3.9+（仅密钥提取步骤需要）
- 管理员权限（仅密钥提取步骤需要）

## 快速上手

```bash
# 1. 提取密钥（管理员 PowerShell）
python extract_key_pid.py <微信主进程PID>

# 2. 读取会话列表
node read_data.js sessions <db_storage路径> <密钥>

# 3. 搜索联系人
node read_data.js search-contact <db_storage路径> <密钥> "<关键词>"

# 4. 提取指定联系人全部聊天记录（输出到 .temp/getwe/）
node read_data.js extract-chat <db_storage路径> <密钥> <wxid>
```

数据目录默认在 `Documents\xwechat_files`，可被自定义到任意盘符；找不到时按注册表 `HKCU:\Software\Tencent\Weixin` → 子进程 `--app-path` 参数 → 各盘浅层搜索（`-Depth 3`）的顺序定位。

## 常见问题

| 问题 | 处理 |
|---|---|
| `GetWeChatPid` 函数不存在 | 正常，wx_key.dll 未导出该函数，使用 `extract_key_pid.py` 传入 PID |
| 密钥捕获超时 | 在微信中打开任意聊天窗口触发密钥派生后重跑 |
| `wcdb_open_account` 失败 | 确认路径指向 session.db、微信为 4.x、密钥完整（64 字符） |
| 进程崩溃 | 检查 koffi 指针类型用法，详见 `references/wechat4x_tech.md` |

## 安全与使用边界

- **本地处理**：所有操作在本机完成，不联网、不上传任何数据
- **只读**：不写、不改、不删微信原始数据库
- **密钥不持久化**：提取后仅在当前会话内存中使用，不落盘
- **使用范围**：仅限处理本人账户的聊天数据（如备份、回忆整理、个人分析），请勿用于获取他人数据或任何侵犯他人隐私的场景；使用本工具产生的一切后果由使用者自行承担

## 致谢

- 密钥注入思路与 WCDB 调用方式参考了开源项目 WeFlow 与 pywxdump
