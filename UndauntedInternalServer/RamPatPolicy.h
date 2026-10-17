#pragma once
#include <cmath>
#include <string>

// A ram pat is a few seconds of synced animation; a task alive far longer is stuck and
// locks the player (the client then rubber-bands back whenever they move away).
inline bool RamPatStuck(const std::string& ControllerClass, double ElapsedSeconds) {
    return ControllerClass.find("hoofed_interact") != std::string::npos
        && std::isfinite(ElapsedSeconds) && ElapsedSeconds > 4.0;
}
