/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Cinematic camera menu (F10): Dear ImGui (imgui/, MIT) drawn on top of the game's frame from an
// IDXGISwapChain::Present hook. The game's window procedure is subclassed so the menu gets the mouse and keyboard;
// clicks and typing the menu uses never reach the game. Only D3D11 is handled: on D3D12 the swap chain has no
// D3D11 device, the menu stays off (logged) and the camera keeps its hotkeys and CINECAM.ini.
// Runs on the RHI thread (Present) and the game thread (window messages); ImGui itself is guarded by s_ImLock and
// the camera state by Cine::G.Lock (see CineCamShared.h). Never touches UObjects. Log tag [CineCam].
// ponytail: D3D11 only, one swap chain (the first one presented), no gamepad navigation.

#define _CRT_SECURE_NO_WARNINGS                     // fopen/sscanf on our own fixed-format shot files
#include "RuntimeShared.h"
#include "CineCamShared.h"
#include <d3d11.h>
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include "MinHook/MinHook.h"
#include "imgui/imgui.h"
#include "imgui/imgui_impl_dx11.h"
#include "imgui/imgui_impl_win32.h"

#pragma comment(lib, "d3d11.lib")

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

namespace Cine {

State G;

// ---------------------------------------------------------------- looks

struct Look { const char* Name; float Exposure, Temp, Tint, Saturation, Contrast, Split, Vignette, Grain, Fringe, Bloom; };
static constexpr Look kLooks[] = {
    { "Natural",        0.f,   6500.f,  0.f,   1.f,  1.f,  0.f,  0.4f,  0.f,   0.f, 0.675f },
    { "Cinematic",     -0.2f,  6300.f,  0.f,   0.9f, 1.12f, 0.3f, 0.55f, 0.12f, 0.6f, 0.9f },
    { "Teal & orange",  0.f,   6500.f,  0.f,   1.1f, 1.1f,  1.f,  0.5f,  0.05f, 0.4f, 0.8f },
    { "Golden hour",    0.2f,  4200.f,  0.05f, 1.15f, 1.05f, 0.2f, 0.45f, 0.05f, 0.f, 1.3f },
    { "Cold",          -0.1f,  9500.f, -0.05f, 0.85f, 1.1f,  0.f,  0.5f,  0.05f, 0.f, 0.6f },
    { "Noir",          -0.1f,  6500.f,  0.f,   0.f,  1.35f, 0.f,  0.75f, 0.35f, 0.f, 0.5f },
    { "Vintage film",   0.1f,  5200.f,  0.1f,  0.7f, 0.9f,  0.2f, 0.7f,  0.5f,  1.5f, 1.1f },
    { "Vibrant",        0.1f,  6500.f,  0.f,   1.4f, 1.15f, 0.f,  0.3f,  0.f,   0.f, 0.9f },
    { "Dreamy",         0.3f,  6000.f,  0.1f,  0.9f, 0.85f, 0.1f, 0.4f,  0.1f,  1.f, 3.f },
};
constexpr int kCustom = static_cast<int>(sizeof(kLooks) / sizeof(kLooks[0]));   // preset index "Custom"

static void ApplyLook(Settings& S, int I) {
    const Look& L = kLooks[I];
    S.Exposure = L.Exposure; S.Temp = L.Temp; S.Tint = L.Tint; S.Saturation = L.Saturation; S.Contrast = L.Contrast;
    S.Split = L.Split; S.Vignette = L.Vignette; S.Grain = L.Grain; S.Fringe = L.Fringe; S.Bloom = L.Bloom;
    S.Preset = I;
    S.Grade = true;
}

// ---------------------------------------------------------------- saved shots (CINECAM_shots\<name>.txt beside the exe)

static std::wstring ShotDir() {
    wchar_t Exe[MAX_PATH]{};
    GetModuleFileNameW(nullptr, Exe, MAX_PATH);
    std::wstring P(Exe);
    return P.substr(0, P.find_last_of(L"\\/") + 1) + L"CINECAM_shots\\";
}

static std::wstring Widen(const std::string& S) { return std::wstring(S.begin(), S.end()); }   // names are ASCII

struct Shot { std::string Name, Map; };
static std::vector<Shot> s_Shots;

static void RefreshShots() {
    s_Shots.clear();
    WIN32_FIND_DATAW F;
    HANDLE H = FindFirstFileW((ShotDir() + L"*.txt").c_str(), &F);
    if (H == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring N = F.cFileName;
        Shot S{ std::string(N.begin(), N.end() - 4), "" };
        if (FILE* Fp = _wfopen((ShotDir() + N).c_str(), L"r")) {
            char Map[128]{};
            if (fscanf(Fp, "map %127s", Map) == 1) S.Map = Map;
            fclose(Fp);
        }
        s_Shots.push_back(S);
    } while (FindNextFileW(H, &F));
    FindClose(H);
    std::sort(s_Shots.begin(), s_Shots.end(), [](const Shot& A, const Shot& B) { return A.Name < B.Name; });
}

static bool SaveShot(const std::string& Name) {
    CreateDirectoryW(ShotDir().c_str(), nullptr);
    FILE* Fp = _wfopen((ShotDir() + Widen(Name) + L".txt").c_str(), L"w");
    if (!Fp) return false;
    fprintf(Fp, "map %s\n", G.Map.empty() ? "unknown" : G.Map.c_str());
    fprintf(Fp, "space %d\n", G.KeySpace);
    for (const Key& K : G.Keys) {
        fprintf(Fp, "key %.4f", K.Time);
        for (int I = 0; I < PN; ++I) fprintf(Fp, " %.4f", K.P[I]);
        fprintf(Fp, " %d %.3f %d\n", K.Interp, K.Tension, K.Aim);
    }
    fclose(Fp);
    return true;
}

static bool LoadShot(const std::string& Name) {
    FILE* Fp = _wfopen((ShotDir() + Widen(Name) + L".txt").c_str(), L"r");
    if (!Fp) return false;
    std::vector<Key> Keys;
    int Space = 0;                                      // shots from before key spaces are world space
    char Line[512];
    while (fgets(Line, sizeof(Line), Fp)) {
        Key K;
        if (ParseKey(Line, K, G.S.Focus)) Keys.push_back(K);
        else sscanf_s(Line, "space %d", &Space);
    }
    fclose(Fp);
    if (Keys.empty()) return false;
    G.Keys = Keys;
    G.KeySpace = (std::clamp)(Space, 0, 2);
    G.S.KeysOnTarget = G.KeySpace > 0;                  // plays the way it was made
    return true;
}

// ---------------------------------------------------------------- widgets
// Inspector rows: label on the left, control on the right. Pages are foldable groups, advanced ones closed, and
// settings that do nothing right now (grading off, no shake...) are hidden rather than greyed, so a page only
// shows what matters. Right-click a slider to reset it.

static ImFont* s_FontHead = nullptr;               // small semibold, group titles
static ImFont* s_FontBig = nullptr;                // countdown digits
static const Settings kDef{};                       // defaults for right-click reset
constexpr float kLabelW = 128.f;
static const ImVec4 kAccent(0.96f, 0.64f, 0.24f, 1.f);
static const ImVec4 kAccentDim(0.80f, 0.50f, 0.17f, 1.f);
static const ImVec4 kGood(0.45f, 0.85f, 0.55f, 1.f);
static const ImVec4 kWarn(1.f, 0.62f, 0.32f, 1.f);

static void Tip(const char* Text) {
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_DelayShort)) ImGui::SetTooltip("%s", Text);
}

static void Push(CmdType T, int I = 0, float F = 0.f) { G.Cmds.push_back(Cmd{ T, I, F }); }

static void Hint(const char* Fmt, ...) {
    va_list A;
    va_start(A, Fmt);
    ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[ImGuiCol_TextDisabled]);
    ImGui::TextWrappedV(Fmt, A);
    ImGui::PopStyleColor();
    va_end(A);
}

static void Label(const char* L, const char* Help = nullptr) {
    ImGui::AlignTextToFramePadding();
    ImGui::TextUnformatted(L);
    if (Help) Tip(Help);
    ImGui::SameLine(kLabelW);
    ImGui::SetNextItemWidth(-FLT_MIN);
}

static bool Slider(const char* L, float* V, float Def, float Lo, float Hi, const char* Fmt, const char* Help, bool Log = false) {
    ImGui::PushID(L);
    Label(L, Help);
    bool Changed = ImGui::SliderFloat("##v", V, Lo, Hi, Fmt, Log ? ImGuiSliderFlags_Logarithmic : 0);
    if (ImGui::IsItemClicked(ImGuiMouseButton_Right)) { *V = Def; Changed = true; }
    char T[512];
    snprintf(T, sizeof(T), "%s%sRight-click to reset.", Help ? Help : "", Help ? "\n" : "");
    Tip(T);
    ImGui::PopID();
    return Changed;
}

// On / off switch at the right end of the row; the knob slides.
static bool Switch(const char* Id, bool* V) {
    const float Fh = ImGui::GetFrameHeight(), H = Fh * 0.74f, W = H * 1.8f;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - W);
    const ImVec2 P = ImGui::GetCursorScreenPos();
    const bool Changed = ImGui::InvisibleButton(Id, ImVec2(W, Fh));
    if (Changed) *V = !*V;
    ImGuiStorage* St = ImGui::GetStateStorage();
    const ImGuiID Key = ImGui::GetItemID();
    float T = St->GetFloat(Key, *V ? 1.f : 0.f);
    T += ((*V ? 1.f : 0.f) - T) * (std::min)(1.f, ImGui::GetIO().DeltaTime * 16.f);
    St->SetFloat(Key, T);
    const ImVec4 Off = ImGui::GetStyle().Colors[ImGui::IsItemHovered() ? ImGuiCol_FrameBgHovered : ImGuiCol_FrameBg];
    const ImVec4 Track(Off.x + (kAccentDim.x - Off.x) * T, Off.y + (kAccentDim.y - Off.y) * T, Off.z + (kAccentDim.z - Off.z) * T, 1.f);
    const float Y = P.y + (Fh - H) * 0.5f;
    ImDrawList* D = ImGui::GetWindowDrawList();
    D->AddRectFilled(ImVec2(P.x, Y), ImVec2(P.x + W, Y + H), ImGui::GetColorU32(Track), H * 0.5f);
    D->AddCircleFilled(ImVec2(P.x + H * 0.5f + (W - H) * T, Y + H * 0.5f), H * 0.5f - 2.5f, ImGui::GetColorU32(ImVec4(0.96f, 0.96f, 0.97f, 1.f)), 24);
    return Changed;
}

static bool Toggle(const char* L, bool* V, const char* Help) {
    ImGui::PushID(L);
    ImGui::AlignTextToFramePadding();
    ImGui::TextUnformatted(L);
    if (Help) Tip(Help);
    ImGui::SameLine();
    const bool Changed = Switch("##v", V);
    if (Help) Tip(Help);
    ImGui::PopID();
    return Changed;
}

static bool Choice(const char* L, int* V, const char* const* Names, int N, const char* Help) {
    ImGui::PushID(L);
    Label(L, Help);
    bool Changed = false;
    if (ImGui::BeginCombo("##v", Names[(std::clamp)(*V, 0, N - 1)])) {
        for (int I = 0; I < N; ++I)
            if (ImGui::Selectable(Names[I], I == *V)) { *V = I; Changed = true; }
        ImGui::EndCombo();
    }
    if (Help) Tip(Help);
    ImGui::PopID();
    return Changed;
}

// A foldable group: small muted title, chevron, hairline. Open / closed is kept per session.
static bool Group(const char* Title, bool DefaultOpen = true) {
    ImGui::PushID(Title);
    ImGui::Dummy(ImVec2(0.f, 6.f));
    ImGuiStorage* St = ImGui::GetStateStorage();
    const ImGuiID Id = ImGui::GetID("open");
    bool Open = St->GetBool(Id, DefaultOpen);
    const ImVec2 P = ImGui::GetCursorScreenPos();
    const float W = ImGui::GetContentRegionAvail().x, H = 22.f;
    if (ImGui::InvisibleButton("hdr", ImVec2(W, H))) { Open = !Open; St->SetBool(Id, Open); }
    const bool Hov = ImGui::IsItemHovered();
    ImDrawList* D = ImGui::GetWindowDrawList();
    const ImU32 C = ImGui::GetColorU32(Hov ? ImGuiCol_Text : ImGuiCol_TextDisabled);
    if (s_FontHead) ImGui::PushFont(s_FontHead);
    D->AddText(ImVec2(P.x, P.y + (H - ImGui::GetFontSize()) * 0.5f), C, Title);
    if (s_FontHead) ImGui::PopFont();
    const float Cx = P.x + W - 8.f, Cy = P.y + H * 0.5f, S = 3.5f;
    if (Open) { D->AddLine(ImVec2(Cx - S, Cy - S * 0.5f), ImVec2(Cx, Cy + S * 0.5f), C, 1.5f); D->AddLine(ImVec2(Cx, Cy + S * 0.5f), ImVec2(Cx + S, Cy - S * 0.5f), C, 1.5f); }
    else { D->AddLine(ImVec2(Cx - S * 0.5f, Cy - S), ImVec2(Cx + S * 0.5f, Cy), C, 1.5f); D->AddLine(ImVec2(Cx + S * 0.5f, Cy), ImVec2(Cx - S * 0.5f, Cy + S), C, 1.5f); }
    D->AddLine(ImVec2(P.x, P.y + H), ImVec2(P.x + W, P.y + H), IM_COL32(255, 255, 255, 14));
    ImGui::Dummy(ImVec2(0.f, 3.f));
    ImGui::PopID();
    return Open;
}

// Buttons side by side, the current one lit. Returns the clicked index or -1.
static int Segmented(const char* Id, const char* const* Names, int N, int Cur, float W = 0.f) {
    ImGui::PushID(Id);
    ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(2.f, 0.f));
    int Clicked = -1;
    for (int I = 0; I < N; ++I) {
        if (I) ImGui::SameLine();
        const bool On = I == Cur;
        if (On) {
            ImGui::PushStyleColor(ImGuiCol_Button, kAccentDim);
            ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.86f, 0.55f, 0.20f, 1.f));
            ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.f, 1.f, 1.f, 1.f));
        }
        if (ImGui::Button(Names[I], ImVec2(W, 0.f))) Clicked = I;
        if (On) ImGui::PopStyleColor(3);
    }
    ImGui::PopStyleVar();
    ImGui::PopID();
    return Clicked;
}

static bool Primary(const char* L, const ImVec2& Size = ImVec2(0.f, 0.f)) {
    ImGui::PushStyleColor(ImGuiCol_Button, kAccentDim);
    ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.86f, 0.55f, 0.20f, 1.f));
    ImGui::PushStyleColor(ImGuiCol_ButtonActive, kAccent);
    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(1.f, 1.f, 1.f, 1.f));
    const bool Clicked = ImGui::Button(L, Size);
    ImGui::PopStyleColor(4);
    return Clicked;
}

static void Divider() {                             // thin vertical rule between groups of controls on one line
    ImGui::SameLine(0.f, 10.f);
    const ImVec2 P = ImGui::GetCursorScreenPos();
    const float H = ImGui::GetFrameHeight();
    ImGui::GetWindowDrawList()->AddLine(ImVec2(P.x, P.y + 4.f), ImVec2(P.x, P.y + H - 4.f), IM_COL32(255, 255, 255, 30));
    ImGui::Dummy(ImVec2(1.f, H));
    ImGui::SameLine(0.f, 10.f);
}

// ---------------------------------------------------------------- top bar

static void SetMode(int Want) {                     // 0 off, 1 free, 2 tripod, 3 follow, 4 path
    const bool On = G.M != Mode::Off;
    switch (Want) {
    case 0: if (On) Push(CmdType::ToggleCam); break;
    case 1: Push(On ? CmdType::Free : CmdType::ToggleCam); break;
    case 2: if (!On) Push(CmdType::ToggleCam); Push(CmdType::Tripod); break;
    case 3: if (!On) Push(CmdType::ToggleCam); Push(CmdType::Follow); break;
    case 4:
        if (G.M == Mode::Path) { Push(CmdType::Stop); break; }
        if (G.Keys.size() < 2) break;
        if (!On) Push(CmdType::ToggleCam);
        Push(CmdType::Play);
        break;
    }
}

static void TopBar(Settings& S) {
    const ImVec2 Size = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos(ImVec2(Size.x * 0.5f, 12.f), ImGuiCond_Always, ImVec2(0.5f, 0.f));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(8.f, 7.f));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 10.f);
    ImGui::Begin("##cinebar", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize
        | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoFocusOnAppearing);
    static const char* Modes[] = { "Off", "Free", "Tripod", "Follow", "Path" };
    const int Cur = G.M == Mode::Off ? 0 : G.M == Mode::Free ? 1 : G.M == Mode::Tripod ? 2 : G.M == Mode::Follow ? 3 : 4;
    const int Click = Segmented("mode", Modes, 5, Cur, 62.f);
    if (Click >= 0 && Click != Cur) SetMode(Click);
    else if (Click == 4 && Cur == 4) SetMode(4);
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_DelayShort)) ImGui::SetTooltip("Path plays your keyframes (needs 2+). F8 toggles the camera.");

    Divider();
    static const char* Hud[] = { "Hide HUD" };
    if (Segmented("hud", Hud, 1, G.HudHidden ? 0 : -1) == 0) Push(CmdType::ToggleHud);
    Tip("Hide the game's HUD (F9).");
    ImGui::SameLine(0.f, 4.f);
    static const char* Gd[] = { "Guides" };
    if (Segmented("guides", Gd, 1, S.Guides ? 0 : -1) == 0) S.Guides = !S.Guides;
    Tip("Framing guides (G). They show in recordings: turn them off before you record.");
    ImGui::SameLine(0.f, 4.f);
    static ULONGLONG s_PhotoAt = 0;
    if (ImGui::Button("Photo")) { Push(CmdType::Photo, S.PhotoScale); s_PhotoAt = GetTickCount64(); }
    Tip("High-resolution screenshot without HUD or menu. Size: Camera > Photo.");

    Divider();
    ImGui::AlignTextToFramePadding();
    if (GetTickCount64() - s_PhotoAt < 3500) ImGui::TextColored(kGood, "Photo saved to Archon\\Saved\\Screenshots");
    else {
        char Info[128];
        int N = snprintf(Info, sizeof(Info), "%.0f mm", FovToMm(G.CamFov));
        if (fabsf(G.CamRoll) >= 0.5f) N += snprintf(Info + N, sizeof(Info) - N, "   roll %+.0f\xC2\xB0", G.CamRoll);
        if (S.Dof) N += snprintf(Info + N, sizeof(Info) - N, "   f/%.1f", S.Fstop);
        if (G.M == Mode::Path) snprintf(Info + N, sizeof(Info) - N, "   %.1f / %.1f s", G.PathT, PathLength(G.Keys));
        ImGui::TextDisabled("%s", Info);
        if (G.Dolly) { ImGui::SameLine(0.f, 10.f); ImGui::TextColored(kAccent, "DOLLY"); }
    }
    ImGui::End();
    ImGui::PopStyleVar(2);
}

// ---------------------------------------------------------------- pages

static void CameraPage(Settings& S) {
    if (Group("MOVEMENT")) {
        Slider("Move speed", &S.Speed, kDef.Speed, 25.f, 5000.f, "%.0f cm/s", "How fast WASD flies. Shift = 4x, Alt = 1/4.", true);
        Slider("Mouse look", &S.Look, kDef.Look, 0.05f, 10.f, "%.2f", "Mouse sensitivity while looking around.", true);
        Slider("Smoothing", &S.Smooth, kDef.Smooth, 0.f, 0.98f, "%.2f", "0 = camera follows instantly. Higher = slow, floaty, drone-like moves.");
    }
    if (Group("FRAMING")) {
        char Fmt[48];
        snprintf(Fmt, sizeof(Fmt), "%%.0f\xC2\xB0  \xC2\xB7  %.0f mm", FovToMm(S.Fov));
        Slider("Field of view", &S.Fov, kDef.Fov, 5.f, 120.f, Fmt, "Zoom. Low = telephoto close-up, high = wide angle. Mouse wheel changes it too.");
        Slider("Roll", &S.Roll, kDef.Roll, -90.f, 90.f, "%.0f\xC2\xB0", "Tilts the horizon (dutch angle). Z / X change it too.");
        const char* Shapes[std::size(kAspects)];
        for (size_t I = 0; I < std::size(kAspects); ++I) Shapes[I] = kAspects[I].Name;
        Choice("Frame shape", &S.Aspect, Shapes, static_cast<int>(std::size(kAspects)),
            "Black bars rendered by the game, so they are in the recording. For crop-later framing use Guides > Crop frames.");
    }
    if (Group("PHOTO", false)) {
        static const char* Scales[] = { "1x screen", "2x screen", "3x screen", "4x screen" };
        int Sc = S.PhotoScale - 1;
        if (Choice("Resolution", &Sc, Scales, 4, "Photo size as a multiple of your screen. 4x of 1440p is a 10K still; big ones take a moment.")) S.PhotoScale = Sc + 1;
        if (ImGui::Button("Take photo", ImVec2(-FLT_MIN, 0.f))) Push(CmdType::Photo, S.PhotoScale);
        Tip("High-resolution screenshot without HUD or this menu. Saved to Archon\\Saved\\Screenshots.");
    }
}

static void LensPage(Settings& S) {
    if (Group("FOCAL LENGTH")) {
        float Mm = FovToMm(S.Fov);
        if (Slider("Focal length", &Mm, FovToMm(kDef.Fov), 10.f, 300.f, "%.0f mm", "Full-frame equivalent. Same as field of view, in camera terms.", true))
            S.Fov = MmToFov(Mm);
        Label("Primes");
        static const int Primes[] = { 14, 24, 35, 50, 85, 135, 200 };
        ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(3.f, 0.f));
        const float Bw = (ImGui::GetContentRegionAvail().x - 3.f * (std::size(Primes) - 1)) / std::size(Primes);
        for (size_t I = 0; I < std::size(Primes); ++I) {
            if (I) ImGui::SameLine();
            char B[8];
            snprintf(B, sizeof(B), "%d", Primes[I]);
            const bool On = fabsf(FovToMm(S.Fov) - Primes[I]) < 0.5f;
            if (On) ImGui::PushStyleColor(ImGuiCol_Button, kAccentDim);
            if (ImGui::Button(B, ImVec2(Bw, 0.f))) S.Fov = MmToFov(static_cast<float>(Primes[I]));
            if (On) ImGui::PopStyleColor();
        }
        ImGui::PopStyleVar();
        Tip("14-24 wide and dramatic, 35-50 natural, 85-135 portrait close-ups, 200 long telephoto.");
        ImGui::BeginDisabled(G.M == Mode::Off || G.M == Mode::Path);
        if (ImGui::Button(G.Dolly ? "Stop dolly zoom" : "Dolly zoom", ImVec2(-FLT_MIN, 0.f))) Push(CmdType::Dolly);
        ImGui::EndDisabled();
        Tip("The 'Vertigo' effect: the target keeps its size while you fly toward or away from it and the background\n"
            "stretches or squashes. Aim at the target, start, then fly forward or back.");
    }
    if (Group("DEPTH OF FIELD")) {
        static const char* Dof[] = { "Off", "Manual focus", "Auto focus on target" };
        Choice("Focus", &S.Dof, Dof, 3, "Blurs what is out of focus, like a real camera lens.");
        if (S.Dof == 1) {
            Slider("Distance", &S.Focus, kDef.Focus, 0.5f, 200.f, "%.1f m", "How far away the sharp area is. Saved in keyframes, so paths can pull focus.", true);
            Label("");
            ImGui::BeginDisabled(G.M == Mode::Off);
            if (ImGui::Button(G.PickingFocus.load() ? "Click something in the world..." : "Pick focus point", ImVec2(-FLT_MIN, 0.f)))
                G.PickingFocus = !G.PickingFocus.load();
            ImGui::EndDisabled();
            Tip("Then click what should be sharp. Sets the distance to it.");
        }
        if (S.Dof) Slider("Aperture", &S.Fstop, kDef.Fstop, 0.7f, 32.f, "f/%.1f", "Lower = stronger background blur. f/1.4 is very blurry, f/16 almost none.", true);
    }
    if (Group("MOTION BLUR", false)) {
        Toggle("Override", &S.MotionBlurOn, "Off = the game's own motion blur.");
        if (S.MotionBlurOn) Slider("Amount", &S.MotionBlur, kDef.MotionBlur, 0.f, 1.f, "%.2f", "0 = crisp frames, 1 = heavy streaks on fast moves.");
    }
}

static void SubjectPage(Settings& S) {
    if (Group("TARGET")) {
        std::vector<std::string> Names = { "Me", "Nearest behemoth" };
        for (const std::string& N : G.Party) Names.push_back(N);
        std::vector<const char*> Ptrs;
        for (const std::string& N : Names) Ptrs.push_back(N.c_str());
        if (S.Target >= static_cast<int>(Ptrs.size())) S.Target = 0;
        Choice("Target", &S.Target, Ptrs.data(), static_cast<int>(Ptrs.size()),
            "What aiming, follow, auto focus and anchored paths use. Other players appear here when they are near.");
        if (!G.TargetName.empty() && G.TargetName != Ptrs[S.Target]) { ImGui::SetCursorPosX(kLabelW); Hint("%s", G.TargetName.c_str()); }
        Slider("Aim height", &S.AimZ, kDef.AimZ, -150.f, 600.f, "%.0f cm", "Raises the aim point above the target's middle. Behemoths often look better higher.");
        Toggle("Aim at target", &S.Track, "Tripod and path keep pointing at the target (Y). Follow always does.");
    }
    if (Group("PLACEMENT")) {
        Label("Position", "Where the target sits on screen while aiming. Thirds read more cinematic than dead centre.");
        static const char* Spots[] = { "Left third", "Centre", "Right third" };
        const int Cur = fabsf(S.FrameX + 1.f / 3.f) < 0.01f ? 0 : fabsf(S.FrameX) < 0.01f ? 1 : fabsf(S.FrameX - 1.f / 3.f) < 0.01f ? 2 : -1;
        const int Pick = Segmented("spots", Spots, 3, Cur, (ImGui::GetContentRegionAvail().x - 4.f) / 3.f);
        if (Pick >= 0) S.FrameX = (Pick - 1) / 3.f;
        Slider("Horizontal", &S.FrameX, kDef.FrameX, -1.f, 1.f, "%+.2f", "-1 left edge, 0 centre, +1 right edge.");
        Slider("Vertical", &S.FrameY, kDef.FrameY, -1.f, 1.f, "%+.2f", "-1 bottom edge, 0 centre, +1 top edge.");
    }
    if (Group("FOLLOW")) {
        ImGui::BeginDisabled(G.M == Mode::Off);
        if (ImGui::Button(G.M == Mode::Follow ? "Stop following" : "Follow target  (F)", ImVec2(-FLT_MIN, 0.f)))
            Push(G.M == Mode::Follow ? CmdType::Free : CmdType::Follow);
        ImGui::EndDisabled();
        Tip("The camera rides along at its current distance and keeps the target framed. You play while it follows.");
        Toggle("Turn with target", &S.FollowLocal, "On: stays behind / beside the target as it turns (chase cam). Off: fixed world offset (drone).\n"
            "Also turns anchored paths with the target.");
        Slider("Orbit", &S.Orbit, kDef.Orbit, -90.f, 90.f, "%.0f\xC2\xB0/s", "Tripod or follow: circles around the target. Negative goes the other way.");
    }
    if (Group("CAMERA SHAKE", false)) {
        const char* Shakes[std::size(kShakes)];
        for (size_t I = 0; I < std::size(kShakes); ++I) Shakes[I] = kShakes[I].Name;
        Choice("Style", &S.Shake, Shakes, static_cast<int>(std::size(kShakes)), "Adds organic movement in every mode, on top of keyframes.");
        if (S.Shake) {
            Slider("Amount", &S.ShakeAmt, kDef.ShakeAmt, 0.f, 5.f, "%.2f", nullptr);
            Slider("Speed", &S.ShakeFreq, kDef.ShakeFreq, 0.1f, 5.f, "%.2fx", nullptr, true);
        }
    }
}

static void LookPage(Settings& S) {
    if (Group("COLOUR GRADE")) {
        Toggle("Grade", &S.Grade, "Off = the game's own colours.");
        if (S.Grade) {
            const char* Names[kCustom + 1];
            for (int I = 0; I < kCustom; ++I) Names[I] = kLooks[I].Name;
            Names[kCustom] = "Custom";
            int P = (std::min)(S.Preset, kCustom);
            if (Choice("Preset", &P, Names, kCustom + 1, nullptr) && P < kCustom) ApplyLook(S, P);
            const Look& N = kLooks[0];
            bool Changed = false;
            Changed |= Slider("Exposure", &S.Exposure, N.Exposure, -3.f, 3.f, "%+.2f EV", "Brighter or darker.");
            Changed |= Slider("Temperature", &S.Temp, N.Temp, 2000.f, 12000.f, "%.0f K", "Lower = warmer (orange), higher = cooler (blue). 6500 = neutral.");
            Changed |= Slider("Tint", &S.Tint, N.Tint, -1.f, 1.f, "%+.2f", "Green (-) or magenta (+).");
            Changed |= Slider("Saturation", &S.Saturation, N.Saturation, 0.f, 2.f, "%.2f", "0 = black and white.");
            Changed |= Slider("Contrast", &S.Contrast, N.Contrast, 0.5f, 1.6f, "%.2f", nullptr);
            Changed |= Slider("Teal & orange", &S.Split, N.Split, 0.f, 1.f, "%.2f", "Blockbuster split toning: teal shadows, warm highlights.");
            if (Group("LENS EFFECTS", false)) {
                Changed |= Slider("Vignette", &S.Vignette, N.Vignette, 0.f, 1.f, "%.2f", "Darker corners.");
                Changed |= Slider("Film grain", &S.Grain, N.Grain, 0.f, 1.f, "%.2f", nullptr);
                Changed |= Slider("Aberration", &S.Fringe, N.Fringe, 0.f, 5.f, "%.2f", "Chromatic aberration: colour fringing at the edges, like a cheap lens.");
                Changed |= Slider("Bloom", &S.Bloom, N.Bloom, 0.f, 4.f, "%.2f", "Glow around bright lights.");
            }
            if (Changed) S.Preset = kCustom;
            ImGui::Dummy(ImVec2(0.f, 2.f));
            if (ImGui::Button("Reset to natural")) ApplyLook(S, 0);
        }
    }
    if (Group("WORLD LIGHT")) {
        Toggle("Change light", &S.Light, "Scales the map's own sun, sky and fog. Only you see it. Off puts the map back.");
        if (S.Light) {
            Slider("Sun", &S.SunMul, kDef.SunMul, 0.f, 4.f, "%.2fx", "Sun brightness.");
            float Sun[3] = { S.SunR, S.SunG, S.SunB };
            Label("Sun colour", "Multiplies the map's sun colour. White = unchanged. Warm orange for golden hour, blue for night.");
            if (ImGui::ColorEdit3("##suncol", Sun, ImGuiColorEditFlags_NoInputs)) { S.SunR = Sun[0]; S.SunG = Sun[1]; S.SunB = Sun[2]; }
            Slider("Sun turn", &S.SunYaw, kDef.SunYaw, -180.f, 180.f, "%+.0f\xC2\xB0", "Swings the sun around the sky: moves shadows. Can double up baked shadows.");
            Slider("Sun height", &S.SunPitch, kDef.SunPitch, -60.f, 60.f, "%+.0f\xC2\xB0", "Lower = long dramatic shadows. Can double up baked shadows.");
            Slider("Sky", &S.SkyMul, kDef.SkyMul, 0.f, 4.f, "%.2fx", "Fill light from the sky: lower = deeper shadows.");
            Slider("Fog", &S.FogMul, kDef.FogMul, 0.f, 8.f, "%.2fx", "Fog density: atmosphere and depth. 0 = clear air.");
            float Fog[3] = { S.FogR, S.FogG, S.FogB };
            Label("Fog colour", "Multiplies the map's fog colour.");
            if (ImGui::ColorEdit3("##fogcol", Fog, ImGuiColorEditFlags_NoInputs)) { S.FogR = Fog[0]; S.FogG = Fog[1]; S.FogB = Fog[2]; }
        }
    }
}

static void GuidesPage(Settings& S) {
    if (Group("OVERLAY")) {
        Toggle("Show guides", &S.Guides, "Draws the guides over the game, menu open or not (G in the free camera).\n"
            "They are part of the picture, so recordings catch them: hide them before you record.");
        Toggle("Hide while a path plays", &S.GuidesHideOnPlay, "So a recorded take is clean.");
        Slider("Line strength", &S.GOpacity, kDef.GOpacity, 0.05f, 1.f, "%.2f", nullptr);
    }
    if (Group("COMPOSITION")) {
        Toggle("Rule of thirds", &S.Thirds, "Put subjects and horizons on the lines or where they cross.");
        Toggle("Golden ratio", &S.GPhi, "Phi grid (0.382 / 0.618): a tighter, more classical cousin of thirds.");
        Toggle("Centre mark", &S.GCenter, "Small cross in the middle, for symmetric shots.");
        Toggle("Diagonals", &S.GDiagonals, "Corner-to-corner lines, for leading lines and dynamic angles.");
        Toggle("Safe areas", &S.GSafe, "Action safe (93%) and title safe (90%): keep text and key action inside.");
        Toggle("Horizon level", &S.GHorizon, "Level indicator for the camera's roll. Green when perfectly level.");
    }
    if (Group("CROP FRAMES", false)) {
        Hint("Record the full screen, crop in your editor. Grids fit the first ticked frame.");
        for (int I = 0; I < static_cast<int>(std::size(kCrops)); ++I) {
            if (I) ImGui::SameLine();
            ImGui::CheckboxFlags(kCrops[I].Name, &S.GCrop, 1 << I);
        }
        if (S.GCrop) Slider("Dim outside", &S.GCropMask, kDef.GCropMask, 0.f, 0.9f, "%.2f", "Darkens what the first ticked crop frame cuts off.");
        static const char* Apps[] = { "Off", kSocial[0].Name, kSocial[1].Name, kSocial[2].Name };
        Choice("App UI zones", &S.GSocial, Apps, 4, "Shades where the app's buttons, captions and top bar sit on a vertical video.\n"
            "Keep faces and text out of the shaded parts. Needs the 9:16 crop frame.");
        if (S.GSocial && !(S.GCrop & 1)) ImGui::TextColored(kWarn, "Tick the 9:16 crop frame to see the app zones.");
    }
}

static void PathPage(Settings& S) {
    const bool CamOn = G.M != Mode::Off, Playing = G.M == Mode::Path;
    const int N = static_cast<int>(G.Keys.size());
    const float Len = PathLength(G.Keys), Half = (ImGui::GetContentRegionAvail().x - ImGui::GetStyle().ItemSpacing.x) * 0.5f;
    ImGui::Dummy(ImVec2(0.f, 2.f));
    ImGui::BeginDisabled(!CamOn);
    if (Primary("Add keyframe   K", ImVec2(Half, 0.f))) Push(CmdType::AddKey);
    ImGui::EndDisabled();
    Tip("Adds the camera's current position, angle, zoom and roll.");
    ImGui::SameLine();
    ImGui::BeginDisabled(N < 2 && !Playing);
    if (ImGui::Button(Playing ? "Stop" : "Play   L", ImVec2(Half, 0.f))) Push(Playing ? CmdType::Stop : CmdType::Play);
    ImGui::EndDisabled();
    Tip("Plays the path. You can play your character while it runs.");
    if (!CamOn) Hint("Start the camera (F8), then fly to a spot and press K.");
    else if (N == 0) Hint("Fly to a spot and press K to add the first keyframe.");
    else Hint("%d keyframe%s  \xC2\xB7  %.1f s.  Select one on the timeline to shape the curve and set its angles.", N, N == 1 ? "" : "s", Len);

    if (Group("PLAYBACK")) {
        Toggle("Ease in and out", &S.Ease, "Starts and stops gently instead of at full speed.");
        Toggle("Loop", &S.Loop, nullptr);
        Toggle("Countdown", &S.Countdown, "3-2-1 on the first keyframe before the path moves: time to hit record and grab your controls.");
        Slider("Speed", &S.PlaySpeed, kDef.PlaySpeed, 0.1f, 4.f, "%.2fx", "Playback speed of the path only; the game runs at normal speed.", true);
    }
    if (Group("ANCHOR")) {
        Toggle("Ride with target", &S.KeysOnTarget,
            "On: the path moves with the target (Subject > Target), so a fly-around still frames a behemoth that walked off.\n"
            "With Subject > Turn with target it also turns with it. Off: keys stay where you put them in the world.");
        if (S.KeysOnTarget) Hint("Anchored to %s.", G.TargetName.empty() ? "the target" : G.TargetName.c_str());
    }
    if (N >= 2 && Group("TIMING")) {
        float Total = Len;
        Label("Length", "Drag to stretch or squeeze the whole path.");
        if (ImGui::DragFloat("##total", &Total, 0.1f, 0.5f, 600.f, "%.1f s") && Len > 0.f)
            for (Key& K : G.Keys) K.Time *= Total / Len;
        Label("");
        if (ImGui::Button("Even out speed", ImVec2(-FLT_MIN, 0.f))) EvenSpeed(G.Keys);
        Tip("Re-times the keyframes so the camera moves at a steady speed. Length stays the same.");
    }
    if (Group("SAVED SHOTS")) {
        static char Name[48] = "shot1";
        static std::string Status;
        static bool Listed = false;
        if (!Listed) { Listed = true; RefreshShots(); }
        ImGui::SetNextItemWidth(ImGui::GetContentRegionAvail().x - 80.f);
        ImGui::InputTextWithHint("##name", "Shot name", Name, sizeof(Name), ImGuiInputTextFlags_CallbackCharFilter,
            [](ImGuiInputTextCallbackData* D) { const ImWchar C = D->EventChar; return C < 128 && (isalnum(C) || C == '_' || C == '-') ? 0 : 1; });
        ImGui::SameLine();
        ImGui::BeginDisabled(G.Keys.empty() || !Name[0]);
        if (ImGui::Button("Save", ImVec2(-FLT_MIN, 0.f))) { Status = SaveShot(Name) ? std::string("Saved ") + Name : "Could not save"; RefreshShots(); }
        ImGui::EndDisabled();
        Tip("Saves the keyframes to CINECAM_shots beside the game, to replay or retake later.");
        if (!Status.empty()) Hint("%s", Status.c_str());
        if (s_Shots.empty()) Hint("No saved shots yet.");
        for (const Shot& Sh : s_Shots) {
            ImGui::PushID(Sh.Name.c_str());
            const bool Other = Sh.Map != G.Map && !G.Map.empty();
            if (ImGui::Selectable("##row", false, ImGuiSelectableFlags_AllowOverlap, ImVec2(0.f, ImGui::GetFrameHeight()))) {
                Status = LoadShot(Sh.Name) ? "Loaded " + Sh.Name : "Could not load " + Sh.Name;
                snprintf(Name, sizeof(Name), "%s", Sh.Name.c_str());
            }
            Tip(Other ? "Made on another map. Click to load." : "Click to load.");
            ImGui::SameLine(8.f);
            ImGui::AlignTextToFramePadding();
            ImGui::TextUnformatted(Sh.Name.c_str());
            if (Other) { ImGui::SameLine(); ImGui::TextColored(kWarn, "%s", Sh.Map.c_str()); }
            ImGui::SameLine(ImGui::GetWindowContentRegionMax().x - 24.f);
            if (ImGui::SmallButton("x")) { DeleteFileW((ShotDir() + Widen(Sh.Name) + L".txt").c_str()); RefreshShots(); ImGui::PopID(); break; }
            Tip("Delete this shot.");
            ImGui::PopID();
        }
    }
    if (Group("OPTIONS", false)) {
        Toggle("Show path in the world", &S.ShowPath, "Draws the path and numbered keyframes while the menu is open.");
        Toggle("Hide menu while playing", &S.HideMenuOnPlay, nullptr);
        Slider("New key gap", &S.Spacing, kDef.Spacing, 0.5f, 20.f, "%.1f s", "Time between the last keyframe and a newly added one.");
        ImGui::BeginDisabled(G.Keys.empty());
        if (ImGui::Button("Clear all keyframes", ImVec2(-FLT_MIN, 0.f))) ImGui::OpenPopup("Clear keyframes?");
        ImGui::EndDisabled();
    }
    if (ImGui::BeginPopupModal("Clear keyframes?", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::Text("Delete all %d keyframes?", N);
        ImGui::Dummy(ImVec2(0.f, 4.f));
        if (Primary("Delete", ImVec2(100, 0))) { G.Keys.clear(); ImGui::CloseCurrentPopup(); }
        ImGui::SameLine();
        if (ImGui::Button("Cancel", ImVec2(100, 0))) ImGui::CloseCurrentPopup();
        ImGui::EndPopup();
    }
}

static void Shortcuts() {
    static const char* Rows[][2] = {
        { "F8", "Camera on / off (from tripod, follow or path: back to free)" },
        { "F9", "Hide / show the HUD" }, { "F10", "This menu" },
        { "Right mouse", "Hold to look around while the menu is open" },
        { "W A S D", "Fly" }, { "E / Space", "Up" }, { "Q / Ctrl", "Down" },
        { "Shift / Alt", "Faster / slower" }, { "Mouse wheel", "Zoom" }, { "Z / X", "Roll" },
        { "R", "Reset zoom and roll" }, { "T", "Tripod: camera stays, you play" },
        { "F", "Follow: camera rides along with the target" },
        { "Y", "Aim at the target on / off" }, { "G", "Framing guides on / off" },
        { "K", "Add keyframe" }, { "J", "Remove last keyframe" }, { "L", "Play the path" },
        { "Timeline", "Drag keys to retime, drag the track to scrub, double-click a key to go there" },
    };
    Hint("In the free camera the game ignores your keys. Tripod, follow and path playback hand the controls back so you can act while the camera films.");
    ImGui::Dummy(ImVec2(0.f, 4.f));
    if (ImGui::BeginTable("hotkeys", 2, ImGuiTableFlags_SizingFixedFit)) {
        for (auto& R : Rows) {
            ImGui::TableNextRow();
            ImGui::TableNextColumn(); ImGui::TextColored(kAccent, "%s", R[0]);
            ImGui::TableNextColumn(); ImGui::TextUnformatted(R[1]);
        }
        ImGui::EndTable();
    }
}

// ---------------------------------------------------------------- timeline (bottom)

static int s_Sel = -1;                              // selected keyframe

static void SmallLabel(const char* T, float Gap = 14.f) {
    ImGui::SameLine(0.f, Gap);
    ImGui::AlignTextToFramePadding();
    ImGui::TextDisabled("%s", T);
    ImGui::SameLine(0.f, 6.f);
}

// The selected key, under the transport: how it moves and looks, its exact angles, and (folded) its position.
// Any edit puts the camera on the key so you see it; the path overlay redraws as you drag.
static void KeyInspector(int Index, bool CamOn) {
    Key& K = G.Keys[Index];
    bool Changed = false;
    auto Field = [&](const char* Id, float* V, float Speed, float Lo, float Hi, const char* Fmt, const char* Help) {
        ImGui::SameLine(0.f, 4.f);
        ImGui::SetNextItemWidth(86.f);
        Changed |= ImGui::DragFloat(Id, V, Speed, Lo, Hi, Fmt);
        if (Help) Tip(Help);
    };
    ImGui::AlignTextToFramePadding();
    ImGui::TextColored(kAccent, "KEY %d", Index + 1);
    SmallLabel("Move");
    ImGui::SetNextItemWidth(92.f);
    Changed |= ImGui::Combo("##interp", &K.Interp, kInterps, static_cast<int>(std::size(kInterps)));
    Tip("How the camera travels to the next key: smooth curve, straight line, or hold still then cut.");
    if (K.Interp == 0) {
        SmallLabel("Curve");
        ImGui::SetNextItemWidth(120.f);
        Changed |= ImGui::SliderFloat("##tension", &K.Tension, -1.f, 1.f, K.Tension < -0.05f ? "wide %.2f" : K.Tension > 0.05f ? "tight %.2f" : "natural");
        if (ImGui::IsItemClicked(ImGuiMouseButton_Right)) { K.Tension = 0.f; Changed = true; }
        Tip("How the path bends through this key. Wide = big sweeping arc, tight = sharp turn. Right-click = natural.");
    }
    if (K.Interp != 2) {
        SmallLabel("Look");
        ImGui::SetNextItemWidth(112.f);
        Changed |= ImGui::Combo("##aim", &K.Aim, kAims, static_cast<int>(std::size(kAims)));
        Tip("From this key to the next. Key angles: turns from this key's view to the next one's.\n"
            "Along path: faces where it is flying, like a drone. Subject > Aim at target overrides both.");
    }
    const ImGuiStyle& St = ImGui::GetStyle();
    const float Bw = ImGui::CalcTextSize("Go to").x + ImGui::CalcTextSize("Update").x + ImGui::CalcTextSize("Delete").x + St.FramePadding.x * 6.f + 8.f;
    ImGui::SameLine(ImGui::GetWindowContentRegionMax().x - Bw);
    ImGui::BeginDisabled(!CamOn);
    if (ImGui::Button("Go to")) Push(CmdType::GoToKey, Index);
    ImGui::SameLine(0.f, 4.f);
    if (ImGui::Button("Update")) Push(CmdType::UpdateKey, Index);
    Tip("Replace this key with the camera's current view.");
    ImGui::EndDisabled();
    ImGui::SameLine(0.f, 4.f);
    if (ImGui::Button("Delete")) { G.Keys.erase(G.Keys.begin() + Index); s_Sel = -1; return; }

    ImGui::AlignTextToFramePadding();
    ImGui::TextDisabled("Angle");
    ImGui::BeginDisabled(K.Aim == 1 && K.Interp != 2);
    Field("##yaw", &K.P[PYaw], 0.25f, -720.f, 720.f, "yaw %.1f\xC2\xB0", "Turn left / right. Drag, or Ctrl+click to type.");
    Field("##pitch", &K.P[PPitch], 0.25f, -89.f, 89.f, "pitch %.1f\xC2\xB0", "Tilt up / down.");
    ImGui::EndDisabled();
    Field("##roll", &K.P[PRoll], 0.25f, -90.f, 90.f, "roll %.1f\xC2\xB0", "Dutch angle.");
    Field("##fov", &K.P[PFov], 0.2f, 5.f, 120.f, "fov %.0f\xC2\xB0", "Zoom at this key.");
    static bool s_Pos = false;
    ImGui::SameLine(0.f, 14.f);
    static const char* PosLbl[] = { "Position" };
    if (Segmented("pos", PosLbl, 1, s_Pos ? 0 : -1) == 0) s_Pos = !s_Pos;
    Tip(G.KeySpace ? "Exact offset from the target, in cm." : "Exact position in the world, in cm.");
    if (s_Pos) {
        Field("##x", &K.P[PX], 2.f, -1e6f, 1e6f, "x %.0f", nullptr);
        Field("##y", &K.P[PY], 2.f, -1e6f, 1e6f, "y %.0f", nullptr);
        Field("##z", &K.P[PZ], 2.f, -1e6f, 1e6f, "z %.0f", "Height.");
    }
    if (Changed && CamOn) Push(CmdType::GoToKey, Index);
}

static void Timeline(Settings& S) {
    (void)S;
    const ImVec2 Size = ImGui::GetIO().DisplaySize;
    const float W = (std::min)(Size.x - 64.f, 1400.f);
    ImGui::SetNextWindowPos(ImVec2(Size.x * 0.5f, Size.y - 20.f), ImGuiCond_Always, ImVec2(0.5f, 1.f));
    ImGui::SetNextWindowSize(ImVec2(W, 0.f));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(12.f, 10.f));
    ImGui::Begin("##timeline", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoMove
        | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_AlwaysAutoResize);
    ImGui::PopStyleVar();
    std::vector<Key>& Keys = G.Keys;
    const int N = static_cast<int>(Keys.size());
    const bool CamOn = G.M != Mode::Off, Playing = G.M == Mode::Path, CanPlay = N >= 2;
    const float Len = PathLength(Keys);
    if (s_Sel >= N) s_Sel = -1;

    // transport
    ImGui::BeginDisabled(!CamOn || !CanPlay);
    if (ImGui::Button("|<", ImVec2(32, 0))) Push(CmdType::Preview, 0, Keys.front().Time);
    Tip("Jump to the start.");
    ImGui::SameLine(0.f, 3.f);
    if (Playing ? ImGui::Button("Stop", ImVec2(68, 0)) : Primary("Play", ImVec2(68, 0))) Push(Playing ? CmdType::Stop : CmdType::Play);
    Tip("Play the path (L). You can play your character while it runs.");
    ImGui::SameLine(0.f, 3.f);
    if (ImGui::Button(">|", ImVec2(32, 0))) Push(CmdType::Preview, 0, Len);
    Tip("Jump to the end.");
    ImGui::EndDisabled();
    ImGui::SameLine(0.f, 14.f);
    ImGui::AlignTextToFramePadding();
    ImGui::TextDisabled("%.1f / %.1f s", CanPlay ? G.PathT : 0.f, Len);
    const float Kw = ImGui::CalcTextSize("+ Key").x + ImGui::GetStyle().FramePadding.x * 2.f;
    ImGui::SameLine(ImGui::GetWindowContentRegionMax().x - Kw);
    ImGui::BeginDisabled(!CamOn);
    if (ImGui::Button("+ Key")) Push(CmdType::AddKey);
    ImGui::EndDisabled();
    Tip("Add a keyframe at the camera's current view (K).");

    // track
    const float H = 46.f, Pad = 10.f;
    const ImVec2 P0 = ImGui::GetCursorScreenPos();
    const float Tw = ImGui::GetContentRegionAvail().x;
    ImGui::InvisibleButton("track", ImVec2(Tw, H));
    const bool Hover = ImGui::IsItemHovered();
    const float Span = (std::max)(Len, 5.f) * 1.05f;
    auto Xof = [&](float T) { return P0.x + Pad + (Tw - 2.f * Pad) * T / Span; };
    auto Tof = [&](float X) { return (std::clamp)((X - P0.x - Pad) / (Tw - 2.f * Pad) * Span, 0.f, 600.f); };
    const float Mid = P0.y + H * 0.64f;
    ImDrawList* D = ImGui::GetWindowDrawList();
    D->AddRectFilled(P0, ImVec2(P0.x + Tw, P0.y + H), IM_COL32(255, 255, 255, 8), 6.f);
    static const float Steps[] = { 0.5f, 1.f, 2.f, 5.f, 10.f, 15.f, 30.f, 60.f };
    float Step = Steps[std::size(Steps) - 1];
    for (float St : Steps) if ((Tw - 2.f * Pad) * St / Span >= 70.f) { Step = St; break; }
    for (float T = 0.f; T <= Span; T += Step) {
        const float X = Xof(T);
        D->AddLine(ImVec2(X, P0.y + 3.f), ImVec2(X, P0.y + 8.f), IM_COL32(255, 255, 255, 50));
        char L[16];
        snprintf(L, sizeof(L), "%gs", T);
        D->AddText(ImVec2(X + 3.f, P0.y + 1.f), IM_COL32(255, 255, 255, 70), L);
    }
    D->AddLine(ImVec2(P0.x + Pad, Mid), ImVec2(P0.x + Tw - Pad, Mid), IM_COL32(255, 255, 255, 16), 1.f);
    for (int I = 0; I + 1 < N; ++I) {                   // segments, coloured by how they move
        const ImU32 C = Keys[I].Interp == 1 ? IM_COL32(110, 170, 255, 200) : Keys[I].Interp == 2 ? IM_COL32(150, 150, 160, 140) : IM_COL32(242, 168, 66, 200);
        D->AddLine(ImVec2(Xof(Keys[I].Time), Mid), ImVec2(Xof(Keys[I + 1].Time), Mid), C, Keys[I].Interp == 2 ? 1.f : 2.5f);
    }
    const ImVec2 M = ImGui::GetIO().MousePos;
    int Under = -1;
    for (int I = 0; I < N; ++I) if (fabsf(M.x - Xof(Keys[I].Time)) < 8.f && fabsf(M.y - Mid) < 12.f) Under = I;
    for (int I = 0; I < N; ++I) {
        const float X = Xof(Keys[I].Time), R = I == Under || I == s_Sel ? 7.5f : 6.5f;
        const ImVec2 Q[4] = { ImVec2(X, Mid - R), ImVec2(X + R, Mid), ImVec2(X, Mid + R), ImVec2(X - R, Mid) };
        D->AddConvexPolyFilled(Q, 4, I == s_Sel ? IM_COL32(245, 165, 60, 255) : IM_COL32(24, 24, 28, 255));
        D->AddPolyline(Q, 4, IM_COL32(245, 165, 60, 255), ImDrawFlags_Closed, 1.5f);
    }
    if (CanPlay) {
        const float X = Xof(G.PathT);
        D->AddLine(ImVec2(X, P0.y), ImVec2(X, P0.y + H), IM_COL32(255, 255, 255, 220), 1.5f);
        D->AddTriangleFilled(ImVec2(X - 5.f, P0.y), ImVec2(X + 5.f, P0.y), ImVec2(X, P0.y + 7.f), IM_COL32(255, 255, 255, 220));
    }
    if (N == 0) D->AddText(ImVec2(P0.x + Pad, Mid - 8.f), IM_COL32(255, 255, 255, 100), "No keyframes yet. Fly to a spot and press K.");

    // drag a key to retime it, drag empty track to scrub, double-click a key to go to it
    static int s_Drag = -1;
    if (ImGui::IsItemActivated()) { s_Drag = Under; if (Under >= 0) s_Sel = Under; else if (Hover) s_Sel = -1; }
    if (ImGui::IsItemActive()) {
        if (s_Drag >= 0 && s_Drag < N) Keys[s_Drag].Time = Tof(M.x);
        else if (CamOn && CanPlay) Push(CmdType::Preview, 0, (std::min)(Tof(M.x), Len));
    }
    if (ImGui::IsItemDeactivated() && s_Drag >= 0 && s_Drag < N) {
        const Key Moved = Keys[s_Drag];
        std::stable_sort(Keys.begin(), Keys.end(), [](const Key& A, const Key& B) { return A.Time < B.Time; });
        for (int I = 0; I < N; ++I) if (Keys[I].Time == Moved.Time && Keys[I].P[PX] == Moved.P[PX]) s_Sel = I;
        s_Drag = -1;
    }
    if (Hover && Under >= 0 && ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left) && CamOn) Push(CmdType::GoToKey, Under);
    if (Hover && Under >= 0) ImGui::SetTooltip("Key %d  \xC2\xB7  %.2f s\nDrag to retime, double-click to go to it.", Under + 1, Keys[Under].Time);
    if (s_Sel >= 0 && ImGui::IsWindowFocused() && !ImGui::GetIO().WantTextInput && ImGui::IsKeyPressed(ImGuiKey_Delete)) { Keys.erase(Keys.begin() + s_Sel); s_Sel = -1; }

    if (s_Sel >= 0 && s_Sel < static_cast<int>(Keys.size())) {
        ImGui::Dummy(ImVec2(0.f, 2.f));
        KeyInspector(s_Sel, CamOn);
    }
    ImGui::End();
}

static void Countdown(int N) {
    ImDrawList* D = ImGui::GetForegroundDrawList();
    const ImVec2 Size = ImGui::GetIO().DisplaySize, C(Size.x * 0.5f, Size.y * 0.5f);
    ImFont* F = s_FontBig ? s_FontBig : ImGui::GetFont();
    char T[4];
    snprintf(T, sizeof(T), "%d", N);
    const ImVec2 Ts = F->CalcTextSizeA(F->FontSize, FLT_MAX, 0.f, T);
    D->AddCircleFilled(C, F->FontSize * 0.62f, IM_COL32(10, 10, 12, 150), 64);
    D->AddCircle(C, F->FontSize * 0.62f, IM_COL32(245, 165, 60, 230), 64, 3.f);
    D->AddText(F, F->FontSize, ImVec2(C.x - Ts.x * 0.5f, C.y - Ts.y * 0.5f), IM_COL32(255, 255, 255, 240), T);
}

// Pick focus: the next click outside the menu, sent as a screen position for the game thread to trace.
static void FocusPicker() {
    if (!G.PickingFocus.load()) return;
    const ImGuiIO& Io = ImGui::GetIO();
    ImGui::GetForegroundDrawList()->AddText(ImVec2(Io.MousePos.x + 18.f, Io.MousePos.y + 14.f), IM_COL32(245, 165, 60, 255),
        "Click to focus  (Esc cancels)");
    if (ImGui::IsKeyPressed(ImGuiKey_Escape)) G.PickingFocus = false;
    else if (ImGui::IsMouseClicked(ImGuiMouseButton_Left) && !Io.WantCaptureMouse) {
        Push(CmdType::PickFocus, static_cast<int>(Io.MousePos.x), Io.MousePos.y);
        G.PickingFocus = false;
        G.S.Dof = 1;
    }
}

static void DrawMenu() {
    Settings& S = G.S;
    TopBar(S);
    Timeline(S);
    FocusPicker();
    ImGui::SetNextWindowPos(ImVec2(32, 84), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSize(ImVec2(540, 620), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSizeConstraints(ImVec2(440.f, 320.f), ImVec2(FLT_MAX, FLT_MAX));
    if (!ImGui::Begin("Cinematic Camera", nullptr, ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoScrollbar)) {
        ImGui::End();
        return;
    }

    // header: title, mode, help, close
    static const char* ModeNames[] = { "Off", "Free", "Tripod", "Path", "Follow" };
    if (s_FontHead) ImGui::PushFont(s_FontHead);
    ImGui::AlignTextToFramePadding();
    ImGui::TextUnformatted("CINEMATIC CAMERA");
    if (s_FontHead) ImGui::PopFont();
    ImGui::SameLine(0.f, 10.f);
    {
        const ImVec2 P = ImGui::GetCursorScreenPos();
        const float Fh = ImGui::GetFrameHeight();
        ImGui::GetWindowDrawList()->AddCircleFilled(ImVec2(P.x + 4.f, P.y + Fh * 0.5f), 3.5f,
            G.M == Mode::Off ? IM_COL32(110, 110, 118, 255) : IM_COL32(245, 165, 60, 255));
        ImGui::Dummy(ImVec2(10.f, Fh));
        ImGui::SameLine(0.f, 2.f);
        ImGui::AlignTextToFramePadding();
        ImGui::TextDisabled("%s", ModeNames[static_cast<int>(G.M)]);
    }
    const float Bw = ImGui::GetFrameHeight();
    ImGui::SameLine(ImGui::GetWindowContentRegionMax().x - Bw * 2.f - 4.f);
    if (ImGui::Button("?", ImVec2(Bw, Bw))) ImGui::OpenPopup("Shortcuts");
    Tip("Keyboard shortcuts");
    ImGui::SameLine(0.f, 4.f);
    if (ImGui::Button("x", ImVec2(Bw, Bw))) G.MenuOpen = false;
    Tip("Close (F10)");
    ImGui::SetNextWindowSize(ImVec2(520.f, 0.f));
    if (ImGui::BeginPopup("Shortcuts")) { Shortcuts(); ImGui::EndPopup(); }
    {
        const ImVec2 P = ImGui::GetCursorScreenPos();
        ImGui::GetWindowDrawList()->AddLine(ImVec2(P.x, P.y + 2.f), ImVec2(P.x + ImGui::GetContentRegionAvail().x, P.y + 2.f), IM_COL32(255, 255, 255, 16));
        ImGui::Dummy(ImVec2(0.f, 6.f));
    }

    // nav + page
    static const char* Pages[] = { "Camera", "Lens", "Subject", "Look", "Path", "Guides" };
    static int s_Page = 0;
    ImGui::BeginChild("nav", ImVec2(104.f, 0.f), ImGuiChildFlags_None);
    for (int I = 0; I < static_cast<int>(std::size(Pages)); ++I) {
        const bool On = I == s_Page;
        const ImVec2 P = ImGui::GetCursorScreenPos();
        ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyle().Colors[On ? ImGuiCol_Text : ImGuiCol_TextDisabled]);
        ImGui::PushStyleColor(ImGuiCol_Header, ImVec4(1.f, 1.f, 1.f, 0.05f));
        if (ImGui::Selectable(Pages[I], On, 0, ImVec2(0.f, 30.f))) s_Page = I;
        ImGui::PopStyleColor(2);
        if (On) ImGui::GetWindowDrawList()->AddRectFilled(ImVec2(P.x, P.y + 7.f), ImVec2(P.x + 3.f, P.y + 23.f), IM_COL32(245, 165, 60, 255), 2.f);
    }
    ImGui::EndChild();
    ImGui::SameLine(0.f, 14.f);
    ImGui::BeginChild("page", ImVec2(0.f, 0.f), ImGuiChildFlags_None);
    ImGui::PushItemWidth(-FLT_MIN);
    switch (s_Page) {
    case 0: CameraPage(S); break;
    case 1: LensPage(S); break;
    case 2: SubjectPage(S); break;
    case 3: LookPage(S); break;
    case 4: PathPage(S); break;
    default: GuidesPage(S); break;
    }
    ImGui::PopItemWidth();
    ImGui::Dummy(ImVec2(0.f, 8.f));
    ImGui::EndChild();
    ImGui::End();
}

// ---------------------------------------------------------------- overlay

// Lines get a 1 px dark shadow so they read on snow and on night maps alike.
static void GLine(ImDrawList* D, ImVec2 A, ImVec2 B, ImU32 C, float Th = 1.f) {
    const ImU32 Sh = IM_COL32(0, 0, 0, (C >> IM_COL32_A_SHIFT & 0xFF) / 2);
    D->AddLine(ImVec2(A.x + 1.f, A.y + 1.f), ImVec2(B.x + 1.f, B.y + 1.f), Sh, Th);
    D->AddLine(A, B, C, Th);
}

static void GRect(ImDrawList* D, const Rect& R, ImU32 C, float Th = 1.f) {
    D->AddRect(ImVec2(R.X + 1.f, R.Y + 1.f), ImVec2(R.X + R.W + 1.f, R.Y + R.H + 1.f), IM_COL32(0, 0, 0, (C >> IM_COL32_A_SHIFT & 0xFF) / 2), 0.f, 0, Th);
    D->AddRect(ImVec2(R.X, R.Y), ImVec2(R.X + R.W, R.Y + R.H), C, 0.f, 0, Th);
}

static void Shade(ImDrawList* D, float X0, float Y0, float X1, float Y1, ImU32 C) {
    if (X1 > X0 && Y1 > Y0) D->AddRectFilled(ImVec2(X0, Y0), ImVec2(X1, Y1), C);
}

// Darkens Outer minus Inner.
static void ShadeOutside(ImDrawList* D, const Rect& Outer, const Rect& In, ImU32 C) {
    const float Ox1 = Outer.X + Outer.W, Oy1 = Outer.Y + Outer.H, Ix1 = In.X + In.W, Iy1 = In.Y + In.H;
    Shade(D, Outer.X, Outer.Y, Ox1, In.Y, C);
    Shade(D, Outer.X, Iy1, Ox1, Oy1, C);
    Shade(D, Outer.X, In.Y, In.X, Iy1, C);
    Shade(D, Ix1, In.Y, Ox1, Iy1, C);
}

static Rect Inset(const Rect& R, float Keep) {     // centred, Keep = fraction of each side kept
    return Rect{ R.X + R.W * (1.f - Keep) * 0.5f, R.Y + R.H * (1.f - Keep) * 0.5f, R.W * Keep, R.H * Keep };
}

static void DrawGuides(ImDrawList* D, const Settings& S) {
    const ImVec2 Size = ImGui::GetIO().DisplaySize;
    const int A = static_cast<int>(255.f * S.GOpacity);
    const ImU32 Line = IM_COL32(255, 255, 255, A), Gold = IM_COL32(255, 200, 90, A), Dim = IM_COL32(255, 255, 255, A * 2 / 3);
    const Rect Frame = FitRect(Size.x, Size.y, kAspects[S.Aspect].Ratio);   // inside the game's own bars

    Rect Grid = Frame, Vert{};
    bool First = true, HaveVert = false;
    for (int I = 0; I < static_cast<int>(std::size(kCrops)); ++I) {
        if (!(S.GCrop & (1 << I))) continue;
        Rect R = FitRect(Frame.W, Frame.H, kCrops[I].Ratio);
        R.X += Frame.X; R.Y += Frame.Y;
        const bool Main = First;
        if (First) {
            First = false;
            Grid = R;
            ShadeOutside(D, Frame, R, IM_COL32(0, 0, 0, static_cast<int>(255.f * S.GCropMask)));
        }
        if (I == 0) { Vert = R; HaveVert = true; }
        GRect(D, R, Main ? Line : Dim, 1.5f);
        D->AddText(ImVec2(R.X + 6.f, R.Y + 4.f), Dim, kCrops[I].Name);
    }

    if (S.GSocial > 0 && HaveVert) {
        const Social& So = kSocial[S.GSocial - 1];
        const Rect Safe{ Vert.X + Vert.W * So.L, Vert.Y + Vert.H * So.T, Vert.W * (So.R - So.L), Vert.H * (So.B - So.T) };
        ShadeOutside(D, Vert, Safe, IM_COL32(255, 70, 70, A / 4));
        GRect(D, Safe, IM_COL32(255, 120, 120, A));
        D->AddText(ImVec2(Safe.X + 6.f, Safe.Y + 4.f), IM_COL32(255, 150, 150, A), So.Name);
    }

    const float X0 = Grid.X, Y0 = Grid.Y, W = Grid.W, H = Grid.H;
    if (S.Thirds)
        for (int I = 1; I < 3; ++I) {
            GLine(D, ImVec2(X0 + W * I / 3.f, Y0), ImVec2(X0 + W * I / 3.f, Y0 + H), Line);
            GLine(D, ImVec2(X0, Y0 + H * I / 3.f), ImVec2(X0 + W, Y0 + H * I / 3.f), Line);
        }
    if (S.GPhi)
        for (float F : { 0.382f, 0.618f }) {
            GLine(D, ImVec2(X0 + W * F, Y0), ImVec2(X0 + W * F, Y0 + H), Gold);
            GLine(D, ImVec2(X0, Y0 + H * F), ImVec2(X0 + W, Y0 + H * F), Gold);
        }
    if (S.GDiagonals) {
        GLine(D, ImVec2(X0, Y0), ImVec2(X0 + W, Y0 + H), Dim);
        GLine(D, ImVec2(X0 + W, Y0), ImVec2(X0, Y0 + H), Dim);
    }
    if (S.GSafe) {
        GRect(D, Inset(Grid, 0.93f), Dim);
        GRect(D, Inset(Grid, 0.90f), Line);
    }
    const ImVec2 C(X0 + W * 0.5f, Y0 + H * 0.5f);
    if (S.GCenter) {
        GLine(D, ImVec2(C.x - 12.f, C.y), ImVec2(C.x + 12.f, C.y), Line, 1.5f);
        GLine(D, ImVec2(C.x, C.y - 12.f), ImVec2(C.x, C.y + 12.f), Line, 1.5f);
    }
    if (S.GHorizon) {
        // fixed level ticks either side, a bar that tilts with the camera's roll between them
        const float R = W * 0.12f, Rad = -G.CamRoll * 3.14159265f / 180.f;
        const bool Level = fabsf(G.CamRoll) < 0.5f;
        const ImU32 Bar = Level ? IM_COL32(110, 230, 140, (std::max)(A, 160)) : IM_COL32(255, 170, 70, (std::max)(A, 160));
        GLine(D, ImVec2(C.x - R - 26.f, C.y), ImVec2(C.x - R - 8.f, C.y), Line, 2.f);
        GLine(D, ImVec2(C.x + R + 8.f, C.y), ImVec2(C.x + R + 26.f, C.y), Line, 2.f);
        GLine(D, ImVec2(C.x - R * cosf(Rad), C.y - R * sinf(Rad)), ImVec2(C.x + R * cosf(Rad), C.y + R * sinf(Rad)), Bar, 2.f);
        if (!Level) {
            char T[16];
            snprintf(T, sizeof(T), "%+.1f\xC2\xB0", G.CamRoll);
            D->AddText(ImVec2(C.x + R + 32.f, C.y - 8.f), Bar, T);
        }
    }
}

// Shown with the menu closed while guides are up: a reminder they will be in the recording.
static void GuidesPill() {
    ImDrawList* D = ImGui::GetForegroundDrawList();
    const char* T = "GUIDES ON";
    const ImVec2 Ts = ImGui::CalcTextSize(T), P(16.f, 16.f);
    D->AddRectFilled(P, ImVec2(P.x + Ts.x + 30.f, P.y + Ts.y + 10.f), IM_COL32(15, 15, 18, 190), 99.f);
    D->AddCircleFilled(ImVec2(P.x + 12.f, P.y + Ts.y * 0.5f + 5.f), 4.f, IM_COL32(245, 165, 60, 255));
    D->AddText(ImVec2(P.x + 22.f, P.y + 5.f), IM_COL32(235, 235, 240, 255), T);
}

// Path line and numbered keyframes, under the menu.
static void DrawPath(ImDrawList* D) {
    if (!G.S.ShowPath || G.M == Mode::Path) return;
    for (size_t I = 1; I < G.PathPts.size(); ++I) {
        const Point& A = G.PathPts[I - 1], & B = G.PathPts[I];
        if (A.On && B.On) D->AddLine(ImVec2(A.X, A.Y), ImVec2(B.X, B.Y), IM_COL32(242, 168, 66, 200), 2.f);
    }
    for (size_t I = 0; I < G.KeyPts.size(); ++I) {
        const Point& P = G.KeyPts[I];
        if (!P.On) continue;
        const bool Sel = static_cast<int>(I) == s_Sel;  // the key open in the timeline inspector
        D->AddCircleFilled(ImVec2(P.X, P.Y), Sel ? 13.f : 11.f, Sel ? IM_COL32(245, 165, 60, 240) : IM_COL32(20, 20, 20, 220));
        D->AddCircle(ImVec2(P.X, P.Y), Sel ? 13.f : 11.f, IM_COL32(242, 168, 66, 255), 0, 2.f);
        char N[8];
        snprintf(N, sizeof(N), "%d", static_cast<int>(I + 1));
        const ImVec2 Ts = ImGui::CalcTextSize(N);
        D->AddText(ImVec2(P.X - Ts.x * 0.5f, P.Y - Ts.y * 0.5f), IM_COL32(255, 255, 255, 255), N);
    }
}

static void ApplyStyle() {
    ImGuiStyle& St = ImGui::GetStyle();
    ImGui::StyleColorsDark();
    // graphite surfaces, one amber accent for "on" and "selected" only
    St.WindowRounding = 10.f; St.ChildRounding = 6.f; St.FrameRounding = 5.f; St.GrabRounding = 4.f;
    St.TabRounding = 5.f; St.PopupRounding = 8.f; St.ScrollbarRounding = 6.f;
    St.WindowPadding = ImVec2(16, 14); St.FramePadding = ImVec2(9, 5); St.ItemSpacing = ImVec2(8, 7);
    St.ItemInnerSpacing = ImVec2(6, 6); St.ScrollbarSize = 8.f; St.GrabMinSize = 8.f;
    St.WindowBorderSize = 1.f; St.ChildBorderSize = 0.f; St.PopupBorderSize = 1.f; St.FrameBorderSize = 0.f;
    St.WindowTitleAlign = ImVec2(0.f, 0.5f); St.SelectableTextAlign = ImVec2(0.f, 0.5f);
    St.DisabledAlpha = 0.45f;
    ImVec4* C = St.Colors;
    const ImVec4 Accent = kAccent, AccentDim = kAccentDim;
    C[ImGuiCol_Text] = ImVec4(0.91f, 0.91f, 0.93f, 1.f);
    C[ImGuiCol_TextDisabled] = ImVec4(0.50f, 0.51f, 0.55f, 1.f);
    C[ImGuiCol_WindowBg] = ImVec4(0.067f, 0.07f, 0.078f, 0.97f);
    C[ImGuiCol_ChildBg] = ImVec4(0.f, 0.f, 0.f, 0.f);
    C[ImGuiCol_PopupBg] = ImVec4(0.085f, 0.088f, 0.097f, 0.99f);
    C[ImGuiCol_Border] = ImVec4(1.f, 1.f, 1.f, 0.06f);
    C[ImGuiCol_TitleBg] = C[ImGuiCol_TitleBgActive] = C[ImGuiCol_TitleBgCollapsed] = ImVec4(0.067f, 0.07f, 0.078f, 1.f);
    C[ImGuiCol_FrameBg] = ImVec4(0.125f, 0.13f, 0.145f, 1.f);
    C[ImGuiCol_FrameBgHovered] = ImVec4(0.165f, 0.17f, 0.19f, 1.f);
    C[ImGuiCol_FrameBgActive] = ImVec4(0.195f, 0.2f, 0.225f, 1.f);
    C[ImGuiCol_SliderGrab] = AccentDim; C[ImGuiCol_SliderGrabActive] = Accent; C[ImGuiCol_CheckMark] = Accent;
    C[ImGuiCol_Button] = ImVec4(0.13f, 0.135f, 0.15f, 1.f);
    C[ImGuiCol_ButtonHovered] = ImVec4(0.18f, 0.185f, 0.205f, 1.f); C[ImGuiCol_ButtonActive] = ImVec4(0.22f, 0.225f, 0.25f, 1.f);
    C[ImGuiCol_Header] = ImVec4(1.f, 1.f, 1.f, 0.05f);
    C[ImGuiCol_HeaderHovered] = ImVec4(1.f, 1.f, 1.f, 0.07f); C[ImGuiCol_HeaderActive] = ImVec4(1.f, 1.f, 1.f, 0.10f);
    C[ImGuiCol_Separator] = ImVec4(1.f, 1.f, 1.f, 0.06f);
    C[ImGuiCol_ScrollbarBg] = ImVec4(0.f, 0.f, 0.f, 0.f);
    C[ImGuiCol_ScrollbarGrab] = ImVec4(1.f, 1.f, 1.f, 0.10f);
    C[ImGuiCol_ScrollbarGrabHovered] = ImVec4(1.f, 1.f, 1.f, 0.16f); C[ImGuiCol_ScrollbarGrabActive] = ImVec4(1.f, 1.f, 1.f, 0.22f);
    C[ImGuiCol_TableRowBgAlt] = ImVec4(1.f, 1.f, 1.f, 0.025f);
    C[ImGuiCol_ResizeGrip] = ImVec4(0.f, 0.f, 0.f, 0.f);
    C[ImGuiCol_ResizeGripHovered] = AccentDim; C[ImGuiCol_ResizeGripActive] = Accent;
}

// ---------------------------------------------------------------- D3D11 / window hooks

using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using ResizeFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
static PresentFn s_OrigPresent = nullptr;
static ResizeFn s_OrigResize = nullptr;
static IDXGISwapChain* s_Sc = nullptr;
static ID3D11Device* s_Dev = nullptr;
static ID3D11DeviceContext* s_Ctx = nullptr;
static ID3D11RenderTargetView* s_Rtv = nullptr;
static HWND s_Hwnd = nullptr;
static WNDPROC s_OrigWndProc = nullptr;
static std::mutex s_ImLock;                       // Frame vs ResizeBuffers (the back buffer view)
static bool s_Tried = false, s_Ok = false, s_WasOpen = false;
static volatile bool s_Faulted = false;

// The window procedure only queues input for the menu; ImGui sees it on the RHI thread at the next frame.
// It must not call ImGui itself: ImGui's Win32 handler calls SetCapture, which re-enters this procedure on the
// same thread (WM_CAPTURECHANGED) - with a lock held that threw resource_deadlock_would_occur and killed the
// game (0.2.44). Whether to keep input from the game uses the last frame's answer.
struct QueuedMsg { HWND H; UINT M; WPARAM W; LPARAM L; };
static std::mutex s_QLock;                        // held only to push/swap, never across a call
static std::vector<QueuedMsg> s_Queue;

static LRESULT CALLBACK WndProcHook(HWND H, UINT Msg, WPARAM W, LPARAM L) {
    if (G.MenuOpen.load() && G.MenuReady.load()) {
        const bool Mouse = Msg >= WM_MOUSEFIRST && Msg <= WM_MOUSELAST;
        const bool Keys = Msg >= WM_KEYFIRST && Msg <= WM_KEYLAST;
        if (Mouse || Keys || Msg == WM_SETFOCUS || Msg == WM_KILLFOCUS || Msg == WM_MOUSELEAVE) {
            std::lock_guard<std::mutex> Lk(s_QLock);
            if (s_Queue.size() < 1024) s_Queue.push_back(QueuedMsg{ H, Msg, W, L });
        }
        if ((Mouse && Msg != WM_MOUSEMOVE && G.WantMouse.load()) || (Keys && G.WantKeyboard.load())) return 0;
    }
    return CallWindowProcW(s_OrigWndProc, H, Msg, W, L);
}

static bool Init(IDXGISwapChain* Sc) {
    if (FAILED(Sc->GetDevice(__uuidof(ID3D11Device), reinterpret_cast<void**>(&s_Dev)))) {
        MpLog("[CineCam] menu off: the game is not rendering with D3D11 (hotkeys and CINECAM.ini still work)");
        return false;
    }
    s_Dev->GetImmediateContext(&s_Ctx);
    DXGI_SWAP_CHAIN_DESC D{};
    Sc->GetDesc(&D);
    s_Hwnd = D.OutputWindow;
    std::lock_guard<std::mutex> Lk(s_ImLock);
    ImGui::CreateContext();
    ImGuiIO& Io = ImGui::GetIO();
    static std::string s_Ini;                       // window position, beside the exe
    {
        char Exe[MAX_PATH]{};
        GetModuleFileNameA(nullptr, Exe, MAX_PATH);
        s_Ini = std::string(Exe).substr(0, std::string(Exe).find_last_of("\\/") + 1) + "CINECAM_menu.ini";
    }
    Io.IniFilename = s_Ini.c_str();
    Io.ConfigFlags |= ImGuiConfigFlags_NoMouseCursorChange;   // the game owns the cursor shape
    if (!Io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 16.f)) Io.Fonts->AddFontDefault();
    s_FontHead = Io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\seguisb.ttf", 12.5f);   // null = body font
    s_FontBig = Io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\seguisb.ttf", 150.f);
    ApplyStyle();
    ImGui_ImplWin32_Init(s_Hwnd);
    ImGui_ImplDX11_Init(s_Dev, s_Ctx);
    // Default IME hook calls Imm* on the window from this (RHI) thread, which waits on the game thread. No text
    // field here needs an IME (shot names are ASCII).
    ImGui::GetPlatformIO().Platform_SetImeDataFn = nullptr;
    s_OrigWndProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(s_Hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(WndProcHook)));
    G.MenuReady = true;
    MpLog("[CineCam] menu ready (D3D11, window " + MpPtr(s_Hwnd) + ")");
    return true;
}

static void Toast() {
    const ImVec2 Size = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos(ImVec2(Size.x * 0.5f, 60.f), ImGuiCond_Always, ImVec2(0.5f, 0.f));
    ImGui::SetNextWindowBgAlpha(0.85f);
    ImGui::Begin("##toast", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoInputs
        | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing);
    ImGui::Text("Cinematic camera on.   F10 menu  \xC2\xB7  G guides  \xC2\xB7  F8 exit");
    ImGui::End();
}

static void Frame() {
    const bool Open = G.MenuOpen.load(), Toasting = GetTickCount64() < G.ToastUntil.load(), Guides = G.GuidesShown.load();
    const int Count = G.Countdown.load();
    if (!Open) { s_WasOpen = false; G.WantMouse = G.WantKeyboard = false; G.PickingFocus = false; }
    if (!Open && !Toasting && !Guides && !Count) return;
    std::lock_guard<std::mutex> Lk(s_ImLock);
    if (Open && !s_WasOpen) { s_WasOpen = true; ImGui::GetIO().ClearInputKeys(); ImGui::GetIO().ClearInputMouse(); }
    std::vector<QueuedMsg> In;
    { std::lock_guard<std::mutex> Q(s_QLock); In.swap(s_Queue); }
    for (const QueuedMsg& M : In) ImGui_ImplWin32_WndProcHandler(M.H, M.M, M.W, M.L);
    if (!s_Rtv) {
        ID3D11Texture2D* Back = nullptr;
        if (FAILED(s_Sc->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&Back)))) return;
        s_Dev->CreateRenderTargetView(Back, nullptr, &s_Rtv);
        Back->Release();
        if (!s_Rtv) return;
    }
    ImGui_ImplDX11_NewFrame();
    ImGui_ImplWin32_NewFrame();
    ImGui::NewFrame();
    {
        std::lock_guard<std::mutex> St(G.Lock);
        ImDrawList* Bg = ImGui::GetBackgroundDrawList();
        if (Guides) DrawGuides(Bg, G.S);
        if (Open) { DrawPath(Bg); DrawMenu(); }
        else if (Guides) GuidesPill();
    }
    if (!Open && Toasting) Toast();
    if (Count > 0) Countdown(Count);
    const ImGuiIO& Io = ImGui::GetIO();
    G.WantMouse = Open && (Io.WantCaptureMouse || G.PickingFocus.load());   // a focus click must not reach the game
    G.WantKeyboard = Open && Io.WantTextInput;
    ImGui::Render();
    s_Ctx->OMSetRenderTargets(1, &s_Rtv, nullptr);
    ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
}

static void FrameGuarded() {
    __try { Frame(); }
    __except (EXCEPTION_EXECUTE_HANDLER) { s_Faulted = true; G.MenuReady = false; }
}

static HRESULT STDMETHODCALLTYPE PresentHook(IDXGISwapChain* Sc, UINT Sync, UINT Flags) {
    if (!s_Tried) { s_Tried = true; s_Sc = Sc; s_Ok = Init(Sc); }
    if (s_Ok && !s_Faulted && Sc == s_Sc) {
        FrameGuarded();
        if (s_Faulted) MpLog("[CineCam] fault in the menu - menu off for this session");
    }
    return s_OrigPresent(Sc, Sync, Flags);
}

static HRESULT STDMETHODCALLTYPE ResizeHook(IDXGISwapChain* Sc, UINT Count, UINT W, UINT H, DXGI_FORMAT Fmt, UINT Flags) {
    if (Sc == s_Sc) {
        std::lock_guard<std::mutex> Lk(s_ImLock);
        if (s_Rtv) { s_Rtv->Release(); s_Rtv = nullptr; }   // holds the back buffer; resize fails while it lives
    }
    return s_OrigResize(Sc, Count, W, H, Fmt, Flags);
}

// Present and ResizeBuffers come from the swap chain vtable (slots 8 and 13), read off a throwaway device.
void MenuStart() {
    static bool s_Started = false;
    if (s_Started) return;
    s_Started = true;
    WNDCLASSEXW Wc{ sizeof(Wc), CS_HREDRAW | CS_VREDRAW, DefWindowProcW, 0, 0, GetModuleHandleW(nullptr), nullptr, nullptr, nullptr, nullptr, L"CineCamDummy", nullptr };
    RegisterClassExW(&Wc);
    HWND Wnd = CreateWindowW(L"CineCamDummy", L"", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, nullptr, nullptr, Wc.hInstance, nullptr);
    DXGI_SWAP_CHAIN_DESC D{};
    D.BufferCount = 1;
    D.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    D.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    D.OutputWindow = Wnd;
    D.SampleDesc.Count = 1;
    D.Windowed = TRUE;
    IDXGISwapChain* Sc = nullptr;
    ID3D11Device* Dev = nullptr;
    ID3D11DeviceContext* Ctx = nullptr;
    const HRESULT Hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
        D3D11_SDK_VERSION, &D, &Sc, &Dev, nullptr, &Ctx);
    if (SUCCEEDED(Hr) && Sc) {
        void** Vt = *reinterpret_cast<void***>(Sc);
        const bool Ok = MH_CreateHook(Vt[8], reinterpret_cast<void*>(PresentHook), reinterpret_cast<void**>(&s_OrigPresent)) == MH_OK
            && MH_CreateHook(Vt[13], reinterpret_cast<void*>(ResizeHook), reinterpret_cast<void**>(&s_OrigResize)) == MH_OK
            && MH_EnableHook(Vt[8]) == MH_OK && MH_EnableHook(Vt[13]) == MH_OK;
        MpLog(Ok ? "[CineCam] Present hooked" : "[CineCam] Present hook failed - menu off");
    } else {
        MpLog("[CineCam] no D3D11 device for the Present hook (hr=" + std::to_string(Hr) + ") - menu off");
    }
    if (Sc) Sc->Release();
    if (Ctx) Ctx->Release();
    if (Dev) Dev->Release();
    DestroyWindow(Wnd);
    UnregisterClassW(L"CineCamDummy", Wc.hInstance);
}

}  // namespace Cine
