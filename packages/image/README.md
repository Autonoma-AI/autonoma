# @autonoma/image

Image processing utilities for screenshots, bounding boxes, and visual annotations. Built on [sharp](https://sharp.pixelplumbing.com/) and used throughout the execution engine to manipulate screenshots, annotate UI elements, and handle coordinate scaling between device and image resolutions.

## Exports

### `Screenshot`

Immutable wrapper around an image buffer and its base64 representation. Provides methods for annotation and transformation - each returns a new `Screenshot` instance.

```ts
import { Screenshot } from "@autonoma/image";

// Create from different sources
const fromB64 = Screenshot.fromBase64(base64String);
const fromBuf = Screenshot.fromBuffer(buffer);
const fromSharp = await Screenshot.fromSharp(sharpImage);

// Get resolution
const { width, height } = await screenshot.getResolution();

// Detect a blank / still-loading frame (near-uniform pixels) so it can be kept out of UI
const isBlank = await screenshot.isNearUniform();

// Annotate
const withBoxes = await screenshot.drawBoundingBoxes([box1, box2], { labelled: true });
const withText = await screenshot.addText("Step 1");
const withCursor = await screenshot.markPoint({ x: 100, y: 200 });
const withClick = await screenshot.drawClickCircle({ x: 100, y: 200 });
const withDrag = await screenshot.drawDragAnnotation({ x: 50, y: 50 }, { x: 200, y: 200 });

// Crop
const cropped = await screenshot.cropAroundPoint({ x: 100, y: 200 }, 50);

// Access underlying data
screenshot.buffer; // Buffer
screenshot.base64; // string
screenshot.getSharpImage(); // Sharp instance
```

### Geometry types and functions

```ts
import {
  type BoundingBox,       // { x, y, width, height }
  type Point,             // { x, y }
  boundingBoxCenter,
  boundingBoxContainsPoint,
  boundingBoxContainsBoundingBox,
  boundingBoxColors,      // 12-color palette for labelled boxes
} from "@autonoma/image";
```

### Low-level sharp helpers

Operate directly on `Sharp` instances when you need to compose multiple operations before materializing:

```ts
import {
  drawBoundingBoxesOnSharpImage,
  addTextToSharpImage,
  markPointOnSharpImage,
  cropAroundPointOnSharpImage,
  getImageMetadata,
} from "@autonoma/image";
```

There is also `drawBoundingBoxesOnImage` which accepts and returns base64 strings directly.

### Screenshot config and resolution scaling

A global config controls coordinate scaling behavior between device resolution and image resolution. This is essential for mobile, where screenshots may differ in resolution from the actual device screen.

```ts
import {
  setScreenshotConfig,
  getScreenshotConfig,
  updateScreenshotConfigWithResolution,
  type ScreenshotConfig,
  type ScreenResolution,
} from "@autonoma/image";

// Set architecture and device resolution
setScreenshotConfig({ architecture: "mobile", screenResolution: { width: 1170, height: 2532 } });

// Or auto-detect from a screenshot
await updateScreenshotConfigWithResolution(screenshot);
```

When `screenResolution` is set, all `Screenshot` annotation methods automatically scale coordinates between device space and image space. For `"web"` architecture (the default), no scaling is applied.

## Architecture notes

- **Immutable screenshots** - every annotation method returns a new `Screenshot`. The original is never mutated.
- **Architecture-aware sizing** - cursor sizes, label radii, and circle indicators scale based on `"web"` vs `"mobile"` architecture setting.
- **SVG compositing** - all annotations (bounding boxes, cursors, circles, text, drag lines) are rendered as SVG overlays and composited onto images via sharp.
- **Label collision resolution** - when drawing labelled bounding boxes, the package adjusts box positions and resolves overlapping labels automatically.
- **Coordinate scaling** - the `screen-resolution` module provides `pointToDeviceCoordinates`, `pointToImageCoordinates`, `boundingBoxToDeviceCoordinates`, and `boundingBoxToImageCoordinates` for converting between coordinate spaces.
- **Error handling** - sharp operations are wrapped with `SharpOperationFailedError` via `@autonoma/errors`.

## Dependencies

- `sharp` - image processing
- `@autonoma/errors` - error wrapping utilities
- `@autonoma/logger` - logging
