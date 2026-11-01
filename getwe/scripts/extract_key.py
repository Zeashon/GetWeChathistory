"""
GetWe — 微信4.x 密钥提取脚本
使用 wx_key.dll DLL注入Hook方式从运行中的 Weixin.exe 提取64字符hex密钥

需要管理员权限运行！
"""
import ctypes
import os
import sys
import time

def extract_key():
    """从运行中的微信进程提取数据库加密密钥"""
    dll_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
    wx_key_dll = os.path.join(dll_dir, 'wx_key.dll')
    
    if not os.path.exists(wx_key_dll):
        print(f"错误: 找不到 wx_key.dll: {wx_key_dll}")
        return None
    
    # 加载 DLL
    try:
        wx_key = ctypes.CDLL(wx_key_dll)
    except OSError as e:
        print(f"错误: 无法加载 wx_key.dll: {e}")
        return None
    
    # 函数签名
    # int InitializeHook(DWORD pid)
    # int PollKeyData(char* buffer, int size)
    # DWORD GetWeChatPid()
    
    try:
        wx_key.InitializeHook.restype = ctypes.c_int
        wx_key.InitializeHook.argtypes = [ctypes.c_uint32]
        
        wx_key.PollKeyData.restype = ctypes.c_int
        wx_key.PollKeyData.argtypes = [ctypes.c_char_p, ctypes.c_int]
        
        wx_key.GetWeChatPid.restype = ctypes.c_uint32
        wx_key.GetWeChatPid.argtypes = []
    except AttributeError as e:
        print(f"错误: DLL导出函数不存在: {e}")
        return None
    
    # 1. 获取微信PID
    pid = wx_key.GetWeChatPid()
    if pid == 0:
        print("错误: 未找到运行中的微信进程 (Weixin.exe)")
        print("请先启动微信并登录")
        return None
    
    print(f"找到微信进程 PID: {pid}")
    
    # 2. 注入Hook
    ret = wx_key.InitializeHook(pid)
    if ret != 0:
        print(f"错误: InitializeHook 失败: {ret}")
        return None
    
    print("Hook注入成功，等待密钥捕获...")
    
    # 3. 轮询密钥（wx_key.dll 在 Hook 回调中缓存密钥）
    buffer = ctypes.create_string_buffer(65)  # 64 hex chars + null
    key = None
    
    for attempt in range(50):  # 最多等待6秒
        ret = wx_key.PollKeyData(buffer, 64)
        if ret == 0:
            key = buffer.value.decode('ascii', errors='ignore')
            if len(key) == 64:
                break
            key = None
        time.sleep(0.12)
    
    if not key:
        print("错误: 密钥捕获超时")
        print("尝试在微信中打开一个聊天窗口触发密钥派生")
        return None
    
    print(f"密钥提取成功: {key}")
    return key


if __name__ == '__main__':
    # 检查管理员权限
    try:
        is_admin = ctypes.windll.shell32.IsUserAnAdmin()
    except:
        is_admin = False
    
    if not is_admin:
        print("警告: 需要管理员权限!")
        print("请以管理员身份运行此脚本")
        sys.exit(1)
    
    key = extract_key()
    if key:
        # 输出到 stdout 供其他脚本使用
        print(key)
    else:
        sys.exit(1)
