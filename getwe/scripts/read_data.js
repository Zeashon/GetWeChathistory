/**
 * GetWe — 微信4.x 数据读取模块
 * 使用 koffi + wcdb_api_patched.dll 读取加密数据库
 * 
 * 用法：node read_data.js <命令> [参数...]
 *   node read_data.js init <db_storage_path> <hex_key>
 *   node read_data.js sessions
 *   node read_data.js search-contact <keyword>
 *   node read_data.js get-contact <wxid>
 *   node read_data.js get-messages <wxid> [limit] [offset]
 *   node read_data.js get-message-count <wxid>
 *   node read_data.js exec-query <kind> <db_relative_path> <sql>
 *   node read_data.js shutdown
 * 
 * 单次执行模式：每条命令独立 init → 操作 → shutdown
 */
const koffi = require('koffi');
const path = require('path');
const fs = require('fs');

// ── DLL 路径 ──────────────────────────────────────────────────────────────────
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const WCDB_API_DLL = path.join(ASSETS_DIR, 'wcdb_api_patched.dll');

if (!fs.existsSync(WCDB_API_DLL)) {
  console.error(`错误: 找不到 wcdb_api_patched.dll: ${WCDB_API_DLL}`);
  process.exit(1);
}

// ── koffi 加载 ────────────────────────────────────────────────────────────────
const lib = koffi.load(WCDB_API_DLL);

// 函数签名 — 基于逆向 WeFlow wcdbWorker.js 确认
const wcdb_init          = lib.func('int32 __stdcall wcdb_init()');
const wcdb_shutdown      = lib.func('int32 __stdcall wcdb_shutdown()');
const wcdb_open_account  = lib.func('int32 __stdcall wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)');
const wcdb_close_account = lib.func('int32 __stdcall wcdb_close_account(int64 handle)');
const wcdb_set_my_wxid   = lib.func('int32 __stdcall wcdb_set_my_wxid(int64 handle, const char* wxid)');
const wcdb_free_string   = lib.func('void __stdcall wcdb_free_string(void* ptr)');

// char** 直接输出 → koffi 自动解码为 JS string
const wcdb_get_sessions  = lib.func('int32 __stdcall wcdb_get_sessions(int64 handle, _Out_ char** outJson)');
// void** 输出 → 需要 koffi.decode(ptr, 'char', -1)
const wcdb_get_contact   = lib.func('int32 __stdcall wcdb_get_contact(int64 handle, const char* username, _Out_ void** outJson)');
const wcdb_get_messages  = lib.func('int32 __stdcall wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)');
const wcdb_get_message_count = lib.func('int32 __stdcall wcdb_get_message_count(int64 handle, const char* username, _Out_ int32* outCount)');
const wcdb_get_display_names = lib.func('int32 __stdcall wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)');
// execQuery 有4个参数: handle, kind, dbPath, sql, outPtr
const wcdb_exec_query    = lib.func('int32 __stdcall wcdb_exec_query(int64 handle, const char* kind, const char* dbPath, const char* sql, _Out_ void** outJson)');

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 获取联系人显示名（用于文件命名）
 * 优先级：remark > alias > nickName > wxid
 */
function getContactName(contactInfo, fallbackWxid) {
  return contactInfo.remark || contactInfo.alias || contactInfo.nick_name || fallbackWxid || 'unknown';
}

/**
 * 清洗文件名：移除非法字符
 */
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').substring(0, 50);
}

/**
 * 获取默认输出目录：{cwd}/.temp/getwe/
 */
function getDefaultOutputDir() {
  return path.join(process.cwd(), '.temp', 'getwe');
}

/**
 * 构建默认输出文件路径
 * 规则：{cwd}/.temp/getwe/{联系人名}_messages.json
 */
function getDefaultOutputPath(contactInfo, wxid, suffix) {
  const name = sanitizeFilename(getContactName(contactInfo, wxid));
  const dir = getDefaultOutputDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}_${suffix}.json`);
}

/**
 * 读取 void** 输出参数为 JSON 字符串，然后释放
 * 注意：void** 通过 [null] 数组传递，outPtr[0] 是 koffi 指针
 */
function readVoidJson(ptr) {
  if (!ptr) return null;
  try {
    const str = koffi.decode(ptr, 'char', -1);
    try { wcdb_free_string(ptr); } catch(e) {}
    return str;
  } catch(e) {
    try { wcdb_free_string(ptr); } catch(e2) {}
    return null;
  }
}

/**
 * 读取 char** 输出参数为 JSON 字符串，然后释放
 */
function readCharJson(ptr) {
  if (!ptr) return null;
  // char** 被 koffi 直接解码为 string
  const str = ptr;
  return str;
}

/**
 * 打开数据库并返回 handle
 */
function openAccount(dbStoragePath, hexKey) {
  const sessionDbPath = path.join(dbStoragePath, 'session', 'session.db');
  if (!fs.existsSync(sessionDbPath)) {
    throw new Error(`session.db 不存在: ${sessionDbPath}`);
  }

  const initRet = wcdb_init();
  if (initRet !== 0) {
    throw new Error(`wcdb_init 失败: ${initRet} (DLL可能已过期)`);
  }

  const handleBuf = [BigInt(0)];
  const openRet = wcdb_open_account(sessionDbPath, hexKey, handleBuf);
  if (openRet !== 0) {
    throw new Error(`wcdb_open_account 失败: ${openRet}`);
  }
  const handle = handleBuf[0]; // BigInt, koffi 自动处理
  return { handle, initRet };
}

/**
 * 从 db_storage 路径推断 wxid
 */
function inferWxid(dbStoragePath) {
  // 路径格式: <数据根目录>\xwechat_files\<账号id>_<suffix>\db_storage\
  const parts = dbStoragePath.replace(/\\/g, '/').split('/');
  const parentDir = parts.filter(p => p.includes('_')).pop() || '';
  const wxid = parentDir.split('_')[0];
  return wxid || 'unknown';
}

// ── 命令处理 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cmd = args[0];

// 全局状态（单次执行模式不需要持久化）
let gHandle = null;

async function main() {
  try {
    if (cmd === 'sessions') {
      // sessions <db_storage_path> <hex_key>
      const dbPath = args[1];
      const hexKey = args[2];
      const { handle } = openAccount(dbPath, hexKey);
      
      const outPtr = [null];
      const ret = wcdb_get_sessions(handle, outPtr);
      if (ret !== 0) {
        throw new Error(`wcdb_get_sessions 失败: ${ret}`);
      }
      // char** → 直接解码
      const jsonStr = outPtr[0];
      console.log(jsonStr);
      
      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'search-contact') {
      // search-contact <db_storage_path> <hex_key> <keyword>
      const dbPath = args[1];
      const hexKey = args[2];
      const keyword = args[3];
      const { handle } = openAccount(dbPath, hexKey);

      // 设置 wxid
      const wxid = inferWxid(dbPath);
      wcdb_set_my_wxid(handle, wxid);

      // 在 contact.db 中搜索
      const contactDbPath = path.join(dbPath, 'contact', 'contact.db');
      const sql = `SELECT username, alias, nick_name, remark, local_type FROM contact WHERE alias LIKE '%${keyword}%' OR nick_name LIKE '%${keyword}%' OR remark LIKE '%${keyword}%' OR username LIKE '%${keyword}%' LIMIT 20`;
      
      const outPtr = [null];
      const ret = wcdb_exec_query(handle, 'contact', contactDbPath, sql, outPtr);
      if (ret !== 0) {
        throw new Error(`exec_query 失败: ${ret}`);
      }
      const jsonStr = readVoidJson(outPtr[0]);
      console.log(jsonStr);

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'get-contact') {
      // get-contact <db_storage_path> <hex_key> <wxid_or_username>
      const dbPath = args[1];
      const hexKey = args[2];
      const username = args[3];
      const { handle } = openAccount(dbPath, hexKey);

      const outPtr = [null];
      const ret = wcdb_get_contact(handle, username, outPtr);
      if (ret !== 0) {
        throw new Error(`wcdb_get_contact 失败: ${ret}`);
      }
      const jsonStr = readVoidJson(outPtr[0]);
      console.log(jsonStr);

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'get-messages') {
      // get-messages <db_storage_path> <hex_key> <wxid> [limit] [offset]
      const dbPath = args[1];
      const hexKey = args[2];
      const username = args[3];
      const limit = parseInt(args[4] || '500');
      const offset = parseInt(args[5] || '0');
      const { handle } = openAccount(dbPath, hexKey);

      const outPtr = [null];
      const ret = wcdb_get_messages(handle, username, limit, offset, outPtr);
      if (ret !== 0) {
        throw new Error(`wcdb_get_messages 失败: ${ret}`);
      }
      const jsonStr = readVoidJson(outPtr[0]);
      console.log(jsonStr);

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'get-message-count') {
      // get-message-count <db_storage_path> <hex_key> <wxid>
      const dbPath = args[1];
      const hexKey = args[2];
      const username = args[3];
      const { handle } = openAccount(dbPath, hexKey);

      const countOut = [0];
      const ret = wcdb_get_message_count(handle, username, countOut);
      if (ret !== 0) {
        throw new Error(`wcdb_get_message_count 失败: ${ret}`);
      }
      const count = countOut[0];
      console.log(JSON.stringify({ count }));

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'display-names') {
      // display-names <db_storage_path> <hex_key> <wxid1,wxid2,...>
      const dbPath = args[1];
      const hexKey = args[2];
      const usernamesJson = args[3]; // JSON array string
      const { handle } = openAccount(dbPath, hexKey);

      const outPtr = [null];
      const ret = wcdb_get_display_names(handle, usernamesJson, outPtr);
      if (ret !== 0) {
        throw new Error(`wcdb_get_display_names 失败: ${ret}`);
      }
      const jsonStr = readVoidJson(outPtr[0]);
      console.log(jsonStr);

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'exec-query') {
      // exec-query <db_storage_path> <hex_key> <kind> <db_relative_path> <sql>
      const dbPath = args[1];
      const hexKey = args[2];
      const kind = args[3];
      const dbRelPath = args[4];
      const sql = args[5];
      const { handle } = openAccount(dbPath, hexKey);

      const fullDbPath = path.join(dbPath, dbRelPath);
      const outPtr = [null];
      const ret = wcdb_exec_query(handle, kind, fullDbPath, sql, outPtr);
      if (ret !== 0) {
        throw new Error(`exec_query 失败: ${ret}`);
      }
      const jsonStr = readVoidJson(outPtr[0]);
      console.log(jsonStr);

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else if (cmd === 'extract-chat') {
      // extract-chat <db_storage_path> <hex_key> <wxid> [--output path]
      // 完整提取：获取联系人信息 + 全部消息 → 保存为JSON
      // 默认保存到 {cwd}/.temp/getwe/{联系人名}_messages.json
      const dbPath = args[1];
      const hexKey = args[2];
      const targetWxid = args[3];
      
      // 解析 --output 参数
      let outputPath = null;
      const outputIdx = args.indexOf('--output');
      if (outputIdx !== -1 && args[outputIdx + 1]) {
        outputPath = args[outputIdx + 1];
      }
      const { handle } = openAccount(dbPath, hexKey);

      // 1. 获取联系人信息
      const contactPtr = [null];
      let contactInfo = {};
      const contactRet = wcdb_get_contact(handle, targetWxid, contactPtr);
      if (contactRet === 0 && contactPtr[0]) {
        const contactStr = readVoidJson(contactPtr[0]);
        try {
          contactInfo = JSON.parse(contactStr);
        } catch(e) { /* ignore parse error */ }
      }

      // 2. 获取消息数量
      const countOut = [0];
      wcdb_get_message_count(handle, targetWxid, countOut);
      const msgCount = countOut[0];

      // 3. 分批获取全部消息
      const allMessages = [];
      const BATCH_SIZE = 500;
      let offset = 0;
      while (offset < msgCount) {
        const msgPtr = [null];
        const ret = wcdb_get_messages(handle, targetWxid, BATCH_SIZE, offset, msgPtr);
        if (ret !== 0) break;
        const msgStr = readVoidJson(msgPtr[0]);
        if (!msgStr) break;
        try {
          const batch = JSON.parse(msgStr);
          if (Array.isArray(batch)) {
            allMessages.push(...batch);
          }
        } catch(e) { break; }
        offset += BATCH_SIZE;
      }

      // 4. 字段映射（WeChat 4.x → 统一字段名）
      const mapped = allMessages.map(m => ({
        createTime: parseInt(m.create_time) || 0,
        isSend: m.computed_is_send === 1 || m.computed_is_send === '1',
        content: m.message_content || '',
        localType: parseInt(m.local_type) || 0,
        msgType: parseInt(m.local_type) === 1 ? 'text' : (parseInt(m.local_type) === 3 ? 'image' : (parseInt(m.local_type) === 34 ? 'voice' : (parseInt(m.local_type) === 47 ? 'emoji' : (parseInt(m.local_type) === 49 ? 'app' : 'other')))),
        senderUsername: m.sender_username || '',
        localId: parseInt(m.local_id) || 0,
      }));

      // 5. 组装结果
      const result = {
        target: targetWxid,
        alias: contactInfo.alias || '',
        remark: contactInfo.remark || '',
        nickName: contactInfo.nick_name || '',
        messageCount: mapped.length,
        firstMsgTime: mapped.length > 0 ? new Date(Math.min(...mapped.map(m => m.createTime * 1000))).toISOString() : null,
        lastMsgTime: mapped.length > 0 ? new Date(Math.max(...mapped.map(m => m.createTime * 1000))).toISOString() : null,
        messages: mapped,
      };

      const jsonOutput = JSON.stringify(result, null, 2);

      // 默认保存路径：{cwd}/.temp/getwe/{联系人名}_messages.json
      if (!outputPath) {
        outputPath = getDefaultOutputPath(contactInfo, targetWxid, 'messages');
      }
      
      // 确保目录存在
      const outputDir = path.dirname(outputPath);
      fs.mkdirSync(outputDir, { recursive: true });
      
      fs.writeFileSync(outputPath, jsonOutput, 'utf-8');
      // 输出保存路径到 stderr（不干扰 stdout 的JSON输出）
      console.error(`已保存 ${mapped.length} 条消息到 ${outputPath}`);

      wcdb_close_account(handle);
      wcdb_shutdown();

    } else {
      console.error(`未知命令: ${cmd}`);
      console.error(`可用命令: sessions, search-contact, get-contact, get-messages, get-message-count, display-names, exec-query, extract-chat`);
      process.exit(1);
    }

  } catch (err) {
    console.error(`错误: ${err.message}`);
    if (gHandle) {
      try { wcdb_close_account(gHandle); } catch(e) {}
      try { wcdb_shutdown(); } catch(e) {}
    }
    process.exit(1);
  }
}

main();
