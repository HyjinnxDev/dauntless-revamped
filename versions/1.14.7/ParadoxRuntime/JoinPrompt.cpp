// Join-in-progress prompt, backend side (client). While this player is in Ramsgate and another party member is on a
// hunt that still takes players, the backend (routes/party.ts /mystic/party/hunt-offer) returns an offer. This
// worker thread polls for it and talks to the backend; the game thread (dllmain.cpp JoinPopup) shows the offer in
// the game's own popup (UArchonGlobalUI::DisplayPopup) and hands back the answer. On "join" the backend gives this
// player the hunt the way a party member follows its leader, and the game travels on its own.
// Auth: the launcher's voice ticket (X-Mystic-Ticket); the runtime holds no game bearer token.
// Off without the launcher env, or with DISABLE_JOIN_PROMPT.flag beside the exe.
// [Revamped 2026-11-03] A second thread polls GET /mystic/name-tags (staff tier + name style per display name) every
// 30 s for dllmain.cpp StaffNameplates; game names carry no tags since the game caps them at 20 characters.

#include <windows.h>
#include <winhttp.h>
#include <algorithm>
#include <atomic>
#include <mutex>
#include <string>
#include "RuntimeShared.h"

#pragma comment(lib, "winhttp.lib")

namespace {

std::mutex g_Lock;
std::string g_Offer, g_Notice;      // game thread takes these (one-shot)
std::string g_NameTags;             // last /mystic/name-tags body: "name\ttier\tstyle\n" lines
std::atomic<int> g_Answer{ 0 };     // 1 join, 2 stay
std::wstring g_Base, g_Ticket;

bool Http(const wchar_t* Method, const std::wstring& PathOnly, std::string& Body, DWORD& Status) {
    const std::wstring Url = g_Base + PathOnly;
    wchar_t Host[256]{}, Path[512]{};
    URL_COMPONENTS Parts{ sizeof(Parts) };
    Parts.lpszHostName = Host; Parts.dwHostNameLength = 256;
    Parts.lpszUrlPath = Path; Parts.dwUrlPathLength = 512;
    if (!WinHttpCrackUrl(Url.c_str(), 0, 0, &Parts)) return false;

    bool Ok = false;
    Body.clear();
    Status = 0;
    HINTERNET Session = WinHttpOpen(L"MysticParadoxJoin/1", WINHTTP_ACCESS_TYPE_NO_PROXY, nullptr, nullptr, 0);
    HINTERNET Connect = Session ? WinHttpConnect(Session, Host, Parts.nPort, 0) : nullptr;
    HINTERNET Request = Connect ? WinHttpOpenRequest(Connect, Method, Path, nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, Parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
    if (Request) {
        WinHttpSetTimeouts(Request, 3000, 3000, 5000, 5000);
        const std::wstring Headers = L"X-Mystic-Ticket: " + g_Ticket + L"\r\nContent-Length: 0\r\n";
        DWORD StatusSize = sizeof(Status);
        Ok = WinHttpSendRequest(Request, Headers.c_str(), static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
            && WinHttpReceiveResponse(Request, nullptr)
            && WinHttpQueryHeaders(Request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                   WINHTTP_HEADER_NAME_BY_INDEX, &Status, &StatusSize, WINHTTP_NO_HEADER_INDEX);
        for (DWORD Avail = 0; Ok && WinHttpQueryDataAvailable(Request, &Avail) && Avail > 0 && Body.size() < 8192;) {
            std::string Chunk(Avail, '\0');
            DWORD Read = 0;
            if (!WinHttpReadData(Request, Chunk.data(), Avail, &Read) || Read == 0) break;
            Body.append(Chunk.data(), Read);
        }
    }
    if (Request) WinHttpCloseHandle(Request);
    if (Connect) WinHttpCloseHandle(Connect);
    if (Session) WinHttpCloseHandle(Session);
    return Ok;
}

// Flat reads from the backend's own small JSON (no nesting beyond "offer"). Escapes are kept as-is.
std::string JsonStr(const std::string& J, const char* Key) {
    const std::string K = std::string("\"") + Key + "\":\"";
    const size_t At = J.find(K);
    if (At == std::string::npos) return "";
    const size_t Start = At + K.size();
    size_t End = Start;
    while (End < J.size() && !(J[End] == '"' && J[End - 1] != '\\')) ++End;
    return J.substr(Start, End - Start);
}

int JsonInt(const std::string& J, const char* Key, int Def) {
    const std::string K = std::string("\"") + Key + "\":";
    const size_t At = J.find(K);
    return At == std::string::npos ? Def : atoi(J.c_str() + At + K.size());
}

void Set(std::string& Slot, const std::string& Value) {
    std::lock_guard<std::mutex> Lk(g_Lock);
    Slot = Value;
}

const char* ReasonText(const std::string& R) {
    if (R == "FULL") return "The hunt is full.";
    if (R == "NEARLY_DONE") return "The behemoth is nearly dead.";
    if (R == "ENDING") return "The hunt is ending.";
    return "The hunt is no longer open.";
}

DWORD WINAPI Thread(LPVOID) {
    std::string Shown, ShownName;   // offer key (member|hunt) last put in front of the player; each is shown once
    ULONGLONG NextPoll = 0;
    for (;;) {
        Sleep(100);
        const int Answer = g_Answer.exchange(0);
        if (Answer == 2) MpLog("[JoinPrompt] stay: " + Shown);
        if (Answer == 1) {
            std::string Body;
            DWORD Status = 0;
            const bool Ok = Http(L"POST", L"/mystic/party/join-hunt", Body, Status);
            MpLog("[JoinPrompt] join " + Shown + " -> " + (Ok ? std::to_string(Status) : std::string("no response")) + " " + Body);
            Set(g_Notice, Ok && Status == 200 ? "Joining " + ShownName + "'s hunt."
                : std::string("Can't join. ") + ReasonText(JsonStr(Body, "reason")));
            NextPoll = GetTickCount64() + 10000;
        }
        if (GetTickCount64() < NextPoll) continue;
        NextPoll = GetTickCount64() + 1000;   // the backend answers from memory unless a party member is hunting
        std::string Body;
        DWORD Status = 0;
        if (!Http(L"GET", L"/mystic/party/hunt-offer", Body, Status) || Status != 200
            || Body.find("\"offer\":{") == std::string::npos || Body.find("\"blocked\":null") == std::string::npos) continue;
        const std::string Name = JsonStr(Body, "memberName");
        const std::string Key = Name + "|" + JsonStr(Body, "huntId");
        if (Key == Shown) continue;
        Shown = Key;
        ShownName = Name;
        const int Hp = JsonInt(Body, "hpPct", -1), Players = JsonInt(Body, "players", 0);
        Set(g_Offer, Name + " is on a hunt ("
            + (Hp < 0 ? std::string("behemoth not found yet") : "behemoth at " + std::to_string(Hp) + "%")
            + ", " + std::to_string(Players) + "/4 slayers).\nJoin their hunt?");
        MpLog("[JoinPrompt] offer " + Key);
    }
}

DWORD WINAPI NameTagThread(LPVOID) {
    for (bool Logged = false;; Sleep(30000)) {
        std::string Body;
        DWORD Status = 0;
        const bool Ok = Http(L"GET", L"/mystic/name-tags", Body, Status) && Status == 200;
        if (Ok) Set(g_NameTags, Body);
        if (!Logged || !Ok) MpLog("[NameTags] " + (Ok ? std::to_string(std::count(Body.begin(), Body.end(), '\n')) + " tagged names"
            : "fetch failed status=" + std::to_string(Status)));
        Logged = Logged || Ok;
    }
}

bool Take(std::string& Slot, std::string& Out) {
    std::lock_guard<std::mutex> Lk(g_Lock);
    Out.swap(Slot);
    Slot.clear();
    return !Out.empty();
}

}  // namespace

bool MpJoinPromptTakeOffer(std::string& Text) { return Take(g_Offer, Text); }
bool MpJoinPromptTakeNotice(std::string& Text) { return Take(g_Notice, Text); }
void MpJoinPromptAnswer(bool Join) { g_Answer = Join ? 1 : 2; }
std::string MpNameTags() {
    std::lock_guard<std::mutex> Lk(g_Lock);
    return g_NameTags;
}

void MpJoinPromptStart() {
    char Ticket[4096]{};                         // a JWT; MpReadEnvironment stops at 512
    const DWORD Len = GetEnvironmentVariableA("MYSTICPARADOX_VOICE_TICKET", Ticket, sizeof(Ticket));
    g_Base = MpApiBaseForCrashReports();
    if (g_Base.empty() || Len == 0 || Len >= sizeof(Ticket)) {
        MpLog("[JoinPrompt] off (no launcher ticket)");
        return;
    }
    g_Ticket.assign(Ticket, Ticket + Len);
    CreateThread(nullptr, 0, NameTagThread, nullptr, 0, nullptr);
    if (MpExeRelativeFlagPresent(L"DISABLE_JOIN_PROMPT.flag")) { MpLog("[JoinPrompt] off (flag)"); return; }
    CreateThread(nullptr, 0, Thread, nullptr, 0, nullptr);
    MpLog("[JoinPrompt] polling for party hunt offers");
}
