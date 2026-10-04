// Host contract check compiled with the same format definitions and header
// predicate as scene_load. A Rust writer/reader round trip alone cannot catch
// a cooker version change rejected by the handheld's C reader.
#include "format.h"
#include "animation.h"
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc != 2)
    return 1;
  FILE *file = fopen(argv[1], "rb");
  if (!file)
    return 1;
  uint32_t header[4], sections[6][4];
  int result = 1;
  if (fread(header, sizeof header, 1, file) != 1 ||
      !atlas_pack_header_valid(header) ||
      fread(sections, header[2] * sizeof sections[0], 1, file) != 1)
    goto done;
  for (unsigned i = 0; i < header[2]; i++) {
    // The same section limits as scene_load, independent of the Rust writer.
    uint32_t mib = sections[i][0] == 0x41434950 ? 4 :
                   sections[i][0] == 0x44584554 ? 12 :
                   sections[i][0] == 0x4d4f4547 ? 24 :
                   sections[i][0] == 0x4d494e41 ? 16 : 4;
    if (sections[i][2] > mib * 1024 * 1024)
      goto done;
  }
  for (unsigned i = 0; i < header[2]; i++) {
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
    for (unsigned j = 0; !result && j < header[2]; ++j) {
      if (sections[j][0] != 0x4d494e41) continue;
      void *animation = malloc(sections[j][2] ? sections[j][2] : 4);
      result = !animation || fseek(file, sections[j][1], SEEK_SET) != 0 ||
               fread(animation, 1, sections[j][2], file) != sections[j][2] ||
               !atlas_animation_valid(animation, sections[j][2], table.matrices, table.frames);
      free(animation);
    }
    break;
  }
done:
  fclose(file);
  return result;
}
