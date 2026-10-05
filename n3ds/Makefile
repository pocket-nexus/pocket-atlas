# Standalone Atlas renderer; PocketJS owns the unchanged dev transport.
DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM
CC := $(DEVKITARM)/bin/arm-none-eabi-gcc
BUILD := /atlas/.pocket-build/3ds/build
SOURCE := /atlas/n3ds/src
PICA_KERNEL := /atlas/vendor/pocketjs/devices/3ds/pocket-3ds-pica/include
POCKET := /atlas/vendor/pocketjs/hosts/3ds
OUT := /atlas/dist/3ds/pocket-atlas.3dsx
ROMFS := /atlas/.pocket-build/3ds/romfs
ARCH := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft
# The interface (ui/) runs on PocketJS's 3DS pieces: its UI core (a Rust
# static library, built on the host), QuickJS, the guest driver (qjs.c), the
# PICA DrawList backend (gfx.c) and its input mapping. JS_NO_NAN_BOXING must
# match the QuickJS archive on every unit that sees quickjs.h.
CORE_LIB := /atlas/.pocket-build/3ds/ui-core/armv6k-nintendo-3ds/release/libpocketjs_3ds_core.a
QUICKJS := /atlas/.pocket-build/3ds/quickjs
CFLAGS := -O3 -g -Wall -Wextra -std=gnu11 -ffunction-sections -fdata-sections -mword-relocations $(ARCH) \
  -D__3DS__ -DJS_NO_NAN_BOXING -DPOCKETJS_RUNTIME_SLOT='"pocket-atlas"' \
  -include $(BUILD)/config.h -I$(PICA_KERNEL) -I$(SOURCE) -I$(BUILD) -I$(POCKET)/src -I$(POCKET)/include -I$(QUICKJS) -I$(DEVKITPRO)/libctru/include -I$(DEVKITPRO)/portlibs/3ds/include
LDFLAGS := -specs=3dsx.specs $(ARCH) -Wl,--gc-sections -Wl,-Map,$(BUILD)/atlas.map
ATLAS := main.o scene.o globe.o settings.o assets.o frame_guard.o interface.o guest.o
OBJECTS := $(addprefix $(BUILD)/,$(ATLAS) scene_shbin.o field_shbin.o wet_shbin.o water_shbin.o globe_shbin.o vshader_shbin.o devserver.o dev_protocol.o native.o hbldr.o soc.o gfx.o qjs.o input.o)
.PHONY: all
all: $(OUT)
$(BUILD):
	mkdir -p $@
$(BUILD)/%.shbin: $(SOURCE)/%.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $<
# Programs that are exchanged many times a frame are one binary: their code
# is uploaded once, and they share their uniforms by name.
$(BUILD)/scene.shbin: $(SOURCE)/scene.v.pica $(SOURCE)/glow.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $^
$(BUILD)/field.shbin: $(SOURCE)/field.v.pica $(SOURCE)/traffic.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $^
$(BUILD)/%_shbin.s $(BUILD)/%_shbin.h &: $(BUILD)/%.shbin
	cd $(BUILD) && $(DEVKITPRO)/tools/bin/bin2s -a 4 -H $*_shbin.h $*.shbin > $*_shbin.s
$(BUILD)/%_shbin.o: $(BUILD)/%_shbin.s
	$(CC) $(ARCH) -c $< -o $@
$(BUILD)/vshader.shbin: $(POCKET)/src/vshader.v.pica | $(BUILD)
	$(DEVKITPRO)/tools/bin/picasso -o $@ $<
$(addprefix $(BUILD)/,$(ATLAS)): $(BUILD)/%.o: $(SOURCE)/%.c $(wildcard $(SOURCE)/*.h) $(wildcard $(PICA_KERNEL)/*.h) $(BUILD)/config.h $(BUILD)/scene_shbin.h $(BUILD)/field_shbin.h $(BUILD)/wet_shbin.h $(BUILD)/water_shbin.h $(BUILD)/globe_shbin.h | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(addprefix $(BUILD)/,devserver.o dev_protocol.o native.o hbldr.o soc.o input.o): $(BUILD)/%.o: $(POCKET)/src/%.c | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/gfx.o: $(POCKET)/src/gfx.c $(BUILD)/vshader_shbin.h | $(BUILD)
	$(CC) $(CFLAGS) -c $< -o $@
# The guest's DevTools would take the control lines meant for the renderer:
# it is told there is no debugger (guest.c).
$(BUILD)/qjs.o: $(POCKET)/src/qjs.c | $(BUILD)
	$(CC) $(CFLAGS) -Ddevserver_active=interface_devtools -c $< -o $@
$(BUILD)/atlas.elf: $(OBJECTS) $(CORE_LIB) $(QUICKJS)/libquickjs.a
	$(CC) $(LDFLAGS) $^ -L$(DEVKITPRO)/libctru/lib -L$(DEVKITPRO)/portlibs/3ds/lib -lcitro3d -lmbedcrypto -lctru -lm -o $@
$(BUILD)/atlas.smdh: $(POCKET)/icon.png | $(BUILD)
	$(DEVKITPRO)/tools/bin/smdhtool --create 'Pocket Atlas' 'A globe of places' 'Pocket Nexus' $< $@
$(OUT): $(BUILD)/atlas.elf $(BUILD)/atlas.smdh $(ROMFS)/manifest.json
	mkdir -p $(dir $@)
	$(DEVKITPRO)/tools/bin/3dsxtool $< $@ --smdh=$(BUILD)/atlas.smdh --romfs=$(ROMFS)

.SECONDARY:
