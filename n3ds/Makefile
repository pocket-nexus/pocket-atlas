# Standalone Atlas renderer; PocketJS owns the unchanged dev transport.
DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM
CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
BUILD := /atlas/.pocket-build/3ds/build
SOURCE := /atlas/n3ds/src
POCKET := /atlas/vendor/pocketjs/hosts/3ds
OUT := /atlas/dist/3ds/pocket-atlas.3dsx
ROMFS := /atlas/.pocket-build/3ds/romfs
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft
CFLAGS := -O3 -g -Wall -Wextra -std=gnu11 -ffunction-sections -fdata-sections -mword-relocations $(ARCH) \
  -D__3DS__ -DPOCKETJS_RUNTIME_SLOT='"pocket-atlas"' \
  -include $(BUILD)/config.h -I$(SOURCE) -I$(BUILD) -I$(POCKET)/src -I$(POCKET)/include -I$(DEVKITPRO)/libctru/include
LDFLAGS := -specs=3dsx.specs $(ARCH) -Wl,--gc-sections -Wl,-Map,$(BUILD)/atlas.map
OBJECTS := $(addprefix $(BUILD)/,main.o scene.o scene_shbin.o wet_shbin.o devserver.o dev_protocol.o native.o hbldr.o soc.o)
.PHONY: all
all: $(OUT)
$(BUILD):
	mkdir -p $@
$(BUILD)/%.shbin: $(SOURCE)/%.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $<
$(BUILD)/%_shbin.s $(BUILD)/%_shbin.h &: $(BUILD)/%.shbin
	cd $(BUILD) && $(DEVKITPRO)/tools/bin/bin2s -a 4 -H $*_shbin.h $*.shbin > $*_shbin.s
$(BUILD)/%_shbin.o: $(BUILD)/%_shbin.s
	$(CC) $(ARCH) -c $< -o $@
$(addprefix $(BUILD)/,main.o scene.o): $(BUILD)/%.o: $(SOURCE)/%.c $(wildcard $(SOURCE)/*.h) $(BUILD)/config.h $(BUILD)/scene_shbin.h $(BUILD)/wet_shbin.h | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(addprefix $(BUILD)/,devserver.o dev_protocol.o native.o hbldr.o soc.o): $(BUILD)/%.o: $(POCKET)/src/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/atlas.elf: $(OBJECTS)
	$(CC) $(LDFLAGS) $^ -L$(DEVKITPRO)/libctru/lib -lcitro3d -lctru -lm -o $@
$(BUILD)/atlas.smdh: $(POCKET)/icon.png | $(BUILD)
	$(DEVKITPRO)/tools/bin/smdhtool --create 'Pocket Atlas' 'Rainy Night Konbini' 'Pocket Nexus' $< $@
$(OUT): $(BUILD)/atlas.elf $(BUILD)/atlas.smdh $(ROMFS)/manifest.json
	mkdir -p $(dir $@)
	$(DEVKITPRO)/tools/bin/3dsxtool $< $@ --smdh=$(BUILD)/atlas.smdh --romfs=$(ROMFS)

.SECONDARY:
