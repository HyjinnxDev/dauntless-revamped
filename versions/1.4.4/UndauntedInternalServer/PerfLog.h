#pragma once
#include <Windows.h>
#include <psapi.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>
#ifdef _MSC_VER
#pragma comment(lib, "psapi.lib")
#endif

// Optimisation telemetry: aggregate timings and counts only. No player names, IDs,
// commands or credentials. Written to <GAMESERVER_READY_DIR>\perf-<PID>.log every
// 10 s as key=value lines (set DR_PERF_LOG=0 to disable, DR_PERF_SAMPLE=N to time
// every Nth ReplicateActor call; default 4). Everything runs on the game thread.
namespace PerfLog {
using Clock = std::chrono::steady_clock;

inline int64_t Us(Clock::time_point From, Clock::time_point To) {
    return std::chrono::duration_cast<std::chrono::microseconds>(To - From).count();
}

struct Stat {
    uint64_t Sum = 0; uint32_t Max = 0;
    void Add(int64_t Micros) {
        const uint32_t V = Micros < 0 ? 0 : static_cast<uint32_t>((std::min<int64_t>)(Micros, 0xFFFFFFFFll));
        Sum += V; if (V > Max) Max = V;
    }
};

struct Window {
    uint32_t Frames = 0, Hist[6] = {}, BudgetMiss = 0, ChannelsCreated = 0, ChannelsMax = 0, ConnsMax = 0;
    uint64_t ConnsSum = 0, Scanned = 0, Considered = 0, Deferred = 0, OwnerSkipped = 0, ReplicateCalls = 0;
    double DtSum = 0, DtMax = 0;
    Stat Work, Sleep, SleepOver, Late, Pre, Engine, Extras, Repl, Snap, Post;
    Stat Consider, Index, ConnLoop, ChannelCreate, Replicate; // Replicate = sampled single calls
};

struct ClassStat { uint64_t Sampled = 0, Us = 0; uint32_t Max = 0; };
struct CensusStat { uint32_t Count = 0, Urgent = 0; double FreqSum = 0; };

inline Window W;
inline std::unordered_map<const void*, ClassStat> Classes;
inline std::unordered_map<const void*, CensusStat> Census;
inline wchar_t Path[MAX_PATH] = {};
inline uint64_t BytesWritten = 0, SlowLines = 0;
inline unsigned SampleEvery = 4, SampleCounter = 0, WindowsSinceClassReport = 0;
inline Clock::time_point WindowStart, NextFlush, NextCensus, SlowMinuteEnd;
inline uint64_t PrevProcCpu = 0, PrevThreadCpu = 0, ClassFrames = 0;
inline bool Enabled = false;
constexpr uint64_t MaxFileBytes = 32ull << 20;

inline void Append(const std::string& Text) {
    if (!Enabled || Text.empty() || BytesWritten + Text.size() > MaxFileBytes) return;
    HANDLE File = CreateFileW(Path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (File == INVALID_HANDLE_VALUE) return;
    DWORD Written = 0; WriteFile(File, Text.data(), static_cast<DWORD>(Text.size()), &Written, nullptr);
    CloseHandle(File); BytesWritten += Written;
}

inline void Init() {
    wchar_t Mode[8] = {}, Dir[MAX_PATH] = {}, Sample[8] = {};
    if (GetEnvironmentVariableW(L"DR_PERF_LOG", Mode, 8) == 1 && Mode[0] == L'0') return;
    const DWORD Size = GetEnvironmentVariableW(L"GAMESERVER_READY_DIR", Dir, MAX_PATH);
    if (!Size || Size >= MAX_PATH - 48) return;
    swprintf_s(Path, L"%s\\perf-%lu.log", Dir, GetCurrentProcessId());
    if (GetEnvironmentVariableW(L"DR_PERF_SAMPLE", Sample, 8) > 0)
        SampleEvery = static_cast<unsigned>((std::clamp)(_wtoi(Sample), 1, 64));
    Enabled = true;
    WindowStart = Clock::now(); NextFlush = WindowStart + std::chrono::seconds(10);
    NextCensus = WindowStart + std::chrono::seconds(60); SlowMinuteEnd = WindowStart;
    char Line[160];
    sprintf_s(Line, "perf_start pid=%lu sample_every=%u window_s=10 class_report_s=30 census_s=60\n",
        GetCurrentProcessId(), SampleEvery);
    Append(Line);
}

inline bool SampleCall() { return Enabled && ++SampleCounter % SampleEvery == 0; }
inline bool CensusDue() { return Enabled && Clock::now() >= NextCensus; }

inline void RecordReplicate(const void* Class, Clock::time_point Begin) {
    const int64_t Micros = Us(Begin, Clock::now());
    W.Replicate.Add(Micros);
    if (Classes.size() > 1024 && !Classes.count(Class)) return;
    auto& C = Classes[Class]; ++C.Sampled; C.Us += Micros > 0 ? Micros : 0;
    C.Max = (std::max)(C.Max, static_cast<uint32_t>(Micros > 0 ? Micros : 0));
}
inline void Tally(const void* Class, bool Urgent, float Frequency) {
    if (Census.size() > 1024 && !Census.count(Class)) return;
    auto& C = Census[Class]; ++C.Count; C.Urgent += Urgent; C.FreqSum += Frequency == Frequency ? Frequency : 0;
}

struct Lap {
    Clock::time_point T = Clock::now();
    int64_t Next() { const auto N = Clock::now(); const int64_t D = Us(T, N); T = N; return D; }
};

inline void RecordFrameWork(int64_t Micros, double Dt) {
    ++W.Frames; W.Work.Add(Micros); W.DtSum += Dt; W.DtMax = (std::max)(W.DtMax, Dt);
    ++W.Hist[Micros < 16000 ? 0 : Micros < 33000 ? 1 : Micros < 50000 ? 2 : Micros < 100000 ? 3 : Micros < 250000 ? 4 : 5];
}

inline uint64_t FileTimeValue(const FILETIME& A, const FILETIME& B) {
    return ((static_cast<uint64_t>(A.dwHighDateTime) << 32) | A.dwLowDateTime)
         + ((static_cast<uint64_t>(B.dwHighDateTime) << 32) | B.dwLowDateTime);
}

// Pure formatting of the window counters; tested without a running engine.
inline std::string FormatWindow(const Window& V, double WallSeconds, uint64_t UptimeMs) {
    const double F = V.Frames ? V.Frames : 1, Ms = 0.001;
    char B[2048];
    const auto A = [&](const Stat& S) { return S.Sum * Ms / F; };
    const auto M = [&](const Stat& S) { return S.Max * Ms; };
    int N = sprintf_s(B,
        "perf t_ms=%llu win_s=%.1f frames=%u fps=%.1f sim_ratio=%.3f dt_max_ms=%.1f\n"
        "perf_frame work_ms_avg=%.2f work_ms_max=%.2f hist_lt16=%u lt33=%u lt50=%u lt100=%u lt250=%u ge250=%u "
        "budget_miss=%u late_ms_max=%.2f sleep_ms_avg=%.2f sleep_over_ms_avg=%.2f sleep_over_ms_max=%.2f\n"
        "perf_phase_ms pre=%.2f/%.2f engine=%.2f/%.2f extras=%.2f/%.2f repl=%.2f/%.2f snap=%.2f/%.2f post=%.2f/%.2f (avg/max)\n",
        static_cast<unsigned long long>(UptimeMs), WallSeconds, V.Frames, WallSeconds > 0 ? V.Frames / WallSeconds : 0.0,
        WallSeconds > 0 ? V.DtSum / WallSeconds : 0.0, V.DtMax * 1000.0,
        A(V.Work), M(V.Work), V.Hist[0], V.Hist[1], V.Hist[2], V.Hist[3], V.Hist[4], V.Hist[5],
        V.BudgetMiss, M(V.Late), A(V.Sleep), A(V.SleepOver), M(V.SleepOver),
        A(V.Pre), M(V.Pre), A(V.Engine), M(V.Engine), A(V.Extras), M(V.Extras),
        A(V.Repl), M(V.Repl), A(V.Snap), M(V.Snap), A(V.Post), M(V.Post));
    std::string Out(B, N > 0 ? N : 0);
    N = sprintf_s(B,
        "perf_net conns_avg=%.1f conns_max=%u channels_max=%u scanned_avg=%.0f considered_avg=%.0f deferred_avg=%.0f "
        "owner_skipped_avg=%.0f replicate_calls_avg=%.0f replicate_call_us_max=%u consider_ms=%.2f/%.2f "
        "index_ms=%.2f/%.2f conn_loop_ms_max=%.2f chan_created=%u chan_create_ms_sum=%.2f chan_create_ms_max=%.2f\n",
        V.ConnsSum / F, V.ConnsMax, V.ChannelsMax, V.Scanned / F, V.Considered / F, V.Deferred / F,
        V.OwnerSkipped / F, V.ReplicateCalls / F, V.Replicate.Max, A(V.Consider), M(V.Consider),
        A(V.Index), M(V.Index), M(V.ConnLoop), V.ChannelsCreated, V.ChannelCreate.Sum * Ms, M(V.ChannelCreate));
    Out.append(B, N > 0 ? N : 0);
    return Out;
}

template <class NameOf>
std::string FormatClasses(NameOf&& Name, unsigned SampleN, double Frames) {
    std::vector<std::pair<const void*, ClassStat>> Rows(Classes.begin(), Classes.end());
    std::sort(Rows.begin(), Rows.end(), [](auto& L, auto& R) { return L.second.Us > R.second.Us; });
    std::string Out; char B[512];
    for (size_t I = 0; I < Rows.size() && I < 10; ++I) {
        const auto& S = Rows[I].second;
        const int N = sprintf_s(B, "perf_class name=%s est_calls_per_frame=%.1f est_ms_per_frame=%.3f avg_us=%.1f max_us=%u\n",
            Name(Rows[I].first).c_str(), S.Sampled * double(SampleN) / (Frames > 0 ? Frames : 1),
            S.Us * double(SampleN) / 1000.0 / (Frames > 0 ? Frames : 1), S.Sampled ? double(S.Us) / S.Sampled : 0.0, S.Max);
        if (N > 0) Out.append(B, N);
    }
    return Out;
}

template <class NameOf>
std::string FormatCensus(NameOf&& Name) {
    std::vector<std::pair<const void*, CensusStat>> Rows(Census.begin(), Census.end());
    std::sort(Rows.begin(), Rows.end(), [](auto& L, auto& R) { return L.second.Count > R.second.Count; });
    std::string Out; char B[512]; uint64_t Total = 0;
    for (auto& R : Rows) Total += R.second.Count;
    for (size_t I = 0; I < Rows.size() && I < 15; ++I) {
        const auto& S = Rows[I].second;
        const int N = sprintf_s(B, "perf_census name=%s count=%u urgent=%u avg_net_update_hz=%.1f of_total=%llu\n",
            Name(Rows[I].first).c_str(), S.Count, S.Urgent, S.Count ? S.FreqSum / S.Count : 0.0,
            static_cast<unsigned long long>(Total));
        if (N > 0) Out.append(B, N);
    }
    return Out;
}

// Call once per tick after the frame work is recorded. Cheap unless a window ended.
template <class NameOf>
void MaybeFlush(NameOf&& Name, int Actors) {
    if (!Enabled) return;
    const auto Now = Clock::now();
    if (Now < NextFlush) return;
    const double Wall = Us(WindowStart, Now) / 1e6;
    std::string Out = FormatWindow(W, Wall, GetTickCount64());

    FILETIME Create, Exit, K, U, K2, U2;
    GetProcessTimes(GetCurrentProcess(), &Create, &Exit, &K, &U);
    GetThreadTimes(GetCurrentThread(), &Create, &Exit, &K2, &U2);
    const uint64_t Proc = FileTimeValue(K, U), Thread = FileTimeValue(K2, U2);
    PROCESS_MEMORY_COUNTERS_EX Mem = {}; Mem.cb = sizeof(Mem);
    GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&Mem), sizeof(Mem));
    DWORD Handles = 0; GetProcessHandleCount(GetCurrentProcess(), &Handles);
    MEMORYSTATUSEX Host = {}; Host.dwLength = sizeof(Host); GlobalMemoryStatusEx(&Host);
    char B[512];
    const int N = sprintf_s(B,
        "perf_proc cpu_pct=%.1f game_thread_cpu_pct=%.1f working_set_mb=%.0f private_mb=%.0f handles=%lu "
        "host_avail_mb=%.0f host_mem_load_pct=%lu actors_in_level=%d\n",
        Wall > 0 ? (Proc - PrevProcCpu) / (Wall * 1e5) : 0.0, Wall > 0 ? (Thread - PrevThreadCpu) / (Wall * 1e5) : 0.0,
        Mem.WorkingSetSize / 1048576.0, Mem.PrivateUsage / 1048576.0, Handles,
        Host.ullAvailPhys / 1048576.0, Host.dwMemoryLoad, Actors);
    if (N > 0) Out.append(B, N);
    PrevProcCpu = Proc; PrevThreadCpu = Thread;

    ClassFrames += W.Frames;
    if (++WindowsSinceClassReport >= 3) {
        WindowsSinceClassReport = 0;
        Out += FormatClasses(Name, SampleEvery, static_cast<double>(ClassFrames));
        Classes.clear(); ClassFrames = 0;
    }
    if (Now >= NextCensus) {
        Out += FormatCensus(Name);
        Census.clear(); NextCensus = Now + std::chrono::seconds(60);
    }
    Append(Out);
    W = Window{}; WindowStart = Now; NextFlush = Now + std::chrono::seconds(10);
}

// Rate-limited (20/min) immediate line for any single frame over 100 ms.
inline void MaybeSlowFrame(int64_t WorkUs, int64_t Pre, int64_t Engine, int64_t Extras, int64_t Repl,
                           int64_t Snap, int64_t Post, int64_t ConsiderUs, int Conns, int Actors) {
    if (!Enabled || WorkUs < 100000) return;
    const auto Now = Clock::now();
    if (Now >= SlowMinuteEnd) { SlowMinuteEnd = Now + std::chrono::seconds(60); SlowLines = 0; }
    if (++SlowLines > 20) return;
    char B[320];
    const int N = sprintf_s(B,
        "perf_slow_frame t_ms=%llu work_ms=%.1f pre=%.1f engine=%.1f extras=%.1f repl=%.1f (consider=%.1f) snap=%.1f post=%.1f conns=%d actors=%d\n",
        static_cast<unsigned long long>(GetTickCount64()), WorkUs / 1e3, Pre / 1e3, Engine / 1e3, Extras / 1e3,
        Repl / 1e3, ConsiderUs / 1e3, Snap / 1e3, Post / 1e3, Conns, Actors);
    if (N > 0) Append(std::string(B, N));
}
}
