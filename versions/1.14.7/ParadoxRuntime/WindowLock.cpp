// Keeps the player's own window size, position and border style across map loads (client). The game re-applies the
// saved display settings on every travel, and Windowed Fullscreen always means "the whole monitor" - on an
// ultrawide that undoes a centred borderless 2560x1440 set with an external tool or by hand.
// The engine moves its window in-process (SetWindowLong(Ptr)W GWL_STYLE, then SetWindowPos / MoveWindow); outside
// tools and window drags never pass through these. So an engine request identical to its previous one is a re-apply
// and leaves the window as it is now; a new request (display settings changed in the options menu) goes through.
// Slate caches the size it asked for, so a kept window is re-announced with WM_MOVE/WM_SIZE (else it renders and
// maps the mouse for the engine's rect). A borderless window smaller than its monitor gets resize edges.
// Off with DISABLE_WINDOW_LOCK.flag beside the exe.

#include <windows.h>
#include <windowsx.h>
#include <mutex>
#include <string>
#include "MinHook/MinHook.h"
#include "RuntimeShared.h"

namespace {

constexpr LONG_PTR kFrameBits = WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;

std::mutex g_Lock;
bool g_HaveRect = false, g_HaveFrame = false;
RECT g_LastRect{};          // the engine's last requested window rect
LONG_PTR g_LastFrame = 0;   // the engine's last requested border style

using SetWindowPosFn = BOOL(WINAPI*)(HWND, HWND, int, int, int, int, UINT);
using MoveWindowFn = BOOL(WINAPI*)(HWND, int, int, int, int, BOOL);
using SetWindowLongWFn = LONG(WINAPI*)(HWND, int, LONG);
using SetWindowLongPtrWFn = LONG_PTR(WINAPI*)(HWND, int, LONG_PTR);
SetWindowPosFn OrigSetWindowPos = nullptr;
MoveWindowFn OrigMoveWindow = nullptr;
SetWindowLongWFn OrigSetWindowLongW = nullptr;
SetWindowLongPtrWFn OrigSetWindowLongPtrW = nullptr;

// The game's main window: our own top-level, unowned UnrealWindow (Slate popups are owned by it).
bool GameWindow(HWND H) {
    if (!H || GetWindow(H, GW_OWNER) || (GetWindowLongPtrW(H, GWL_STYLE) & WS_CHILD)) return false;
    DWORD Pid = 0;
    GetWindowThreadProcessId(H, &Pid);
    wchar_t Cls[32]{};
    return Pid == GetCurrentProcessId() && GetClassNameW(H, Cls, 32) && wcscmp(Cls, L"UnrealWindow") == 0;
}

// Tells the engine the window's real client rect after a kept re-apply; the engine handles both on its message pump.
void Resync(HWND H) {
    RECT C{};
    POINT O{};
    if (!GetClientRect(H, &C) || !ClientToScreen(H, &O)) return;
    PostMessageW(H, WM_MOVE, 0, MAKELPARAM(O.x, O.y));
    PostMessageW(H, WM_SIZE, SIZE_RESTORED, MAKELPARAM(C.right, C.bottom));
}

// Resize edge under the cursor for a borderless (no caption) window that does not fill its monitor, else 0.
// ponytail: fixed 8 px grab band, scale with GetDpiForWindow if it feels thin on high-DPI screens.
LRESULT EdgeHit(HWND H, LPARAM L) {
    if ((GetWindowLongPtrW(H, GWL_STYLE) & WS_CAPTION) == WS_CAPTION || IsZoomed(H) || IsIconic(H)) return 0;
    RECT W{};
    MONITORINFO M{ sizeof(M) };
    if (!GetWindowRect(H, &W) || !GetMonitorInfoW(MonitorFromWindow(H, MONITOR_DEFAULTTONEAREST), &M)
        || EqualRect(&W, &M.rcMonitor)) return 0;
    constexpr int B = 8;
    const int X = GET_X_LPARAM(L), Y = GET_Y_LPARAM(L);
    const bool Left = X < W.left + B, Right = X >= W.right - B;
    if (Y < W.top + B) return Left ? HTTOPLEFT : Right ? HTTOPRIGHT : HTTOP;
    if (Y >= W.bottom - B) return Left ? HTBOTTOMLEFT : Right ? HTBOTTOMRIGHT : HTBOTTOM;
    return Left ? HTLEFT : Right ? HTRIGHT : 0;
}

bool SizingHit(WPARAM Hit) { return Hit >= HTLEFT && Hit <= HTBOTTOMRIGHT; }

HWND g_Subclassed = nullptr;
WNDPROC g_EngineProc = nullptr;

// Our edges go to Windows' own sizing loop and cursor; everything else to the engine.
LRESULT CALLBACK GameWndProc(HWND H, UINT Msg, WPARAM W, LPARAM L) {
    if (Msg == WM_NCHITTEST)
        if (const LRESULT Hit = EdgeHit(H, L)) return Hit;
    if ((Msg == WM_NCLBUTTONDOWN && SizingHit(W)) || (Msg == WM_SETCURSOR && SizingHit(LOWORD(L))))
        return DefWindowProcW(H, Msg, W, L);
    return CallWindowProcW(g_EngineProc, H, Msg, W, L);
}

std::string RectText(const RECT& R) {
    return std::to_string(R.right - R.left) + "x" + std::to_string(R.bottom - R.top)
        + " at " + std::to_string(R.left) + "," + std::to_string(R.top);
}

// True (Keep = the window now) when Req repeats the engine's last request and the window was changed since.
bool KeepRect(HWND H, const RECT& Req, RECT& Keep) {
    std::lock_guard<std::mutex> Lk(g_Lock);
    const bool Repeat = g_HaveRect && EqualRect(&Req, &g_LastRect);
    g_LastRect = Req;
    g_HaveRect = true;
    if (!Repeat || !GetWindowRect(H, &Keep) || EqualRect(&Keep, &Req) || IsIconic(H)) return false;
    MpLog("[WindowLock] kept player window " + RectText(Keep) + " over engine re-apply " + RectText(Req));
    return true;
}

// The style to write: the engine's, with the current border bits when it only re-applies its last border style.
LONG_PTR FilterStyle(HWND H, LONG_PTR Style) {
    std::lock_guard<std::mutex> Lk(g_Lock);
    const LONG_PTR Frame = Style & kFrameBits, Now = GetWindowLongPtrW(H, GWL_STYLE) & kFrameBits;
    const bool Repeat = g_HaveFrame && Frame == g_LastFrame;
    if (!Repeat) g_HaveRect = false;   // a new window mode brings a new rect too
    g_LastFrame = Frame;
    g_HaveFrame = true;
    if (!Repeat || Frame == Now) return Style;
    MpLog("[WindowLock] kept player border style over engine re-apply");
    return (Style & ~kFrameBits) | Now;
}

// Puts GameWndProc in front of the engine's window procedure, once per game window.
void Subclass(HWND H) {
    std::lock_guard<std::mutex> Lk(g_Lock);
    if (H == g_Subclassed) return;
    // Engine proc stored before the swap: the window thread may dispatch to GameWndProc straight away.
    g_EngineProc = reinterpret_cast<WNDPROC>(GetWindowLongPtrW(H, GWLP_WNDPROC));
    if (!g_EngineProc || !OrigSetWindowLongPtrW(H, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(GameWndProc))) return;
    g_Subclassed = H;
    MpLog("[WindowLock] borderless resize edges on");
}

BOOL WINAPI HookSetWindowPos(HWND H, HWND After, int X, int Y, int Cx, int Cy, UINT Flags) {
    RECT Cur{};
    if ((Flags & (SWP_NOMOVE | SWP_NOSIZE)) != (SWP_NOMOVE | SWP_NOSIZE) && GameWindow(H) && GetWindowRect(H, &Cur)) {
        Subclass(H);
        RECT Req = Cur;
        if (!(Flags & SWP_NOMOVE)) OffsetRect(&Req, X - Cur.left, Y - Cur.top);
        if (!(Flags & SWP_NOSIZE)) { Req.right = Req.left + Cx; Req.bottom = Req.top + Cy; }
        RECT Keep{};
        if (KeepRect(H, Req, Keep)) {
            const BOOL Ok = OrigSetWindowPos(H, After, Keep.left, Keep.top, Keep.right - Keep.left, Keep.bottom - Keep.top, Flags & ~(SWP_NOMOVE | SWP_NOSIZE));
            Resync(H);
            return Ok;
        }
    }
    return OrigSetWindowPos(H, After, X, Y, Cx, Cy, Flags);
}

BOOL WINAPI HookMoveWindow(HWND H, int X, int Y, int W, int Ht, BOOL Repaint) {
    RECT Keep{};
    if (GameWindow(H)) {
        Subclass(H);
        if (KeepRect(H, RECT{ X, Y, X + W, Y + Ht }, Keep)) {
            const BOOL Ok = OrigMoveWindow(H, Keep.left, Keep.top, Keep.right - Keep.left, Keep.bottom - Keep.top, Repaint);
            Resync(H);
            return Ok;
        }
    }
    return OrigMoveWindow(H, X, Y, W, Ht, Repaint);
}

LONG WINAPI HookSetWindowLongW(HWND H, int Index, LONG Value) {
    if (Index == GWL_STYLE && GameWindow(H)) Value = static_cast<LONG>(FilterStyle(H, Value));
    return OrigSetWindowLongW(H, Index, Value);
}

LONG_PTR WINAPI HookSetWindowLongPtrW(HWND H, int Index, LONG_PTR Value) {
    if (Index == GWL_STYLE && GameWindow(H)) Value = FilterStyle(H, Value);
    return OrigSetWindowLongPtrW(H, Index, Value);
}

bool Hook(LPCSTR Name, LPVOID Detour, LPVOID* Original) {
    LPVOID Target = nullptr;
    return MH_CreateHookApiEx(L"user32.dll", Name, Detour, Original, &Target) == MH_OK && MH_EnableHook(Target) == MH_OK;
}

}  // namespace

void MpWindowLockStart() {
    if (MpExeRelativeFlagPresent(L"DISABLE_WINDOW_LOCK.flag")) {
        MpLog("[WindowLock] off (DISABLE_WINDOW_LOCK.flag)");
        return;
    }
    const bool Pos = Hook("SetWindowPos", reinterpret_cast<LPVOID>(HookSetWindowPos), reinterpret_cast<LPVOID*>(&OrigSetWindowPos));
    const bool Move = Hook("MoveWindow", reinterpret_cast<LPVOID>(HookMoveWindow), reinterpret_cast<LPVOID*>(&OrigMoveWindow));
    const bool Long = Hook("SetWindowLongW", reinterpret_cast<LPVOID>(HookSetWindowLongW), reinterpret_cast<LPVOID*>(&OrigSetWindowLongW));
    const bool LongPtr = Hook("SetWindowLongPtrW", reinterpret_cast<LPVOID>(HookSetWindowLongPtrW), reinterpret_cast<LPVOID*>(&OrigSetWindowLongPtrW));
    MpLog(std::string("[WindowLock] hooks pos=") + (Pos ? "ok" : "FAIL") + " move=" + (Move ? "ok" : "FAIL")
        + " style=" + (Long ? "ok" : "FAIL") + "/" + (LongPtr ? "ok" : "FAIL"));
}
