#include "../HuntCompletion.h"
#include <cassert>

int main() {
    HuntCompletion::Cache Cache;
    const auto Session = L"00000000-0000-0000-0000-000000000001";
    Cache.Capture(Session, L"Pursuit", 1, L"[\"player\"]", false);
    assert(Cache.Read().empty());
    Cache.Capture(Session, L"Pursuit", 1, L"[\"player\"]", true);
    assert(Cache.Read().empty()); // Failed run cannot later turn into a success.
    Cache.Capture(Session, L"Pursuit", 2, L"[\"player\"]", true);
    const auto First = Cache.Read();
    assert(First.find(L"\"id\":\"00000000-0000-0000-0000-000000000001:2\"") != std::wstring::npos);
    Cache.Capture(Session, L"Pursuit", 2, L"[\"other\"]", true);
    assert(Cache.Read() == First); // Completion freezes participating roster.
    Cache.Clear();
    assert(Cache.Read().empty());
    Cache.Capture(Session, L"Escalation", 3, L"[\"player\"]", true);
    assert(!Cache.Read().empty());
    Cache.Capture(Session, L"Invalid\"Hunt", 4, L"[\"player\"]", true);
    assert(Cache.Read().empty());
}
