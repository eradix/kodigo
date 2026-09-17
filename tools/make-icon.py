#!/usr/bin/env python3
"""Draws Kodigo's app icon: a pair of curly braces on a rounded blue square.

The icon is generated rather than stored as an opaque image so it stays
editable — change a number here and every size regenerates. Uses nothing but
the standard library, so it runs anywhere Python does.

    python3 tools/make-icon.py app-icon.png
    npm run tauri icon app-icon.png

The second command is what produces the actual .png/.ico/.icns set that Tauri
bundles; this script only makes the 1024px master it works from.
"""

import math
import struct
import sys
import zlib

SIZE = 1024

# The app's accent blue, deepened towards the bottom so the tile has some
# weight without reading as a gradient at small sizes.
TOP = (0x8C, 0xB4, 0xFF)
BOTTOM = (0x53, 0x7B, 0xD9)
GLYPH = (0xFF, 0xFF, 0xFF)

# Rounded square. A generous radius keeps it from looking like a plain box at
# 16px, which is where most icons are actually seen.
MARGIN = 40
RADIUS = 232

# Brace geometry, in canvas pixels.
STROKE = 33          # half the thickness of the stroke
HOOK = 66            # radius of the four quarter-turns in each brace
TOP_Y, BOTTOM_Y = 268, 756
STEM_X = 402         # the vertical run of the left brace
ARC_STEPS = 26       # samples per quarter-turn; enough that the union is smooth


def brace_centreline():
    """Points along the centre of a `{`, top to bottom.

    The brace is drawn as a dense run of points; stamping a disc at each one
    unions into a stroked path with rounded caps and joins, which avoids having
    to implement outline geometry.
    """
    mid_y = (TOP_Y + BOTTOM_Y) / 2
    inner_x = STEM_X - HOOK   # the nub in the middle, pointing left
    outer_x = STEM_X + HOOK   # where the top and bottom hooks end up
    points = []

    def arc(cx, cy, start_deg, end_deg):
        for i in range(ARC_STEPS + 1):
            angle = math.radians(start_deg + (end_deg - start_deg) * i / ARC_STEPS)
            points.append((cx + HOOK * math.cos(angle), cy + HOOK * math.sin(angle)))

    def line(x, y0, y1):
        steps = max(2, int(abs(y1 - y0) / 4))
        for i in range(steps + 1):
            points.append((x, y0 + (y1 - y0) * i / steps))

    arc(outer_x, TOP_Y + HOOK, 270, 180)        # top hook, tip down to the stem
    line(STEM_X, TOP_Y + HOOK, mid_y - HOOK)    # upper stem
    arc(inner_x, mid_y - HOOK, 0, 90)           # into the middle nub
    arc(inner_x, mid_y + HOOK, 270, 360)        # back out of it
    line(STEM_X, mid_y + HOOK, BOTTOM_Y - HOOK)  # lower stem
    arc(outer_x, BOTTOM_Y - HOOK, 180, 90)      # bottom hook
    return points


def stamp(distance, points):
    """Lowers `distance` to the distance to the nearest of `points`.

    Only pixels within reach of a point are visited, which keeps this linear in
    the length of the stroke rather than in the area of the canvas.
    """
    reach = STROKE + 1.5
    for px, py in points:
        x0, x1 = int(px - reach), int(px + reach) + 1
        y0, y1 = int(py - reach), int(py + reach) + 1
        for y in range(max(0, y0), min(SIZE, y1)):
            dy = y + 0.5 - py
            row = y * SIZE
            for x in range(max(0, x0), min(SIZE, x1)):
                dx = x + 0.5 - px
                d = math.sqrt(dx * dx + dy * dy)
                if d < distance[row + x]:
                    distance[row + x] = d


def rounded_square_coverage(x, y):
    """Antialiased coverage of the rounded background tile at one pixel."""
    half = (SIZE - 2 * MARGIN) / 2
    dx = abs(x + 0.5 - SIZE / 2) - (half - RADIUS)
    dy = abs(y + 0.5 - SIZE / 2) - (half - RADIUS)
    outside = math.hypot(max(dx, 0), max(dy, 0)) - RADIUS
    inside = min(max(dx, dy), 0)
    return min(max(0.5 - (outside + inside), 0.0), 1.0)


def write_png(path, pixels):
    raw = bytearray()
    stride = SIZE * 4
    for y in range(SIZE):
        raw.append(0)  # filter: none
        raw += pixels[y * stride : (y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    with open(path, "wb") as out:
        out.write(b"\x89PNG\r\n\x1a\n")
        out.write(chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)))
        out.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        out.write(chunk(b"IEND", b""))


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "app-icon.png"

    left = brace_centreline()
    # The right brace is the left one reflected about the vertical centreline.
    right = [(SIZE - x, y) for x, y in left]

    distance = [1e9] * (SIZE * SIZE)
    stamp(distance, left)
    stamp(distance, right)

    pixels = bytearray(SIZE * SIZE * 4)
    for y in range(SIZE):
        blend = y / (SIZE - 1)
        bg = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * blend) for i in range(3))
        row = y * SIZE
        for x in range(SIZE):
            tile = rounded_square_coverage(x, y)
            if tile <= 0:
                continue
            ink = min(max(STROKE + 0.5 - distance[row + x], 0.0), 1.0)
            colour = tuple(round(bg[i] + (GLYPH[i] - bg[i]) * ink) for i in range(3))
            at = (row + x) * 4
            pixels[at : at + 4] = bytes((*colour, round(tile * 255)))

    write_png(target, pixels)
    print(f"wrote {target} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
