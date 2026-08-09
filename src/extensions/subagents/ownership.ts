import type { RuntimeOwner } from "./runtime.js";

export function isImplementOwned(owner: RuntimeOwner): boolean {
  if (typeof owner !== "object") {
    return false;
  }
  if (owner.kind === "pipkin:implement") {
    return true;
  }
  return (
    owner.kind === "nested" &&
    owner.parentOwner !== undefined &&
    isImplementOwned(owner.parentOwner)
  );
}
