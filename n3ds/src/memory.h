/* Atlas PICA residency contract; also fingerprinted/read by the host compiler.
 * Exhausting the gather arena falls back to direct draws, never drops geometry.
 * Capture reserve is for the profile's native 400x240 + 320x240 surfaces. */
#ifndef ATLAS_MEMORY_H
#define ATLAS_MEMORY_H
#define ATLAS_BATCH_INDICES 131072
#define ATLAS_MAX_FX 10000
#define ATLAS_SKY_SEGMENTS 32
#define ATLAS_SKY_RINGS 16
#define ATLAS_CAPTURE_BYTES 519168
#define ATLAS_LINEAR_RESERVE 262144
#endif
