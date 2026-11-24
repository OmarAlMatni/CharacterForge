"""Derive a side view and a back view of the e2e fixture from the front drawing itself.

The fixture is a flat, blocky test figure (a circle head, a rectangle torso, rectangle arms and legs) drawn in five flat
colours. Redrawing it with an image model changes the character, which would make a multi-view A/B meaningless: the point
of the comparison is that the SAME character is painted by more drawings, not that a different character appears.

So the side and back views are built from the front drawing's own shapes and colours:
  - the back view is the front view with the head's hair band extended down over the face (the back of the head is hair,
    not face) and the torso/legs unchanged;
  - the side view is the same figure seen edge-on: every block keeps its vertical extent and its colour, but its width
    becomes the body's DEPTH, which is what a side drawing of a flat character actually shows.

Both are written at the front drawing's exact canvas size, so the fit code sees the same figure box.
"""
from PIL import Image, ImageDraw
import numpy as np

SRC = 'e2e/fixture-original.png'
OUT_SIDE = 'e2e/fixture-side.png'
OUT_BACK = 'e2e/fixture-back.png'

HAIR = (40, 30, 60, 255)
SKIN = (240, 200, 170, 255)
SHIRT = (180, 60, 80, 255)
PANTS = (50, 60, 120, 255)
INK = (20, 20, 20, 255)

W, H = 600, 900

# vertical bands measured from the front drawing
HAIR_Y = (50, 110)
HEAD_Y = (111, 186)
TORSO_Y = (194, 516)
LEG_Y = (521, 855)

# front-view horizontal extents
HEAD_X = (240, 360)
TORSO_X = (170, 430)
LEG_L = (240, 295)
LEG_R = (305, 360)

# the body's depth, as a fraction of its front width: a flat character is thinner than it is wide
DEPTH = 0.42


def band(draw, y0, y1, x0, x1, colour):
    draw.rectangle([x0, y0, x1, y1], fill=colour)


def back_view():
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # legs and torso are unchanged from behind
    band(d, LEG_Y[0], LEG_Y[1], LEG_L[0], LEG_L[1], PANTS)
    band(d, LEG_Y[0], LEG_Y[1], LEG_R[0], LEG_R[1], PANTS)
    band(d, TORSO_Y[0], TORSO_Y[1], TORSO_X[0], TORSO_X[1], SHIRT)
    # the head from behind is hair all the way down: no face
    band(d, HEAD_Y[0], HEAD_Y[1], HEAD_X[0], HEAD_X[1], HAIR)
    band(d, HAIR_Y[0], HAIR_Y[1], 250, 350, HAIR)
    return im


def side_view():
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = 300

    def centred(y0, y1, width, colour):
        half = width / 2
        band(d, y0, y1, int(round(cx - half)), int(round(cx + half)), colour)

    # seen edge-on, each block is as deep as the body is thick
    centred(LEG_Y[0], LEG_Y[1], (LEG_L[1] - LEG_L[0] + 1) * DEPTH * 1.6, PANTS)
    centred(TORSO_Y[0], TORSO_Y[1], (TORSO_X[1] - TORSO_X[0] + 1) * DEPTH, SHIRT)
    centred(HEAD_Y[0], HEAD_Y[1], (HEAD_X[1] - HEAD_X[0] + 1) * DEPTH * 1.15, SKIN)
    # the hair sits on top and at the back of the head: from the side it covers the rear half
    hair_w = (HEAD_X[1] - HEAD_X[0] + 1) * DEPTH * 1.15
    band(d, HAIR_Y[0], HAIR_Y[1], int(cx - hair_w / 2), int(cx + hair_w / 2), HAIR)
    band(d, HEAD_Y[0], HEAD_Y[1], int(cx - hair_w / 2), int(cx - hair_w / 2 + hair_w * 0.45), HAIR)
    return im


if __name__ == '__main__':
    back_view().save(OUT_BACK)
    side_view().save(OUT_SIDE)
    for p in (OUT_SIDE, OUT_BACK):
        im = Image.open(p)
        a = np.asarray(im)
        print(p, im.size, 'opaque px', int((a[..., 3] > 0).sum()))
