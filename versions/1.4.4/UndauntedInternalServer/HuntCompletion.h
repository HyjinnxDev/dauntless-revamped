#pragma once
#include <mutex>
#include <string>
#include <string_view>

// Game thread publishes a successful terminal result; HTTP threads only copy it.
namespace HuntCompletion {
    class Cache {
        std::mutex Mutex;
        std::wstring Key;
        std::wstring Value;
    public:
        void Capture(std::wstring_view Session, std::wstring_view Hunt, unsigned long long Run,
                     std::wstring_view Players, bool Success) {
            if (Session.empty() || Run == 0) return;
            const auto Id = std::wstring(Session) + L":" + std::to_wstring(Run);
            std::lock_guard<std::mutex> Lock(Mutex);
            if (Key == Id) return;
            Key = Id;
            Value.clear();
            if (!Success || Players.size() < 3 || Players.size() > 7000 || Players == L"[]"
                || Hunt.empty() || Hunt.size() > 160) return;
            for (const auto Ch : Hunt) {
                if (!((Ch >= L'a' && Ch <= L'z') || (Ch >= L'A' && Ch <= L'Z')
                    || (Ch >= L'0' && Ch <= L'9') || Ch == L'_' || Ch == L'-')) return;
            }
            Value = L"{\"id\":\"" + Id + L"\",\"hunt\":\"" + std::wstring(Hunt)
                + L"\",\"players\":" + std::wstring(Players) + L"}";
        }
        std::wstring Read() {
            std::lock_guard<std::mutex> Lock(Mutex);
            return Value;
        }
        void Clear() {
            std::lock_guard<std::mutex> Lock(Mutex);
            Value.clear();
        }
    };
}
