// Config
export { setScreenshotConfig, getScreenshotConfig, type ScreenResolution, type ScreenshotConfig } from "./config";

// Screenshot
export { Screenshot } from "./screenshot";

// Image format
export { type ImageFormat, UnknownImageFormatError, detectImageFormat, imageFormatFromKey } from "./image-format";

// Screen Resolution
export { updateScreenshotConfigWithResolution } from "./screen-resolution";

// Geometry
export {
    type BoundingBox,
    type Point,
    boundingBoxCenter,
    boundingBoxContainsPoint,
    boundingBoxContainsBoundingBox,
    SharpOperationFailedError,
    drawBoundingBoxesOnImage,
    drawBoundingBoxesOnSharpImage,
    getImageMetadata,
    addTextToImage,
    addTextToSharpImage,
    markPointOnSharpImage,
    cropAroundPointOnSharpImage,
    boundingBoxColors,
} from "./geometry";
