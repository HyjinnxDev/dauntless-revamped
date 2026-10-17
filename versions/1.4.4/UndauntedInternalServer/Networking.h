#pragma once

#include <Windows.h>
#include "SDK.hpp"

using namespace SDK;

namespace Networking {
	extern UNetDriver* NetDriver;
	extern int LastActorCount;       // actors scanned last frame (PerfLog)
	extern long long LastConsiderUs; // BuildConsiderList time last frame (PerfLog)

	void InitChannelTracking(uintptr_t ImageBase);

	bool Listen(UEngine* Engine, int Port);

	void TickNetworking();
}
