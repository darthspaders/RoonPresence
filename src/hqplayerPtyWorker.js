const nodePty = require("node-pty");

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";

  for (const char of String(command || "")) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (char === " " && !quote) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function main() {
  const command = Buffer.from(process.argv[2] || "", "base64").toString("utf8");
  const timeoutMs = Number(process.argv[3] || 5000);
  const [file, ...args] = splitCommand(command);
  if (!file) process.exit(2);

  let output = "";
  let completed = false;
  let dataSubscription = null;
  let exitSubscription = null;
  let timeout = null;

  const term = nodePty.spawn(file, args, {
    name: "xterm-color",
    cols: 220,
    rows: 60,
    cwd: process.cwd(),
    env: process.env
  });

  const finish = ({ kill = false } = {}) => {
    if (completed) return;
    completed = true;
    if (timeout) clearTimeout(timeout);
    try {
      dataSubscription?.dispose?.();
      exitSubscription?.dispose?.();
    } catch {
      // Best-effort cleanup before process exit.
    }
    if (kill) {
      try {
        term.kill();
      } catch {
        // Process already exited.
      }
    }
    process.stdout.write(output);
    process.exit(0);
  };

  dataSubscription = term.onData((data) => {
    output += data;
  });
  exitSubscription = term.onExit(() => finish());
  timeout = setTimeout(() => finish({ kill: true }), Math.max(1000, timeoutMs));
}

main();
