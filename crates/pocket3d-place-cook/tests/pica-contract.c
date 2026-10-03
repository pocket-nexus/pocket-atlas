// Host contract check compiled with the same format definitions and header
// predicate as scene_load. A Rust writer/reader round trip alone cannot catch
// a cooker version change rejected by the handheld's C reader.
#include "format.h"
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc != 2)
    return 1;
  FILE *file = fopen(argv[1], "rb");
  if (!file)
    return 1;
  uint32_t header[4], sections[5][4];
  int result = 1;
  if (fread(header, sizeof header, 1, file) != 1 ||
      !atlas_pack_header_valid(header) ||
      fread(sections, sizeof sections, 1, file) != 1)
    goto done;
  for (unsigned i = 0; i < 5; i++) {
    // The same section limits as scene_load, independent of the Rust writer.
    uint32_t mib = sections[i][0] == 0x41434950 ? 4 :
                   sections[i][0] == 0x44584554 ? 12 :
                   sections[i][0] == 0x4d4f4547 ? 24 :
                   sections[i][0] == 0x4d494e41 ? 16 : 4;
    if (sections[i][2] > mib * 1024 * 1024)
      goto done;
  }
  for (unsigned i = 0; i < 5; i++) {
    if (sections[i][0] != 0x41434950)
      continue;
    AtlasHeader table;
    if (fseek(file, sections[i][1], SEEK_SET) != 0 ||
        fread(&table, sizeof table, 1, file) != 1)
      goto done;
    uint64_t size = sizeof table +
                    (uint64_t)table.textures * sizeof(AtlasTexture) +
                    (uint64_t)table.materials * sizeof(AtlasMaterial) +
                    (uint64_t)table.draws * sizeof(AtlasDraw) +
                    (uint64_t)table.shots * sizeof(AtlasShot) +
                    (uint64_t)table.lights * sizeof(AtlasLight) +
                    (uint64_t)table.dry_boxes * sizeof(AtlasBox) + table.skin_bytes;
    result = table.version != ATLAS_PICA_TABLE_VERSION || size != sections[i][2];
    break;
  }
done:
  fclose(file);
  return result;
}
