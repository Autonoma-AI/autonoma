import http from "node:http";
import type { ClientRequest } from "node:http";
import type { Transform } from "node:stream";
import type { ImageStream } from "@autonoma/engine";
import { logger } from "@autonoma/logger";
// @ts-expect-error - MjpegConsumer has no types
import MjpegConsumer from "mjpeg-consumer";

const FPS = 30;

/** Maximum age in milliseconds for a cached frame to be considered fresh */
const MAX_FRAME_AGE_MS = 50;

interface LastFrameData {
    buffer: Buffer;
    receivedAt: number;
}

const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;
const JPEG_EOI_0 = 0xff;
const JPEG_EOI_1 = 0xd9;

function isValidJpeg(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;

    const hasSOI = buffer[0] === JPEG_SOI_0 && buffer[1] === JPEG_SOI_1;
    const hasEOI = buffer[buffer.length - 2] === JPEG_EOI_0 && buffer[buffer.length - 1] === JPEG_EOI_1;

    return hasSOI && hasEOI;
}

export class AppiumImageStream implements ImageStream {
    private readonly logger = logger.child({ name: "AppiumImageStream" });
    private frameHandlers: Array<(image: string) => void> = [];
    private consumer: Transform | undefined;
    private request: ClientRequest | undefined;
    private lastFrameData: LastFrameData | undefined;
    private sendInterval: NodeJS.Timeout | undefined;
    private readonly streamUrl: string;

    constructor(mjpegHost: string, mjpegPort: number) {
        this.streamUrl = `http://${mjpegHost}:${mjpegPort}`;
    }

    public getLastImage(): Buffer | undefined {
        if (this.lastFrameData == null) return undefined;

        const age = Date.now() - this.lastFrameData.receivedAt;
        if (age > MAX_FRAME_AGE_MS) {
            this.logger.debug("Cached frame too old", { ageMs: age, maxAgeMs: MAX_FRAME_AGE_MS });
            return undefined;
        }

        return this.lastFrameData.buffer;
    }

    public addFrameHandler(callback: (image: string) => void | Promise<void>): void {
        this.frameHandlers.push(callback);
        this.logger.debug("Frame handler registered", { totalHandlers: this.frameHandlers.length });
    }

    public async start(): Promise<void> {
        if (this.consumer != null) {
            this.logger.warn("Stream already started");
            return;
        }

        this.logger.info("Starting MJPEG stream", { streamUrl: this.streamUrl });

        return new Promise((resolve, reject) => {
            const consumer = new MjpegConsumer() as Transform;
            this.consumer = consumer;

            this.consumer.on("data", (jpegBuffer: Buffer) => {
                if (!isValidJpeg(jpegBuffer)) return;

                this.lastFrameData = {
                    buffer: jpegBuffer,
                    receivedAt: Date.now(),
                };
            });

            this.request = http
                .get(this.streamUrl, (response) => {
                    response.pipe(consumer);
                    this.logger.info("Connected to MJPEG stream");
                })
                .on("error", (err) => {
                    this.logger.error("Failed to connect to MJPEG stream", err);
                    reject(new Error(`Failed to connect to MJPEG stream: ${err.message}`));
                });

            this.sendInterval = setInterval(() => {
                if (this.lastFrameData == null) return;

                const base64 = this.lastFrameData.buffer.toString("base64");
                for (const handler of this.frameHandlers) {
                    handler(base64);
                }
            }, 1000 / FPS);

            // Give it a moment to connect
            setTimeout(() => {
                resolve();
            }, 100);
        });
    }

    public async stop(): Promise<void> {
        this.logger.info("Stopping MJPEG stream");

        if (this.sendInterval != null) {
            clearInterval(this.sendInterval);
            this.sendInterval = undefined;
        }

        if (this.request != null) {
            this.request.destroy();
            this.request = undefined;
        }

        if (this.consumer != null) {
            this.consumer.destroy();
            this.consumer = undefined;
        }

        this.lastFrameData = undefined;
        this.logger.info("MJPEG stream stopped");
    }
}
