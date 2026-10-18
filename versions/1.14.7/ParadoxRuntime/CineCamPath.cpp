// Cinematic camera path math (CineCamShared.h): Catmull-Rom through timed keyframes, and even-speed re-timing.
// No engine or ImGui dependencies, so tools\CineCamPathCheck.cpp can build and check it on its own.

#define _CRT_SECURE_NO_WARNINGS                     // sscanf on our own fixed-format shot lines
#include "CineCamShared.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iterator>

namespace Cine {

float PathLength(const std::vector<Key>& Keys) { return Keys.empty() ? 0.f : Keys.back().Time; }

// Hermite segment P1 -> P2 with Kochanek-Bartels tangents: tension 0 at both ends is plain Catmull-Rom.
static float Curve(float P0, float P1, float P2, float P3, float T1, float T2, float T) {
    const float M1 = 0.5f * (1.f - T1) * (P2 - P0), M2 = 0.5f * (1.f - T2) * (P3 - P1);
    const float T2_ = T * T, T3 = T2_ * T;
    return (2.f * T3 - 3.f * T2_ + 1.f) * P1 + (T3 - 2.f * T2_ + T) * M1 + (-2.f * T3 + 3.f * T2_) * P2 + (T3 - T2_) * M2;
}

constexpr float kRad = 3.14159265f / 180.f;

// The pose at path time At (already eased); Aim = the segment's kAims entry.
static Pose Raw(const std::vector<Key>& Keys, float At, int* Aim) {
    const int N = static_cast<int>(Keys.size());
    *Aim = 0;
    if (At >= Keys.back().Time) return Keys.back().P;   // a Hold segment still lands on the last key
    int I = 0;
    while (I < N - 2 && At > Keys[I + 1].Time) ++I;
    const float Span = Keys[I + 1].Time - Keys[I].Time;
    const float F = Span > 0.f ? (std::clamp)((At - Keys[I].Time) / Span, 0.f, 1.f) : 1.f;
    const Pose& P0 = Keys[(std::max)(I - 1, 0)].P, & P1 = Keys[I].P, & P2 = Keys[I + 1].P, & P3 = Keys[(std::min)(I + 2, N - 1)].P;
    const float T1 = (std::clamp)(Keys[I].Tension, -1.f, 1.f), T2 = (std::clamp)(Keys[I + 1].Tension, -1.f, 1.f);
    const int How = Keys[I].Interp;
    *Aim = How == 2 ? 0 : Keys[I].Aim;
    Pose R;
    for (int K = 0; K < PN; ++K)
        R[K] = How == 2 ? P1[K] : How == 1 ? P1[K] + (P2[K] - P1[K]) * F : Curve(P0[K], P1[K], P2[K], P3[K], T1, T2, F);
    return R;
}

Pose PathAt(const std::vector<Key>& Keys, float T, bool Ease, bool Loop) {
    const int N = static_cast<int>(Keys.size());
    if (N == 0) return Pose{};
    const float Start = Keys.front().Time, Len = Keys.back().Time - Start;
    if (N == 1 || Len <= 0.f) return Keys.back().P;
    float U = (T - Start) / Len;
    U = Loop ? U - floorf(U) : (std::clamp)(U, 0.f, 1.f);
    if (Ease && !Loop) U = U * U * (3.f - 2.f * U);
    const float At = Start + U * Len;
    int Aim = 0, Unused = 0;
    Pose R = Raw(Keys, At, &Aim);
    if (Aim == 1) {                                     // look where it is flying: the direction to a moment ahead
        const float D = 0.05f;
        const bool Back = At + D > Keys.back().Time;
        const Pose A = Raw(Keys, Back ? At - D : At, &Unused), B = Raw(Keys, Back ? At : At + D, &Unused);
        const float Dx = B[PX] - A[PX], Dy = B[PY] - A[PY], Dz = B[PZ] - A[PZ], Flat = sqrtf(Dx * Dx + Dy * Dy);
        if (Flat + fabsf(Dz) > 1e-3f) {
            R[PYaw] = atan2f(Dy, Dx) / kRad;
            R[PPitch] = atan2f(Dz, Flat) / kRad;
        }
    }
    return R;
}

// Distance between two keys for even speed: centimetres moved plus 5 cm per degree turned, so a pan in place
// still gets time.
static float Distance(const Pose& A, const Pose& B) {
    const float Dx = A[PX] - B[PX], Dy = A[PY] - B[PY], Dz = A[PZ] - B[PZ];
    const float Turn = fabsf(A[PYaw] - B[PYaw]) + fabsf(A[PPitch] - B[PPitch]) + fabsf(A[PRoll] - B[PRoll]);
    return sqrtf(Dx * Dx + Dy * Dy + Dz * Dz) + 5.f * Turn;
}

void EvenSpeed(std::vector<Key>& Keys) {
    if (Keys.size() < 2) return;
    const float Total = Keys.back().Time - Keys.front().Time;
    std::vector<float> Cum(Keys.size(), 0.f);
    for (size_t I = 1; I < Keys.size(); ++I) Cum[I] = Cum[I - 1] + Distance(Keys[I - 1].P, Keys[I].P);
    if (Cum.back() <= 0.f || Total <= 0.f) return;
    for (size_t I = 1; I < Keys.size(); ++I) Keys[I].Time = Keys.front().Time + Total * Cum[I] / Cum.back();
}

bool ParseKey(const char* Line, Key& K, float DefFocus) {
    float V[9]{}, Tension = 0.f;
    int Interp = 0, Aim = 0;
    const int N = sscanf(Line, "key %f %f %f %f %f %f %f %f %f %d %f %d", &V[0], &V[1], &V[2], &V[3], &V[4], &V[5], &V[6], &V[7], &V[8],
        &Interp, &Tension, &Aim);
    if (N != 8 && N != 10 && N != 12) return false;
    K = Key{};
    K.Time = V[0];
    for (int I = 0; I < PFocus; ++I) K.P[I] = V[I + 1];
    K.P[PFocus] = N >= 10 ? V[8] : DefFocus;
    K.Interp = N >= 10 ? (std::clamp)(Interp, 0, static_cast<int>(std::size(kInterps)) - 1) : 0;
    K.Tension = N == 12 ? (std::clamp)(Tension, -1.f, 1.f) : 0.f;
    K.Aim = N == 12 ? (std::clamp)(Aim, 0, static_cast<int>(std::size(kAims)) - 1) : 0;
    return true;
}

Rect FitRect(float W, float H, float Ratio) {
    float Rw = W, Rh = H;
    if (Ratio > 0.f && H > 0.f) { if (W / H > Ratio) Rw = H * Ratio; else Rh = W / Ratio; }
    return Rect{ (W - Rw) * 0.5f, (H - Rh) * 0.5f, Rw, Rh };
}

// Three sines per channel at non-repeating ratios read as random wobble; each channel has its own phase.
Pose ShakeAt(float T, int Preset, float Amt, float Freq) {
    Pose R;
    if (Preset <= 0 || Preset >= static_cast<int>(std::size(kShakes))) return R;
    const ShakeProfile& P = kShakes[Preset];
    const float W = 6.2831853f * P.Freq * Freq * T;
    auto N = [W](float Ph) { return 0.5f * sinf(W + Ph) + 0.3f * sinf(2.137f * W + 1.7f * Ph) + 0.2f * sinf(4.31f * W + 2.3f * Ph); };
    R[PYaw] = N(0.f) * P.Rot * Amt;
    R[PPitch] = N(1.3f) * P.Rot * Amt;
    R[PRoll] = N(2.9f) * P.Rot * 0.5f * Amt;
    R[PX] = N(4.1f) * P.Pos * Amt;
    R[PY] = N(5.7f) * P.Pos * Amt;
    R[PZ] = N(7.3f) * P.Pos * Amt;
    return R;
}
float FovToMm(float Fov) { return 18.f / tanf(Fov * 0.5f * kRad); }
float MmToFov(float Mm) { return 2.f * atanf(18.f / Mm) / kRad; }

// Space 1 moves the position by the target; space 2 also turns position and yaw with the target's yaw.
Pose ToSpace(const Pose& W, int Space, float Tx, float Ty, float Tz, float TYaw) {
    Pose R = W;
    if (Space <= 0) return R;
    const float Dx = W[PX] - Tx, Dy = W[PY] - Ty, A = Space == 2 ? -TYaw * kRad : 0.f;
    R[PX] = Dx * cosf(A) - Dy * sinf(A);
    R[PY] = Dx * sinf(A) + Dy * cosf(A);
    R[PZ] = W[PZ] - Tz;
    if (Space == 2) R[PYaw] = W[PYaw] - TYaw;
    return R;
}
Pose FromSpace(const Pose& L, int Space, float Tx, float Ty, float Tz, float TYaw) {
    Pose R = L;
    if (Space <= 0) return R;
    const float A = Space == 2 ? TYaw * kRad : 0.f;
    R[PX] = Tx + L[PX] * cosf(A) - L[PY] * sinf(A);
    R[PY] = Ty + L[PX] * sinf(A) + L[PY] * cosf(A);
    R[PZ] = Tz + L[PZ];
    if (Space == 2) R[PYaw] = L[PYaw] + TYaw;
    return R;
}

}  // namespace Cine
