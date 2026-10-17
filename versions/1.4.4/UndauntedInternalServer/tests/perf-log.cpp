#include "../PerfLog.h"
#include <cassert>
#include <iostream>
int main() {
    using namespace PerfLog;
    // 300 frames over 10 s: 3 slow, one budget miss, class and census rows.
    for (int i = 0; i < 300; i++) {
        RecordFrameWork(i < 3 ? 120000 : 8000, 1.0 / 30);
        W.Engine.Add(5000); W.Repl.Add(2000); W.ReplicateCalls += 100; W.Scanned += 500;
    }
    ++W.BudgetMiss; W.Late.Add(4000); W.SleepOver.Add(15000);
    const auto text = FormatWindow(W, 10.0, 12345);
    assert(text.find("frames=300 fps=30.0 sim_ratio=1.000") != std::string::npos);
    assert(text.find("lt16=297") != std::string::npos && text.find("lt250=3") != std::string::npos);
    assert(text.find("work_ms_max=120.00") != std::string::npos);
    assert(text.find("sleep_over_ms_max=15.00") != std::string::npos);
    assert(text.find("replicate_calls_avg=100") != std::string::npos);

    int a, b;
    Classes[&a] = {40, 40000, 3000}; Classes[&b] = {10, 500, 90};
    const auto name = [&](const void* p) { return std::string(p == &a ? "Heavy" : "Light"); };
    const auto rows = FormatClasses(name, 4, 100.0);
    assert(rows.find("perf_class name=Heavy est_calls_per_frame=1.6 est_ms_per_frame=1.600") == 0); // sorted by cost
    Tally(&a, true, 60); Tally(&a, false, 20); Tally(&b, false, 5);
    const auto census = FormatCensus(name);
    assert(census.find("perf_census name=Heavy count=2 urgent=1 avg_net_update_hz=40.0 of_total=3") == 0);

    Window empty; // no division by zero with an idle window
    assert(FormatWindow(empty, 0, 0).find("frames=0 fps=0.0") != std::string::npos);
    std::cout << "perf log: window, class cost ordering, census and empty-window checks passed\n";
}
