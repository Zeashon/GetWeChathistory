---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '319b0e16-e63f-429a-8cf4-50359754c176'
  PropagateID: '319b0e16-e63f-429a-8cf4-50359754c176'
  ReservedCode1: '0042543c-c473-4f51-a212-2d25266d2510'
  ReservedCode2: '0042543c-c473-4f51-a212-2d25266d2510'
---

# WeChat 4.x (NT架构) 技术参考

## 进程与路径

| 项目 | 值 |
|------|-----|
| 进程名 | `Weixin.exe`（非 `WeChat.exe`） |
| 核心DLL | `Weixin.dll`（非 `WeChatWin.dll`） |
| 架构 | NT（全新架构，不兼容3.x） |
| 数据根目录 | `xwechat_files/` |
| 账户目录 | `xwechat_files/<wxid>_<suffix>/` |
| 数据库目录 | `xwechat_files/<wxid>_<suffix>/db_storage/` |

数据根目录可能被自定义到任意盘符。默认路径不存在时的定位顺序：注册表 `HKCU:\Software\Tencent\Weixin`（仅 InstallPath）→ Weixin.exe 子进程命令行 `--app-path` → 各盘符浅层搜索 `xwechat_files`（`-Depth 3`，全盘深搜会超时）。

## 目录结构

```
db_storage/
├── contact/contact.db        # 联系人
├── message/message_0.db      # 消息（通常最大）
├── message/message_1.db      # 消息
├── session/session.db        # 会话列表
├── media_0.db                # 媒体
├── biz_message_0.db          # 业务消息
├── biz_message_1.db          # 业务消息
└── ... (共约20个.db文件)
```

## 数据库加密

- 加密方式: SQLCipher 4 (WCDB)
- 密钥: 64字符hex字符串
- **密钥不能直接用于 Python sqlcipher3** — WCDB 做了 per-database PBKDF2 密钥派生
- 必须通过 wcdb_api.dll 读取数据

## 密钥提取

WeFlow 使用 DLL 注入 Hook 方式:

1. `wx_key.dll` → 注入 Weixin.exe，Hook 密钥派生流程
2. `InitializeHook(pid)` → 启动Hook
3. `PollKeyData(buffer, 64)` → 120ms轮询，捕获密钥
4. 输出: 64字符hex字符串

**需要管理员权限**

⚠️ 当前验证：`wx_key.dll` 仅导出 `InitializeHook` / `PollKeyData` / `CleanupHook`，**无 `GetWeChatPid`**。请用 `scripts/extract_key_pid.py <PID>`（PID 外部传入）。主进程识别：父进程为 explorer.exe 且 MainWindowHandle ≠ 0 的 Weixin.exe；带 `--type=` 参数的均为子进程。

## WCDB API 函数签名

```c
int32 wcdb_init()
int32 wcdb_shutdown()
int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)
int32 wcdb_close_account(int64 handle)
int32 wcdb_set_my_wxid(int64 handle, const char* wxid)
void   wcdb_free_string(void* ptr)

int32 wcdb_get_sessions(int64 handle, _Out_ char** outJson)
int32 wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)
int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)
int32 wcdb_get_message_count(int64 handle, const char* username, _Out_ int32* outCount)
int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)
int32 wcdb_exec_query(int64 handle, const char* kind, const char* dbPath, const char* sql, _Out_ void** outJson)
```

## koffi 指针类型（关键！）

| 函数 | 输出参数类型 | 读取方式 |
|------|------------|---------|
| `wcdb_get_sessions` | `char**` | koffi 自动解码为 JS string |
| `wcdb_get_contact` | `void**` | `koffi.decode(ptr, 'char', -1)` |
| `wcdb_get_display_names` | `void**` | `koffi.decode(ptr, 'char', -1)` |
| `wcdb_get_messages` | `void**` | `koffi.decode(ptr, 'char', -1)` |
| `wcdb_exec_query` | `void**` | `koffi.decode(ptr, 'char', -1)` |

**用错指针类型会导致崩溃！**

## 消息字段映射

| 原始字段 (WCDB) | 映射字段 | 说明 |
|-----------------|---------|------|
| `computed_is_send` | `isSend` | 1=发出, 0=收到 |
| `create_time` | `createTime` | Unix时间戳(秒) |
| `message_content` | `content` | 消息文本 |
| `local_type` | `localType` | 消息类型 |
| `sender_username` | `senderUsername` | 发送者wxid |
| `local_id` | `localId` | 本地消息ID |

### local_type 消息类型

| 值 | 类型 |
|----|------|
| 1 | 文本 |
| 3 | 图片 |
| 34 | 语音 |
| 47 | 表情 |
| 49 | 应用消息(链接/小程序等) |
| 10000 | 系统消息 |

## contact.db 表结构

表 `contact` 主要字段:
- `username` (wxid)
- `alias` (微信号)
- `nick_name` (昵称)
- `remark` (备注)
- `local_type`
- `encrypt_username`
- `flag`, `delete_flag`, `verify_flag`
- `remark_quan_pin`, `remark_pin_yin_initial`
- `pin_yin_initial`, `quan_pin`
- `big_head_url`, `small_head_url`, `head_img_md5`

## 注意事项

1. `wcdb_open_account` 的 `path` 参数必须指向 `session.db` 的完整路径
2. `wcdb_exec_query` 有4个参数(handle, kind, dbPath, sql, outPtr)，不是3个
3. contact.db 有29000+联系人但会话只有约1000个，搜索联系人应直接查contact.db
4. `wcdb_get_messages` 返回扁平JSON数组（不是`{rows: [...]}`包裹）
5. wcdb_api.dll 有自毁过期机制，必须使用已修补的 `wcdb_api_patched.dll`

> AI生成