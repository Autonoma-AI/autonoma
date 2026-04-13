import { join } from "node:path";
import { config } from "dotenv";

config({ path: join(import.meta.dirname, "../../../../.env") });
