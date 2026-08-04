import { env as aiEnv } from "@autonoma/ai/env";
import { env as dbEnv } from "@autonoma/db/env";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [loggerEnv, dbEnv, aiEnv, storageEnv],
    server: {
        APPIUM_HOST: z.string().optional(),
        APPIUM_PORT: z.string().optional(),
        APPIUM_MJPEG_PORT: z.string().optional(),
        APPIUM_SKIP_INSTALLATION: z.stringbool().optional().default(true),
        DEVICE_NAME: z.string().optional(),
        APPIUM_SYSTEM_PORT: z.string().optional(),
        IOS_PLATFORM_VERSION: z.string().optional(),
        ANDROID_DAEMON_HOSTS: z.string().optional(),
        IOS_DAEMON_HOSTS: z.string().optional(),
        SKIP_DEVICE_DATE_UPDATE: z.stringbool().optional().default(false),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});
