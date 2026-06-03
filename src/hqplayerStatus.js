const { execFile, spawn } = require("child_process");
const EventEmitter = require("events");
const path = require("path");

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

function normalizeSignalPath(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^exit=/i.test(line)) || "";
}

function parseStatusLine(line) {
  const match = String(line || "").match(
    /^status:\s+(\d+)\s+(\d+)\/(\d+)\s+\S+\s+([+-]?\d+(?:\.\d+)?)\s+(\d+)\/(\d+)\s+([+-]?\d+(?:\.\d+)?)\/([+-]?\d+(?:\.\d+)?)/
  );
  if (!match) return null;

  return {
    state: Number(match[1]),
    trackIndex: Number(match[2]),
    trackCount: Number(match[3]),
    volumeDb: Number(match[4]),
    position: Number(match[5]),
    duration: Number(match[6]),
    outputRateKhz: Number(match[7]),
    inputRateKhz: Number(match[8])
  };
}

function formatRate(rateKhz, outputFormat = "") {
  if (!Number.isFinite(rateKhz) || rateKhz <= 0) return "";

  if (normalizeOutputFormat(outputFormat) === "SDM") {
    return `${(rateKhz / 1000).toFixed(4)}MHz`;
  }

  const rounded = Math.round(rateKhz * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) {
    return `${Math.round(rounded)}kHz`;
  }

  return `${rounded.toFixed(1)}kHz`;
}

function composeSignalPath({
  prefix = "",
  outputRateKhz = null,
  outputFormat = "",
  filterName = "",
  shaperName = ""
} = {}) {
  const parts = String(prefix || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const format = normalizeOutputFormat(outputFormat);
  const dsdRate = format === "SDM" ? formatDsdRate(outputRateKhz) : "";
  const rate = formatRate(outputRateKhz, format);
  const filter = String(filterName || "").trim();
  const shaper = String(shaperName || "").trim();
  const withoutLiveFields = parts.filter(
    (part) =>
      !/^\d+(?:\.\d+)?\s*kHz$/i.test(part) &&
      !/^\d+(?:\.\d+)?\s*MHz$/i.test(part) &&
      !/^DSD\d+$/i.test(part) &&
      !(format && /^(?:PCM|SDM|DSD)$/i.test(part)) &&
      !(format && isShaperName(part)) &&
      !(filter && isFilterName(part))
  );

  if (filter) withoutLiveFields.push(filter);
  if (format === "SDM" && shaper) withoutLiveFields.push(shaper);
  if (format) withoutLiveFields.push(format);
  if (dsdRate) withoutLiveFields.push(dsdRate);
  if (rate) withoutLiveFields.push(rate);

  return withoutLiveFields.join(", ");
}

function normalizeOutputFormat(format) {
  const value = String(format || "").trim().toUpperCase();
  if (value === "0" || value === "PCM") return "PCM";
  if (value === "1" || value === "SDM" || value === "DSD") return "SDM";
  return "";
}

function formatDsdRate(rateKhz) {
  if (!Number.isFinite(rateKhz) || rateKhz <= 0) return "";

  const baseKhz = 44.1;
  const multiple = Math.round(rateKhz / baseKhz);
  if (!Number.isFinite(multiple) || multiple <= 0) return "";

  return `DSD${multiple}`;
}

function isShaperName(value) {
  return /^(?:TPDF|RPDF|NS\d+|LNS\d+|Gauss\d+|shaped|ASDM.*)$/i.test(String(value || "").trim());
}

function isFilterName(value) {
  return /(?:sinc|FIR|IIR|ASRC|polynomial|closed-form|none)/i.test(String(value || "").trim());
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseRates(output) {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.match(/^\[(\d+)]\s+(\d+)/))
    .filter(Boolean)
    .map((match) => Number(match[2]))
    .filter((rate) => Number.isFinite(rate) && rate > 0);
}

function highestRateKhz(output) {
  const rates = parseRates(output);
  if (!rates.length) return null;
  return Math.max(...rates) / 1000;
}

function parseTransportRateKhz(output) {
  const match = stripAnsi(output).match(/transport:\s+(\d+)/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  return (value * 800) / 1000;
}

function parseStateRateKhz(output) {
  const match = stripAnsi(output).match(/\b\d+:(\d{5,9})\b/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  return value / 1000;
}

function parseStateOutput(output) {
  const clean = stripAnsi(output);
  const rateMatch = clean.match(/\b(\d+):(\d{5,9})\b/);
  if (!rateMatch) return null;

  const mode = Number(rateMatch[1]);
  const rate = Number(rateMatch[2]);
  if (!Number.isFinite(mode) || !Number.isFinite(rate) || rate <= 0) return null;

  const selectionMatch = clean.match(/\d+:\((\d+),\s*\d+\s*\(\d+,\s*(\d+)\),\s*(\d+)\)/);

  return {
    outputFormat: normalizeOutputFormat(String(mode)),
    outputRateKhz: rate / 1000,
    filterIndex: selectionMatch ? Number(selectionMatch[1]) : null,
    shaperIndex: selectionMatch ? Number(selectionMatch[2]) : null,
    rateIndex: selectionMatch ? Number(selectionMatch[3]) : null
  };
}

function parseNamedList(output) {
  const names = new Map();
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const match = line.trim().match(/^\[(\d+)]\s+"([^"]+)"/);
    if (!match) continue;
    names.set(Number(match[1]), match[2]);
  }
  return names;
}

function siblingCommand(command, replacementArg) {
  const parts = splitCommand(command);
  if (!parts.length) return "";

  const index = parts.findIndex((part) => /^--/.test(part));
  if (index === -1) return "";

  parts[index] = replacementArg;
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

class HQPlayerStatusProvider extends EventEmitter {
  constructor({
    command = "",
    staticSignalPath = "",
    statusCommand = "",
    rateCommand = "",
    signalPathPrefix = "",
    pollMs = 5000,
    logger,
    exec = execFile,
    spawnProcess = spawn
  } = {}) {
    super();
    this.command = command;
    this.staticSignalPath = staticSignalPath;
    this.statusCommand = statusCommand;
    this.rateCommand = rateCommand;
    this.signalPathPrefix = signalPathPrefix;
    this.pollMs = pollMs;
    this.logger = logger;
    this.exec = exec;
    this.spawnProcess = spawnProcess;
    this.signalPath = staticSignalPath || signalPathPrefix;
    this.timer = null;
    this.inFlight = false;
    this.statusProcess = null;
    this.statusBuffer = "";
    this.rateTimer = null;
    this.filterNames = new Map();
    this.shaperNames = new Map();
    this.listInFlight = false;
    this.rateInFlight = false;
    this.lastStateOutput = null;
    this.lastListSignature = "";
    this.started = false;
  }

  start() {
    if (this.started) return;
    if (!this.command && !this.staticSignalPath && !this.statusCommand && !this.rateCommand) return;
    this.started = true;

    if (this.staticSignalPath) {
      this.logger?.info("Using static HQPlayer signal path override");
    }

    if (!this.staticSignalPath && this.signalPathPrefix) {
      this.logger?.info(`Using HQPlayer signal path prefix: ${this.signalPathPrefix}`);
    }

    if (this.command) {
      this.logger?.info("Polling HQPlayer signal path command");
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollMs);
    }

    if (this.statusCommand && !this.rateCommand) {
      this.logger?.info("Streaming HQPlayer status");
      this.startStatusStream();
    }

    if (this.rateCommand) {
      this.logger?.info("Polling HQPlayer active output rate");
      this.pollRates();
      this.rateTimer = setInterval(() => this.pollRates(), this.pollMs);
    }
  }

  updateConfig({
    command = "",
    staticSignalPath = "",
    statusCommand = "",
    rateCommand = "",
    signalPathPrefix = "",
    pollMs = 5000
  } = {}) {
    const changed =
      command !== this.command ||
      staticSignalPath !== this.staticSignalPath ||
      statusCommand !== this.statusCommand ||
      rateCommand !== this.rateCommand ||
      signalPathPrefix !== this.signalPathPrefix ||
      pollMs !== this.pollMs;

    if (!changed) return false;

    const shouldRestart = this.started;
    this.stop();
    this.command = command;
    this.staticSignalPath = staticSignalPath;
    this.statusCommand = statusCommand;
    this.rateCommand = rateCommand;
    this.signalPathPrefix = signalPathPrefix;
    this.pollMs = pollMs;
    this.setSignalPath(staticSignalPath || signalPathPrefix);
    if (shouldRestart) this.start();
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.timer = null;
    this.rateTimer = null;
    this.started = false;
    this.rateInFlight = false;
    this.listInFlight = false;
    if (this.statusProcess) {
      this.statusProcess.kill();
      this.statusProcess = null;
    }
  }

  getSignalPath() {
    return this.signalPath || "";
  }

  poll() {
    if (this.inFlight || !this.command) return;

    const [file, ...args] = splitCommand(this.command);
    if (!file) return;

    this.inFlight = true;
    this.exec(
      file,
      args,
      {
        timeout: Math.max(1000, Math.floor(this.pollMs * 0.8)),
        windowsHide: true
      },
      (error, stdout) => {
        this.inFlight = false;
        if (error) {
          this.logger?.debug("HQPlayer signal path command failed", { error: error.message });
          return;
        }

        const nextSignalPath = normalizeSignalPath(stdout);
        this.setSignalPath(nextSignalPath);
      }
    );
  }

  startStatusStream() {
    if (this.statusProcess) return;

    const [file, ...args] = splitCommand(this.statusCommand);
    if (!file) return;

    this.statusProcess = this.spawnProcess(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.statusProcess.stdout?.on("data", (chunk) => {
      this.handleStatusChunk(chunk.toString("utf8"));
    });

    this.statusProcess.stderr?.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) this.logger?.debug("HQPlayer status stderr", { message });
    });

    this.statusProcess.on("exit", () => {
      this.statusProcess = null;
      setTimeout(() => this.startStatusStream(), this.pollMs);
    });
  }

  handleStatusChunk(chunk) {
    this.statusBuffer += chunk;
    const lines = this.statusBuffer.split(/\r?\n/);
    this.statusBuffer = lines.pop() || "";

    for (const line of lines) {
      this.handleStatusLine(line);
    }
  }

  handleStatusLine(line) {
    const status = parseStatusLine(line);
    if (!status) return;

    const nextSignalPath = composeSignalPath({
      prefix: this.signalPathPrefix || this.staticSignalPath,
      outputRateKhz: status.outputRateKhz
    });

    this.setSignalPath(nextSignalPath);
  }

  pollRates() {
    if (this.rateInFlight || !this.rateCommand) return;

    this.rateInFlight = true;
    this.capturePtyCommand(this.rateCommand, (output) => {
      this.rateInFlight = false;
      const stateOutput = parseStateOutput(output);
      if (stateOutput) this.lastStateOutput = stateOutput;
      const rateKhz = stateOutput?.outputRateKhz || parseTransportRateKhz(output) || highestRateKhz(output);
      this.publishStateOutput({
        ...stateOutput,
        outputRateKhz: rateKhz
      });
      this.refreshNamedLists(stateOutput);
    });
  }

  publishStateOutput(stateOutput) {
    const nextSignalPath = composeSignalPath({
      prefix: this.signalPathPrefix || this.staticSignalPath,
      outputFormat: stateOutput?.outputFormat,
      outputRateKhz: stateOutput?.outputRateKhz,
      filterName: this.filterNames.get(stateOutput?.filterIndex) || "",
      shaperName: this.shaperNames.get(stateOutput?.shaperIndex) || ""
    });

    this.setSignalPath(nextSignalPath);
  }

  refreshNamedLists(stateOutput) {
    if (this.listInFlight || !this.rateCommand || !this.needsNamedListRefresh(stateOutput)) return;

    const filtersCommand = siblingCommand(this.rateCommand, "--get-filters");
    const shapersCommand = siblingCommand(this.rateCommand, "--get-shapers");
    if (!filtersCommand || !shapersCommand) return;

    this.listInFlight = true;
    this.capturePtyCommand(filtersCommand, (filtersOutput) => {
      const filterNames = parseNamedList(filtersOutput);
      if (filterNames.size) this.filterNames = filterNames;

      this.capturePtyCommand(shapersCommand, (shapersOutput) => {
        const shaperNames = parseNamedList(shapersOutput);
        if (shaperNames.size) this.shaperNames = shaperNames;

        this.listInFlight = false;
        this.lastListSignature = this.createListSignature(this.lastStateOutput);
        if (this.lastStateOutput) this.publishStateOutput(this.lastStateOutput);
      });
    });
  }

  needsNamedListRefresh(stateOutput) {
    if (!stateOutput) return false;

    const signature = this.createListSignature(stateOutput);
    if (signature !== this.lastListSignature) return true;
    if (Number.isFinite(stateOutput.filterIndex) && !this.filterNames.has(stateOutput.filterIndex)) return true;
    if (
      stateOutput.outputFormat === "SDM" &&
      Number.isFinite(stateOutput.shaperIndex) &&
      !this.shaperNames.has(stateOutput.shaperIndex)
    ) {
      return true;
    }

    return false;
  }

  createListSignature(stateOutput) {
    if (!stateOutput) return "";
    return [
      stateOutput.outputFormat || "",
      Number.isFinite(stateOutput.filterIndex) ? stateOutput.filterIndex : "",
      Number.isFinite(stateOutput.shaperIndex) ? stateOutput.shaperIndex : ""
    ].join("|");
  }

  setSignalPath(nextSignalPath) {
    if (!nextSignalPath || nextSignalPath === this.signalPath) return false;

    const previousSignalPath = this.signalPath;
    this.signalPath = nextSignalPath;
    this.logger?.info(`HQPlayer signal path: ${nextSignalPath}`);
    this.emit("signalPathChanged", {
      signalPath: nextSignalPath,
      previousSignalPath
    });
    return true;
  }

  capturePtyCommand(command, callback) {
    const workerPath = path.join(__dirname, "hqplayerPtyWorker.js");
    const encodedCommand = Buffer.from(command, "utf8").toString("base64");
    const timeoutMs = Math.max(1000, Math.floor(this.pollMs * 0.8));

    this.exec(
      process.execPath,
      [workerPath, encodedCommand, String(timeoutMs)],
      {
        timeout: timeoutMs + 1000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout) => {
        if (error) {
          this.logger?.debug("HQPlayer PTY worker failed", { error: error.message });
          callback("");
          return;
        }

        callback(stdout);
      }
    );
  }
}

module.exports = {
  HQPlayerStatusProvider,
  composeSignalPath,
  formatRate,
  formatDsdRate,
  highestRateKhz,
  normalizeSignalPath,
  normalizeOutputFormat,
  parseNamedList,
  parseRates,
  parseStateOutput,
  parseStateRateKhz,
  parseStatusLine,
  parseTransportRateKhz,
  stripAnsi,
  siblingCommand,
  splitCommand
};
