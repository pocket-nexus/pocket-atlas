/* Exercise the production deadline helper without UIKit or an EAGL context. */
#define ATLAS_PACING_HOST_TEST
#include "../src/platform.c"
#include <assert.h>

static void continuous_ticks(int hz) {
    RenderPacing pacing = { .hz = 60 };
    assert(pacing_rate(&pacing, hz));
    const double origin = 1000000.0;
    /* Long uptime and 100,000 ticks also catch accumulated phase drift. */
    for (int tick = 0; tick < 100000; ++tick) {
        double timestamp = origin + tick / 60.0;
        assert(pacing_due(&pacing, timestamp) == (hz == 60 || tick % 2 == 0));
        assert(!pacing_due(&pacing, timestamp));
    }
}

int main(void) {
    continuous_ticks(30);
    continuous_ticks(60);

    RenderPacing pacing = { .hz = 60 };
    assert(pacing_rate(&pacing, 30));
    assert(pacing_due(&pacing, 0));
    assert(!pacing_due(&pacing, 1.0 / 60));
    /* The deadline at tick 2 was missed. Tick 3 services it once; tick 4
     * still belongs to the original phase, unlike callback parity counting. */
    assert(pacing_due(&pacing, 3.0 / 60));
    assert(pacing_due(&pacing, 4.0 / 60));
    assert(!pacing_due(&pacing, 5.0 / 60));
    assert(pacing_due(&pacing, 6.0 / 60));

    assert(pacing_rate(&pacing, 60));
    assert(pacing_due(&pacing, 7.0 / 60));
    assert(pacing_due(&pacing, 8.0 / 60));
    assert(pacing_rate(&pacing, 30));
    assert(pacing_due(&pacing, 9.0 / 60));
    assert(!pacing_due(&pacing, 10.0 / 60));
    assert(pacing_due(&pacing, 11.0 / 60));
    assert(!pacing_rate(&pacing, 30.5));
    assert(!pacing_rate(&pacing, 0));
    assert(!pacing_rate(&pacing, NAN));
    assert(pacing.hz == 30);
    assert(!pacing_due(&pacing, NAN));
    assert(!pacing_due(&pacing, INFINITY));
    assert(!pacing_due(&pacing, -1));

    /* A long suspension neither loops to catch up nor leaves queued frames. */
    assert(pacing_due(&pacing, 86400.15));
    assert(pacing.next > 86400.15 && pacing.next <= 86400.15 + 1.0 / 30);
    for (int i = 0; i < 100; ++i) assert(!pacing_due(&pacing, 86400.15));
    double next = pacing.next;
    assert(!pacing_due(&pacing, next - 0.00001));
    assert(pacing_due(&pacing, next));
    pacing_reset(&pacing); /* Foregrounding retains the selected request rate. */
    assert(pacing.hz == 30);
    assert(pacing_due(&pacing, next + 0.01));
    assert(!pacing_due(&pacing, next + 0.02));
    assert(pacing_due(&pacing, 10)); /* Recover from a reset clock epoch. */
    assert(!pacing_due(&pacing, 10));

    puts("PASS: 30/60 Hz absolute deadlines; long-uptime phase; missed tick; "
         "rate switch; invalid control; long pause without catch-up; resume.");
    return 0;
}
