"use client";

import type { ImgHTMLAttributes } from "react";
import { useStableSignedUrl } from "../../lib/use-stable-signed-url";

export type StableImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src?: string };

/**
 * An `<img>` that pins its signed `src` across re-signings. A polling query hands the same asset a freshly-signed
 * URL each tick, and a bare `<img>` would re-fetch and flicker on every one; this keeps the first URL seen for a
 * given path (the asset's signed lifetime) and only swaps when the underlying asset does. A drop-in for `<img>`.
 */
export function StableImage({ src, alt, ...props }: StableImageProps) {
  const stableSrc = useStableSignedUrl(src);
  return <img src={stableSrc} alt={alt} {...props} />;
}
