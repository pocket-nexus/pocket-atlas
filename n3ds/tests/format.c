/* Host-only container gate test; no device SDK or connection required.
 * cc -std=c11 -Wall -Wextra -Werror -In3ds/src n3ds/tests/format.c \
 *   -o .pocket-build/validation/3ds/format-test
 */
#include "format.h"
#include <assert.h>

int main(void) {
  uint32_t header[4] = {0x45434c50, 7, 5, 0};
  assert(atlas_place_header_valid(header));
  for (unsigned v = 0; v <= 8; v++) {
    header[1] = v;
    assert(atlas_place_header_valid(header) == (v == 7));
  }
  header[1] = 7;
  header[0] = 0;
  assert(!atlas_place_header_valid(header));
  header[0] = 0x45434c50;
  header[2] = 4;
  assert(!atlas_place_header_valid(header));
  /* PICA's native records did not change with the outer PLCE version. */
  assert(ATLAS_PICA_VERSION == 3);
  return 0;
}
