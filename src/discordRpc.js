const EventEmitter = require("events");
const RPC = require("discord-rpc");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DiscordRpcClient extends EventEmitter {
  constructor({ clientId, logger }) {
    super();
    this.clientId = clientId;
    this.logger = logger;
    this.client = null;
    this.ready = false;
    this.pendingActivity = undefined;
    this.lastSentHadEndTimestamp = false;
    this.started = false;
    this.reconnectTimer = null;
    this.loginInFlight = false;
    this.createClient();
  }

  createClient() {
    this.client = new RPC.Client({ transport: "ipc" });
    this.client.on("ready", () => {
      this.ready = true;
      this.loginInFlight = false;
      this.logger.info("Connected to Discord via discord-rpc");
      this.emit("connected");
      if (this.pendingActivity !== undefined) {
        const activity = this.pendingActivity;
        this.pendingActivity = undefined;
        this.setActivity(activity);
      }
    });

    this.client.on("disconnected", () => {
      this.ready = false;
      this.loginInFlight = false;
      this.logger.warn("Discord RPC disconnected");
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.client.on("error", (error) => {
      this.logger.warn("Discord RPC error", { error: error.message });
    });
  }

  start() {
    if (!this.clientId) {
      throw new Error("DISCORD_CLIENT_ID is required.");
    }
    if (this.loginInFlight) return;

    this.started = true;
    this.loginInFlight = true;
    RPC.register(this.clientId);
    this.client.login({ clientId: this.clientId }).catch((error) => {
      this.ready = false;
      this.loginInFlight = false;
      this.logger.warn("Discord RPC login failed; retrying in 5 seconds", {
        error: error.message
      });
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createClient();
      this.start();
    }, 5000);
  }

  setActivity(activity) {
    if (!this.ready) {
      this.pendingActivity = activity;
      return;
    }

    if (!activity) {
      return this.clearActivity();
    }

    const currentHasEndTimestamp = Number.isFinite(activity.endTimestamp);
    const send = () => this.sendActivity(activity).then(() => {
      this.lastSentHadEndTimestamp = currentHasEndTimestamp;
    });

    if (!currentHasEndTimestamp) {
      this.logger.info("Clearing Discord activity before publishing open-ended stream");
      return this.client.clearActivity()
        .then(() => delay(500))
        .then(() => {
          this.lastSentHadEndTimestamp = false;
          return send();
        })
        .catch((error) => {
          this.logger.warn("Discord local-to-radio reset failed", { error: error.message });
        });
    }

    return send().catch((error) => {
      this.logger.warn("Discord setActivity failed", { error: error.message });
    });
  }

  sendActivity(activity) {
    return this.client.request("SET_ACTIVITY", {
      pid: process.pid,
      activity: this.toRpcWireActivity(activity)
    });
  }

  toRpcWireActivity(activity) {
    const timestamps = {};
    if (Number.isFinite(activity.startTimestamp)) {
      timestamps.start = activity.startTimestamp;
    }
    if (Number.isFinite(activity.endTimestamp)) {
      timestamps.end = activity.endTimestamp;
    }

    const wireActivity = {
      type: activity.type,
      state: activity.state,
      details: activity.details,
      timestamps: Object.keys(timestamps).length ? timestamps : undefined,
      instance: !!activity.instance
    };

    if (activity.largeImageKey || activity.largeImageText) {
      wireActivity.assets = {
        large_image: activity.largeImageKey,
        large_text: activity.largeImageText
      };
    }

    return wireActivity;
  }

  clearActivity() {
    this.pendingActivity = undefined;
    this.lastSentHadEndTimestamp = false;
    if (!this.ready) return Promise.resolve();

    return this.client.clearActivity().catch((error) => {
      this.logger.warn("Discord clearActivity failed", { error: error.message });
    });
  }

  stop() {
    this.started = false;
    this.ready = false;
    this.loginInFlight = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    return this.client?.destroy?.().catch?.(() => undefined);
  }
}

module.exports = { DiscordRpcClient };
