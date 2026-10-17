#include "../RamPatPolicy.h"
#include <cassert>
int main() {
    assert(!RamPatStuck("hoofed_interact_synced_anim_controller_C", 3.9));
    assert(RamPatStuck("hoofed_interact_player_synced_anim_controller_C", 4.1));
    assert(!RamPatStuck("mint_playertossed_synced_anim_controller_C", 60.0));
    assert(!RamPatStuck("hoofed_interact_synced_anim_controller_C", NAN));
}
