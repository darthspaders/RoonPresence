const assert = require("node:assert/strict");
const test = require("node:test");
const {
  HQPlayerStatusProvider,
  composeSignalPath,
  formatDsdRate,
  formatRate,
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
} = require("../src/hqplayerStatus");

test("normalizes first non-empty signal path line", () => {
  assert.equal(
    normalizeSignalPath("\r\npoly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz\r\n"),
    "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz"
  );
});

test("splits quoted command arguments", () => {
  assert.deepEqual(splitCommand('"C:\\Program Files\\tool.exe" --status'), [
    "C:\\Program Files\\tool.exe",
    "--status"
  ]);
});

test("provider polls command output into cached signal path", async () => {
  const provider = new HQPlayerStatusProvider({
    command: "hqp-status --signal",
    pollMs: 5000,
    logger: { info() {}, debug() {} },
    exec: (file, args, options, callback) => {
      assert.equal(file, "hqp-status");
      assert.deepEqual(args, ["--signal"]);
      callback(null, "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz\n");
    }
  });

  provider.poll();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(provider.getSignalPath(), "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
});

test("parses HQPlayer status stream line", () => {
  const status = parseStatusLine(
    "status: 2 1/1 9:49 -6.020600 0/385 590.706667/0.000000 9:50/-9:-50/0:0 {n} (1502879)"
  );

  assert.deepEqual(status, {
    state: 2,
    trackIndex: 1,
    trackCount: 1,
    volumeDb: -6.0206,
    position: 0,
    duration: 385,
    outputRateKhz: 590.706667,
    inputRateKhz: 0
  });
});

test("formats HQPlayer output rate", () => {
  assert.equal(formatRate(590.706667), "590.7kHz");
  assert.equal(formatRate(768), "768kHz");
});

test("formats HQPlayer output mode", () => {
  assert.equal(normalizeOutputFormat("0"), "PCM");
  assert.equal(normalizeOutputFormat("1"), "SDM");
  assert.equal(normalizeOutputFormat("PCM"), "PCM");
});

test("formats DSD output rate", () => {
  assert.equal(formatDsdRate(22579.2), "DSD512");
  assert.equal(formatRate(22579.2, "SDM"), "22.5792MHz");
});

test("composes signal path prefix with live output rate", () => {
  assert.equal(
    composeSignalPath({
      prefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      outputRateKhz: 590.706667
    }),
    "poly-sinc-gauss-hires-mp, TPDF, PCM, 590.7kHz"
  );
});

test("provider updates signal path from status stream lines", () => {
  const provider = new HQPlayerStatusProvider({
    signalPathPrefix: "poly-sinc-gauss-hires-mp, TPDF, PCM",
    logger: { info() {}, debug() {} }
  });

  provider.handleStatusChunk(
    "status: 2 1/1 9:49 -6.020600 0/385 590.706667/0.000000 9:50/-9:-50/0:0 {n} (1502879)\n"
  );

  assert.equal(provider.getSignalPath(), "poly-sinc-gauss-hires-mp, TPDF, PCM, 590.7kHz");
});

test("provider exposes signal path prefix before status stream produces output", () => {
  const provider = new HQPlayerStatusProvider({
    signalPathPrefix: "poly-sinc-gauss-hires-mp, TPDF, PCM",
    logger: { info() {}, debug() {} }
  });

  assert.equal(provider.getSignalPath(), "poly-sinc-gauss-hires-mp, TPDF, PCM");
});

test("strips ANSI console sequences from HQPlayer PTY output", () => {
  assert.equal(stripAnsi("\u001b[?25l\u001b[2J[10] 768000\r\n"), "[10] 768000\r\n");
});

test("parses HQPlayer rate list and picks highest rate", () => {
  const output = [
    "\u001b[?25l\u001b[2J[0] 0",
    "[1] 44100",
    "[9] 705600",
    "[10] 768000"
  ].join("\r\n");

  assert.deepEqual(parseRates(output), [44100, 705600, 768000]);
  assert.equal(highestRateKhz(output), 768);
});

test("parses HQPlayer active transport rate", () => {
  assert.equal(parseTransportRateKhz("transport: 240 \"\"\r\n"), 192);
});

test("parses HQPlayer active state output rate", () => {
  const output = "state: 2 1:(42, 42 (40, 7), 10) -6.020600 0:768000 0 0 0 0 1 1 ''";

  assert.equal(parseStateRateKhz(output), 768);
  assert.deepEqual(parseStateOutput(output), {
    outputFormat: "PCM",
    outputRateKhz: 768,
    filterIndex: 42,
    shaperIndex: 7,
    rateIndex: 10
  });
  assert.equal(
    composeSignalPath({
      prefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      outputFormat: parseStateOutput(output).outputFormat,
      outputRateKhz: parseStateRateKhz(output)
    }),
    "poly-sinc-gauss-hires-mp, PCM, 768kHz"
  );
});

test("state output replaces the format field", () => {
  const output = "state: 2 1:(42, 42 (40, 7), 10) -6.020600 1:11289600 0 0 0 0 1 1 ''";
  const parsed = parseStateOutput(output);

  assert.deepEqual(parsed, {
    outputFormat: "SDM",
    outputRateKhz: 11289.6,
    filterIndex: 42,
    shaperIndex: 7,
    rateIndex: 10
  });
  assert.equal(
    composeSignalPath({
      prefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      outputFormat: parsed.outputFormat,
      outputRateKhz: parsed.outputRateKhz
    }),
    "poly-sinc-gauss-hires-mp, SDM, DSD256, 11.2896MHz"
  );
});

test("PCM output omits shaper from the signal path", () => {
  assert.equal(
    composeSignalPath({
      prefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      filterName: "poly-sinc-gauss-hires-mp",
      shaperName: "TPDF",
      outputFormat: "PCM",
      outputRateKhz: 768
    }),
    "poly-sinc-gauss-hires-mp, PCM, 768kHz"
  );
});

test("SDM output includes modulator, DSD family, and MHz rate", () => {
  assert.equal(
    composeSignalPath({
      prefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      filterName: "poly-sinc-gauss-hires-mp",
      shaperName: "ASDM7EC-light",
      outputFormat: "SDM",
      outputRateKhz: 22579.2
    }),
    "poly-sinc-gauss-hires-mp, ASDM7EC-light, SDM, DSD512, 22.5792MHz"
  );
});

test("live HQPlayer filter replaces prefix filter", () => {
  assert.equal(
    composeSignalPath({
      prefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      filterName: "poly-sinc-gauss-hires-lp",
      shaperName: "ASDM5EC-ul 512+fs",
      outputFormat: "SDM",
      outputRateKhz: 22579.2
    }),
    "poly-sinc-gauss-hires-lp, ASDM5EC-ul 512+fs, SDM, DSD512, 22.5792MHz"
  );
});

test("parses HQPlayer named lists and sibling commands", () => {
  const names = parseNamedList("[7] \"ASDM7EC-light\" 7\r\n[42] \"poly-sinc-gauss-hires-mp\" 42\r\n");

  assert.equal(names.get(7), "ASDM7EC-light");
  assert.equal(
    siblingCommand('"C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe" localhost --state', "--get-shapers"),
    '"C:\\Program Files\\Signalyst\\HQPlayer 5 Desktop\\hqp5-control.exe" localhost --get-shapers'
  );
});

test("provider emits signalPathChanged when signal path changes", () => {
  const provider = new HQPlayerStatusProvider({
    signalPathPrefix: "poly-sinc-gauss-hires-mp, TPDF, PCM",
    logger: { info() {}, debug() {} }
  });
  const changes = [];
  provider.on("signalPathChanged", (change) => changes.push(change));

  assert.equal(provider.setSignalPath("poly-sinc-gauss-hires-mp, TPDF, PCM, 192kHz"), true);
  assert.equal(provider.setSignalPath("poly-sinc-gauss-hires-mp, TPDF, PCM, 192kHz"), false);
  assert.deepEqual(changes, [
    {
      previousSignalPath: "poly-sinc-gauss-hires-mp, TPDF, PCM",
      signalPath: "poly-sinc-gauss-hires-mp, TPDF, PCM, 192kHz"
    }
  ]);
});

test("provider updateConfig reloads signal path settings", () => {
  const provider = new HQPlayerStatusProvider({
    signalPathPrefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 192kHz",
    logger: { info() {}, debug() {} }
  });
  const changes = [];
  provider.on("signalPathChanged", (change) => changes.push(change));

  assert.equal(
    provider.updateConfig({
      signalPathPrefix: "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz",
      pollMs: 5000
    }),
    true
  );

  assert.equal(provider.getSignalPath(), "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
  assert.equal(changes.at(-1).signalPath, "poly-sinc-gauss-hires-mp, TPDF, PCM, 768kHz");
});

test("provider does not refresh HQPlayer name lists when state indexes are unchanged", () => {
  const provider = new HQPlayerStatusProvider({
    rateCommand: "hqp localhost --state",
    logger: { info() {}, debug() {} }
  });
  const stateOutput = {
    outputFormat: "PCM",
    outputRateKhz: 768,
    filterIndex: 42,
    shaperIndex: 7
  };

  assert.equal(provider.needsNamedListRefresh(stateOutput), true);
  provider.filterNames.set(42, "poly-sinc-gauss-hires-mp");
  provider.shaperNames.set(7, "TPDF");
  provider.lastListSignature = provider.createListSignature(stateOutput);

  assert.equal(provider.needsNamedListRefresh(stateOutput), false);
});
