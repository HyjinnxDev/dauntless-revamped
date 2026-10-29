// Hunt stats upload (hunt server). dllmain.cpp MpHuntStatsTick builds each kill's per-player damage JSON on the game
// thread; this sends it to the backend (POST /mystic/hunt-stats, routes/huntStats.ts) on a throwaway thread with the
// gameserver API key, so a slow backend never stalls the hunt. One attempt: a lost post is a lost stats row.

#include <windows.h>
#include <winhttp.h>
#include <string>
#include <thread>
#include "RuntimeShared.h"

#pragma comment(lib, "winhttp.lib")

void MpHuntStatsPost(std::string Json, std::wstring ApiKey) {
    std::thread([Json = std::move(Json), ApiKey = std::move(ApiKey)] {
        const std::wstring Url = MpApiBaseForCrashReports() + L"/mystic/hunt-stats";
        wchar_t Host[256]{}, Path[512]{};
        URL_COMPONENTS Parts{ sizeof(Parts) };
        Parts.lpszHostName = Host; Parts.dwHostNameLength = 256;
        Parts.lpszUrlPath = Path; Parts.dwUrlPathLength = 512;
        if (!WinHttpCrackUrl(Url.c_str(), 0, 0, &Parts)) return;

        DWORD Status = 0, StatusSize = sizeof(Status), Error = 0;
        HINTERNET Session = WinHttpOpen(L"MysticParadoxHuntStats/1", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0);
        HINTERNET Connect = Session ? WinHttpConnect(Session, Host, Parts.nPort, 0) : nullptr;
        HINTERNET Request = Connect ? WinHttpOpenRequest(Connect, L"POST", Path, nullptr, WINHTTP_NO_REFERER,
            WINHTTP_DEFAULT_ACCEPT_TYPES, Parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
        if (Request) {
            WinHttpSetTimeouts(Request, 3000, 3000, 5000, 5000);
            const std::wstring Headers = L"Content-Type: application/json\r\nx-mysticparadox-gameserver-apikey: " + ApiKey + L"\r\n";
            const DWORD Size = static_cast<DWORD>(Json.size());
            if (WinHttpSendRequest(Request, Headers.c_str(), static_cast<DWORD>(-1), const_cast<char*>(Json.data()), Size, Size, 0)
                && WinHttpReceiveResponse(Request, nullptr)) {
                WinHttpQueryHeaders(Request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    WINHTTP_HEADER_NAME_BY_INDEX, &Status, &StatusSize, WINHTTP_NO_HEADER_INDEX);
            } else {
                Error = GetLastError();
            }
        }
        if (Request) WinHttpCloseHandle(Request);
        if (Connect) WinHttpCloseHandle(Connect);
        if (Session) WinHttpCloseHandle(Session);
        MpLog("[HuntStats] backend -> " + (Status ? std::to_string(Status) : "error " + std::to_string(Error)));
    }).detach();
}
