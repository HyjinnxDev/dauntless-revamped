#pragma once
#include <algorithm>

// Allow cold clients to load before their first connection; reclaim empty completed hunts.
struct HuntIdlePolicy {
    double EmptySeconds = 0;
    bool HadPlayer = false;
    bool Advance(double Seconds, bool HasPlayer) {
        if (HasPlayer) { HadPlayer = true; EmptySeconds = 0; return false; }
        EmptySeconds += std::max(0.0, Seconds);
        return EmptySeconds >= (HadPlayer ? 30.0 : 180.0);
    }
};
