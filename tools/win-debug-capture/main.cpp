#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dbghelp.h>
#include <cstdio>
#include <vector>
#include <string>

#pragma comment(lib, "dbghelp.lib")

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) { std::fwprintf(stderr, L"usage: win-debug-capture.exe <exe> [args...]\n"); return 2; }
    std::wstring cmd;
    for (int i = 1; i < argc; ++i) { if (i > 1) cmd += L" "; cmd += L"\""; cmd += argv[i]; cmd += L"\""; }
    STARTUPINFOW si{sizeof(si)}; PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, DEBUG_ONLY_THIS_PROCESS,
                        nullptr, nullptr, &si, &pi)) { std::fwprintf(stderr, L"CreateProcess failed=%lu\n", GetLastError()); return 3; }
    CloseHandle(pi.hThread);
    bool captured = false;
    DEBUG_EVENT ev{};
    while (WaitForDebugEvent(&ev, INFINITE)) {
        DWORD status = DBG_CONTINUE;
        if (ev.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
            const auto& ex = ev.u.Exception.ExceptionRecord;
            if (ex.ExceptionCode != EXCEPTION_BREAKPOINT) std::printf("exception=0x%08lx firstChance=%lu address=%p params=%lu info0=0x%llx\n", ex.ExceptionCode, ev.u.Exception.dwFirstChance, ex.ExceptionAddress, ex.NumberParameters, ex.NumberParameters ? (unsigned long long)ex.ExceptionInformation[0] : 0ull);
            if (ex.ExceptionCode == STATUS_STACK_BUFFER_OVERRUN && !captured) {
                captured = true;
                std::printf("ExceptionCode=0x%08lx\nExceptionFlags=0x%08lx\nExceptionAddress=0x%p\nFirstChance=%lu\nNumberParameters=%lu\n",
                    ex.ExceptionCode, ex.ExceptionFlags, ex.ExceptionAddress,
                    ev.u.Exception.dwFirstChance, ex.NumberParameters);
                for (DWORD i=0; i<ex.NumberParameters; ++i) std::printf("ExceptionInformation[%lu]=0x%llx\n", i, (unsigned long long)ex.ExceptionInformation[i]);
                HANDLE th = OpenThread(THREAD_GET_CONTEXT|THREAD_QUERY_INFORMATION, FALSE, ev.dwThreadId);
                if (th) { CONTEXT c{}; c.ContextFlags=CONTEXT_ALL; if (GetThreadContext(th,&c)) std::printf("ThreadId=%lu RIP=0x%llx RSP=0x%llx RBP=0x%llx RAX=0x%llx RBX=0x%llx RCX=0x%llx RDX=0x%llx\n", ev.dwThreadId,(unsigned long long)c.Rip,(unsigned long long)c.Rsp,(unsigned long long)c.Rbp,(unsigned long long)c.Rax,(unsigned long long)c.Rbx,(unsigned long long)c.Rcx,(unsigned long long)c.Rdx); CloseHandle(th); }
                HANDLE dump = CreateFileW(L"mcu_component_test_failfast.dmp", GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
                if (dump != INVALID_HANDLE_VALUE) { BOOL ok=MiniDumpWriteDump(pi.hProcess,pi.dwProcessId, dump, static_cast<MINIDUMP_TYPE>(MiniDumpWithThreadInfo|MiniDumpWithHandleData|MiniDumpWithIndirectlyReferencedMemory), nullptr,nullptr,nullptr); std::printf("minidump=%s\n",ok?"YES":"NO"); CloseHandle(dump); } else std::printf("minidump=NO error=%lu\n",GetLastError());
                TerminateProcess(pi.hProcess, 0xC0000409); CloseHandle(pi.hProcess); return 1;
            }
            if (ex.ExceptionCode != EXCEPTION_BREAKPOINT && ex.ExceptionCode != DBG_CONTROL_C) status = DBG_EXCEPTION_NOT_HANDLED;
        }
        ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status);
        if (ev.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) { DWORD code=ev.u.ExitProcess.dwExitCode; std::printf("exit=0x%08lx captured=%s\n",code,captured?"YES":"NO"); CloseHandle(pi.hProcess); return captured?1:(code?1:0); }
    }
    CloseHandle(pi.hProcess); return 4;
}
