#pragma once
#include <chrono>

#include "SDK.hpp"

// The vendor screen (CraftingScreen) has a Craft / Purchase tab bar (ChargeButtonTabs, with the
// bumper hints either side) that 1.4.4 leaves collapsed, so a player sees no way to switch and only
// the bumpers do it. Show the bar, and its bumper hints, whenever the vendor offers both tabs.
namespace VendorTabs {

inline SDK::UCraftingScreen* Screen = nullptr;
inline int32_t ScreenIndex = -1;
inline std::chrono::steady_clock::time_point NextCheck{};

// UWidget::SetVisibility through ProcessEvent (the UMG function bodies are not built into this DLL).
inline void Show(SDK::UWidget* Widget) {
    if (!Widget || Widget->Visibility == SDK::ESlateVisibility::SelfHitTestInvisible)
        return;
    static SDK::UFunction* SetVisibility = nullptr;
    if (!SetVisibility)
        SetVisibility = Widget->Class->GetFunction("Widget", "SetVisibility");
    if (!SetVisibility)
        return;
    struct { SDK::ESlateVisibility InVisibility; } Params{ SDK::ESlateVisibility::SelfHitTestInvisible };
    Widget->ProcessEvent(SetVisibility, &Params);
}

// Call after every client ProcessEvent.
inline void OnProcessEvent(SDK::UObject* Object) {
    if (Object && Object != Screen && Object->IsA(SDK::UCraftingScreen::StaticClass())) {
        Screen = static_cast<SDK::UCraftingScreen*>(Object);
        ScreenIndex = Object->Index;
    }

    const auto Now = std::chrono::steady_clock::now();
    if (!Screen || Now < NextCheck)
        return;
    NextCheck = Now + std::chrono::milliseconds(250);

    // The slot must still hold the same screen (it may have been destroyed in the meantime).
    if (SDK::UObject::GObjects->GetByIndex(ScreenIndex) != Screen) {
        Screen = nullptr;
        return;
    }

    auto* Tabs = Screen->ChargeButtonTabs;
    if (!Screen->ChargeButtonTabsContainer || !Tabs || Tabs->CachedVisibleTabsCount < 2)
        return;

    Show(Screen->ChargeButtonTabsContainer);
    Tabs->CollapseButtonHintsForMK = false;
    Show(Tabs->PreviousButtonHint);
    Show(Tabs->NextButtonHint);
}

}
