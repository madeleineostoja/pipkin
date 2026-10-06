import { execFile } from "node:child_process";

const TERMINATION_POLL_MS = 50;

async function hasLiveMembers(pid: number, timeout: number): Promise<boolean> {
  try {
    const table = await new Promise<string>((resolve, reject) => {
      execFile(
        "ps",
        ["-e", "-o", "pgid=,stat="],
        { timeout },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    for (const line of table.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const member = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!member) {
        return true;
      }
      if (Number(member[1]) === pid && !member[2]!.startsWith("Z")) {
        return true;
      }
    }
    return false;
  } catch {
    // An unavailable process table cannot establish successful cleanup.
    return true;
  }
}

export async function waitForProcessTree(
  pid: number,
  deadline: number,
): Promise<boolean> {
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    // Signal-zero also finds zombies, which container PID 1 may never reap.
    // They cannot execute or hold ports and must not keep Activity running.
    if (!(await hasLiveMembers(pid, remaining))) {
      return true;
    }
    const delay = deadline - Date.now();
    if (delay <= 0) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(TERMINATION_POLL_MS, delay)),
    );
  }
}
