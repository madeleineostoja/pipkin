import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

export function pipkinProjectDirectory(projectRoot: string): string {
  return join(resolve(projectRoot), CONFIG_DIR_NAME, "pipkin");
}
