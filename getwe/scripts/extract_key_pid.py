"""
GetWe 补丁版密钥提取脚本
wx_key.dll 实际不导出 GetWeChatPid，改为外部传入微信主进程 PID。
用法: python extract_key_pid.py <PID>
需要管理员权限。
"""
import ctypes
import os
import sys
import time


def extract_key(pid):
    dll_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
    wx_key_dll = os.path.join(dll_dir, 'wx_key.dll')
    if not os.path.exists(wx_key_dll):
        print(f"错误: 找不到 wx_key.dll: {wx_key_dll}")
        return None
    try:
        wx_key = ctypes.CDLL(wx_key_dll)
    except OSError as e:
        print(f"错误: 无法加载 wx_key.dll: {e}")
        return None
    try:
        wx_key.InitializeHook.restype = ctypes.c_int
        wx_key.InitializeHook.argtypes = [ctypes.c_uint32]
        wx_key.PollKeyData.restype = ctypes.c_int
        wx_key.PollKeyData.argtypes = [ctypes.c_char_p, ctypes.c_int]
    except AttributeError as e:
        print(f"错误: DLL导出函数不存在: {e}")
        return None

    print(f"注入 Hook 到微信进程 PID: {pid}")
    ret = wx_key.InitializeHook(pid)
    if ret != 0:
        print(f"错误: InitializeHook 失败: {ret}")
        return None
    print("Hook注入成功，等待密钥捕获...")
    buffer = ctypes.create_string_buffer(65)
    key = None
    for _ in range(60):  # 最多等待约7秒
        if wx_key.PollKeyData(buffer, 64) == 0:
            k = buffer.value.decode('ascii', errors='ignore')
            if len(k) == 64:
                key = k
                break
        time.sleep(0.12)
    if not key:
        print("错误: 密钥捕获超时，请先在微信中打开一个聊天窗口触发密钥派生后重试")
        return None
    print(f"密钥提取成功: {key}")
    return key


if __name__ == '__main__':
    try:
        is_admin = ctypes.windll.shell32.IsUserAnAdmin()
    except Exception:
        is_admin = False
    if not is_admin:
        print("错误: 需要管理员权限! 请以管理员身份运行")
        sys.exit(1)
    if len(sys.argv) < 2:
        print("用法: python extract_key_pid.py <微信主进程PID>")
        sys.exit(1)
    try:
        pid = int(sys.argv[1])
    except ValueError:
        print("错误: PID 必须是整数")
        sys.exit(1)
    key = extract_key(pid)
    if key:
        print(key)
    else:
        sys.exit(1)
