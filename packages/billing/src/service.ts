import { type Logger, logger } from "@autonoma/logger";

export class Service {
    protected readonly logger: Logger;

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
    }
}
