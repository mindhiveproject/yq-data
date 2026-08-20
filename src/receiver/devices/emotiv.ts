import {
  Modality,
  StreamMetadata,
  ProcessingStage,
  StreamIdentifier,
} from "../../data_stream.interface";
import { BaseReceiver } from "../base_receiver";

/**
 * Available data streams from EMOTIV devices.
 *
 * Each stream provides different types of data from the EMOTIV headset:
 *
 * @property {string} eeg - Raw EEG data from the headset electrodes (128/256 Hz)
 * @property {string} mot - Motion data including accelerometer and gyroscope (32-128 Hz)
 * @property {string} dev - Device status including battery level, signal strength, and contact quality (2 Hz)
 * @property {string} eq - Detailed EEG quality metrics for each sensor (2 Hz)
 * @property {string} pow - Frequency band power data (alpha, beta, gamma, theta) for each sensor (8 Hz)
 * @property {string} met - Performance metrics including stress, engagement, relaxation, interest, focus (2 Hz)
 * @property {string} com - Mental command detection results (requires trained profile) (8 Hz)
 * @property {string} fac - Facial expression detection results (32 Hz)
 * @property {string} sys - System events for mental commands and facial expressions training
 */
type DataStreams =
  | "eeg"
  | "mot"
  | "dev"
  | "eq"
  | "pow"
  | "met"
  | "com"
  | "fac"
  | "sys";

/**
 * Maps a data stream type to its metadata properties.
 *
 * @param stream - The EMOTIV data stream to map to metadata
 * @returns Partial metadata for the specified stream including modality, sampling rate and processing stage
 * @throws Error if the stream type is unknown
 */
function dataStreamToMetaData(stream: DataStreams): Partial<StreamMetadata> {
  switch (stream) {
    case "eeg":
      return {
        modality: Modality.EEG,
        samplingRate: 256, // 128 or 256 Hz depending on headset and settings
        processingHistory: [{ stage: ProcessingStage.RAW }],
        name: "raw_eeg",
      };
    case "mot":
      return {
        modality: Modality.ACCELEROMETER, // Primary motion modality
        samplingRate: 64, // 32, 64, 128 Hz depending on headset (6.4 Hz for MN8)
        processingHistory: [{ stage: ProcessingStage.RAW }],
        name: "motion_data",
      };
    case "dev":
      return {
        modality: Modality.UNKNOWN,
        samplingRate: 2, // Fixed at 2 Hz
        processingHistory: [{ stage: ProcessingStage.RAW }],
        name: "device_info",
      };
    case "eq":
      return {
        modality: Modality.EEG,
        samplingRate: 2, // Fixed at 2 Hz
        processingHistory: [{ stage: ProcessingStage.FEATURES }],
        name: "eeg_quality",
      };
    case "pow":
      return {
        modality: Modality.EEG,
        samplingRate: 8, // Fixed at 8 Hz
        processingHistory: [{ stage: ProcessingStage.FEATURES }],
        name: "band_power",
      };
    case "met":
      return {
        modality: Modality.EEG,
        samplingRate: 2, // 2 Hz with license containing "pm" scope, 0.1 Hz otherwise
        processingHistory: [{ stage: ProcessingStage.FEATURES }],
        name: "performance_metrics",
      };
    case "com":
      return {
        modality: Modality.EEG,
        samplingRate: 8, // Fixed at 8 Hz
        processingHistory: [{ stage: ProcessingStage.INFERRED }],
        name: "mental_commands",
      };
    case "fac":
      return {
        modality: Modality.EEG,
        samplingRate: 32, // Fixed at 32 Hz
        processingHistory: [{ stage: ProcessingStage.INFERRED }],
        name: "facial_expressions",
      };
    case "sys":
      return {
        modality: Modality.UNKNOWN,
        samplingRate: undefined, // No fixed rate
        processingHistory: [{ stage: ProcessingStage.RAW }],
        name: "system_events",
      };
    default:
      throw new Error(`Unknown data stream: ${stream}`);
  }
}

/**
 * Channel labels used when Cortex does not report a stream's columns.
 *
 * The EEG layout is the 14-electrode EPOC arrangement; headsets with a
 * different montage will report their own columns and never reach this table.
 */
const FALLBACK_COLUMNS: Partial<Record<DataStreams, string[]>> = {
  eeg: [
    "AF3", "F7", "F3", "FC5", "T7", "P7", "O1",
    "O2", "P8", "T8", "FC6", "F4", "F8", "AF4",
  ],
  mot: [
    "Q0", "Q1", "Q2", "Q3",
    "ACCX", "ACCY", "ACCZ",
    "MAGX", "MAGY", "MAGZ",
  ],
  met: [
    "engagement", "excitement", "long term excitement",
    "stress", "relaxation", "interest", "focus",
  ],
};

/**
 * EMOTIV headset receiver implementation that connects to the Cortex API
 * and processes data streams from EMOTIV devices.
 */
export class EMOTIVReceiver extends BaseReceiver {
  deviceName: string = "EMOTIV";
  deviceID: string | number | undefined;
  modalities: Modality[] = [
    Modality.EEG,
    Modality.ACCELEROMETER,
    Modality.GYROSCOPE,
  ];
  user: UserParams;
  cortex: Cortex;
  selectedDataStreams: DataStreams[] = [];

  constructor(user: UserParams, socketURL: string = "wss://localhost:6868") {
    super();
    this.user = user;
    this.cortex = new Cortex(user, socketURL);
    this.cortex.subscribeToConnectionStatus((status) => {
      this.isConnected = status;
    });
  }

  public async connect(
    dataStreams: DataStreams[],
    timeoutDuration: number = 10000
  ): Promise<void> {
    console.log("[EMOTIVReceiver] Connecting to EMOTIV headset...");
    console.log("[EMOTIVReceiver] Requested data streams:", dataStreams);

    if (this.isConnected) {
      console.warn("Already connected to EMOTIV headset.");
      return;
    }

    this.selectedDataStreams = dataStreams ?? [];
    console.log(
      "[EMOTIVReceiver] Selected data streams:",
      this.selectedDataStreams
    );

    try {
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(
            new Error(
              `EMOTIV connection timed out after ${
                timeoutDuration / 1000
              } seconds.`
            )
          );
        }, timeoutDuration)
      );
      await Promise.race([
        this.cortex.sub([...this.selectedDataStreams]),
        timeoutPromise,
      ]);
    } catch (error) {
      console.error("[EMOTIVReceiver] Error during subscription:", error);
      throw error;
    }

    console.log(
      "[EMOTIVReceiver] Connection status after subscription:",
      this.isConnected
    );
    if (!this.isConnected) {
      console.error("[EMOTIVReceiver] Failed to connect to EMOTIV headset.");
      throw new Error("Connection failed");
    }

    this.deviceID = this.cortex.deviceId;
    console.log("[EMOTIVReceiver] Device ID set to:", this.deviceID);

    console.log(
      `[EMOTIVReceiver] Initializing ${this.selectedDataStreams.length} streams`
    );
    for (const stream of this.selectedDataStreams) {
      console.log(`[EMOTIVReceiver] Processing stream: ${stream}`);
      // Extract metadata properties with defaults for cleaner access
      const metadata = dataStreamToMetaData(stream);
      const {
        modality = Modality.UNKNOWN,
        name,
        samplingRate,
        processingHistory = [],
      } = metadata;

      // Get processing stage from history or default to RAW
      const processingStage =
        processingHistory[0]?.stage || ProcessingStage.RAW;

      console.log(`[EMOTIVReceiver] Stream ${stream} metadata:`, {
        modality,
        name,
        samplingRate,
        processingStage,
        processingHistory,
      });
      // Cortex reports the column layout of each stream when the subscription
      // succeeds; those column names are the channel labels. Falling back to
      // a static table keeps older Cortex builds working.
      const columns =
        this.cortex.streamColumns[stream] ?? FALLBACK_COLUMNS[stream] ?? [];
      const channelInfo = columns.map((label, index) => ({ index, label }));

      // Initialize the stream with structured parameters
      this.initializeStream({
        modality,
        processingStage,
        name,
        additionalMetadata: {
          samplingRate,
          processingHistory,
          ...(channelInfo.length > 0
            ? { channelInfo, channelCount: channelInfo.length }
            : {}),
          deviceInfo: {
            model: this.deviceName,
            id: this.deviceID || "unknown",
            modalities: this.modalities,
          },
        },
      });
    }
  }

  public startStream(): void {
    if (!this.isConnected) {
      console.warn("Device is not connected. Call the connect() method first.");
    }
    this.cortex.stream(this.handleDataStream.bind(this));
  }

  public stopStream(): void {
    if (!this.isConnected) {
      console.warn("Device is disconnected.");
    } else {
      console.warn("Call disconnect() to stop streaming.");
    }
  }

  public async disconnect(): Promise<void> {
    if (this.isConnected) {
      this.cortex.disconnectDevice();
      this.onDestroy();
    }
  }

  // Notice this is an arrow‐function so `this` is always correct:
  private handleDataStream = (sample: any): void => {
    let time;

    for (const streamName of Object.keys(sample)) {
      if (streamName === "sid") {
        continue;
      }
      if (streamName === "time") {
        time = sample.time;
        continue;
      }
      const metadata = dataStreamToMetaData(streamName as DataStreams);

      this.update(
        {
          modality: metadata.modality || Modality.UNKNOWN,
          processingStage:
            metadata.processingHistory?.[0]?.stage || ProcessingStage.RAW,
          name: metadata.name,
        },
        sample[streamName],
        time
      );
    }
  };
}

/**
 * UserParams authentication parameters required for EMOTIV Cortex API access.
 *
 * @property clientId - Cortex API client ID
 * @property clientSecret - Cortex API client secret
 * @property license - Optional license key for premium features
 * @property debit - Optional debit amount for usage-based pricing
 */
interface UserParams {
  clientId: string;
  clientSecret: string;
  license?: string;
  debit?: number;
}

/**
 * Communication interface to the EMOTIV Cortex API.
 * Handles authentication, session management, and data subscription.
 */

type DataHandler = (data: any) => void;

export class Cortex {
  public socket: WebSocket;
  private user: UserParams;
  public authToken?: string;
  public sessionId?: string;
  public _connectionStatus: boolean = false;
  public deviceId?: string | number;
  /** Column names Cortex reported per subscribed stream, keyed by stream name. */
  public streamColumns: Record<string, string[]> = {};
  private streamHandler: (data: any) => void = () => {};

  private connectionListeners: ((status: boolean) => void)[] = [];
  public subscribeToConnectionStatus(
    callback: (status: boolean) => void
  ): void {
    this.connectionListeners.push(callback);
    callback(this._connectionStatus); // Call immediately with current status
  }

  private set connectionStatus(status: boolean) {
    this._connectionStatus = status;
    for (const listener of this.connectionListeners) {
      listener(status);
    }
  }

  constructor(user: UserParams, socketUrl: string) {
    this.user = user;
    this.socket = new WebSocket(socketUrl);
  }

  private requestAccess(): Promise<any> {
    console.log("[Cortex] Requesting access");
    return new Promise((resolve, reject) => {
      const REQUEST_ACCESS_ID = 1;
      const req = {
        jsonrpc: "2.0",
        method: "requestAccess",
        params: {
          clientId: this.user.clientId,
          clientSecret: this.user.clientSecret,
        },
        id: REQUEST_ACCESS_ID,
      };

      this.socket.send(JSON.stringify(req));

      const onMessage = (ev: MessageEvent) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.id === REQUEST_ACCESS_ID) {
          this.socket.removeEventListener("message", onMessage);
          resolve(parsed);
        }
      };
      this.socket.addEventListener("message", onMessage);
    });
  }

  private authorize(): Promise<string> {
    return new Promise((resolve, reject) => {
      const AUTHORIZE_ID = 4;
      const req = {
        jsonrpc: "2.0",
        method: "authorize",
        params: {
          clientId: this.user.clientId,
          clientSecret: this.user.clientSecret,
          license: this.user.license,
          debit: this.user.debit,
        },
        id: AUTHORIZE_ID,
      };

      this.socket.send(JSON.stringify(req));

      const onMessage = (ev: MessageEvent) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.id === AUTHORIZE_ID) {
          this.socket.removeEventListener("message", onMessage);

          if (parsed.error) {
            console.error("[Cortex] authorize ERROR:", parsed.error);
            reject(parsed.error);
          } else {
            const token = parsed.result.cortexToken;

            resolve(token);
          }
        }
      };
      this.socket.addEventListener("message", onMessage);
    });
  }

  private createSession(
    authToken: string,
    headsetId: string | number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const CREATE_SESSION_ID = 5;
      let sessionId: string;

      const attemptCreate = () => {
        const req = {
          jsonrpc: "2.0",
          id: CREATE_SESSION_ID,
          method: "createSession",
          params: {
            cortexToken: authToken,
            headset: headsetId,
            status: "active",
          },
        };
        this.socket.send(JSON.stringify(req));
      };

      // Wait until we know the headset is connected
      const checkHeadset = async () => {
        try {
          const qh = await this.queryHeadsetId();

          const found = qh.result.find(
            (h: any) =>
              String(h.id) === String(headsetId) && h.status === "connected"
          );

          if (found) {
            clearInterval(intervalId);
            attemptCreate();

            const onCreateResp = (ev: MessageEvent) => {
              let parsed: any = null;
              try {
                parsed = JSON.parse(ev.data);
              } catch {
                return;
              }
              if (parsed.id === CREATE_SESSION_ID) {
                console.log(
                  "[Cortex] Received createSession response:",
                  parsed
                );
                this.socket.removeEventListener("message", onCreateResp);
                if (parsed.error) {
                  console.error("[Cortex] createSession ERROR:", parsed.error);
                  reject(parsed.error);
                } else {
                  sessionId = parsed.result.id;
                  console.log("[Cortex] Session created with ID:", sessionId);
                  resolve(sessionId);
                }
              }
            };
            this.socket.addEventListener("message", onCreateResp);
          } else {
            console.log(
              "[Cortex] Headset not yet connected. Available headsets:",
              qh.result
            );
          }
        } catch (err) {
          console.error("[Cortex] Error in queryHeadsetId loop:", err);
          clearInterval(intervalId);
          reject(err);
        }
      };

      // First, try immediately. Then poll every 30s until a connected headset appears.
      checkHeadset();
      const intervalId = setInterval(() => {
        console.log("[Cortex] Polling for headset connection...");
        checkHeadset();
      }, 30000);
    });
  }

  private queryHeadsetId(): Promise<any> {
    console.log("[Cortex] Querying available headsets");
    return new Promise((resolve, reject) => {
      const QUERY_HEADSET_ID = 2;
      const req = {
        jsonrpc: "2.0",
        id: QUERY_HEADSET_ID,
        method: "queryHeadsets",
        params: {},
      };

      this.socket.send(JSON.stringify(req));

      const onMsg = (ev: MessageEvent) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.id === QUERY_HEADSET_ID) {
          console.log("[Cortex] Received headset list:", parsed);
          this.socket.removeEventListener("message", onMsg);
          resolve(parsed);
        }
      };
      this.socket.addEventListener("message", onMsg);
    });
  }

  private subRequest(
    streams: string[],
    authToken: string,
    sessionId: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const SUB_REQUEST_ID = 6;
      const req = {
        jsonrpc: "2.0",
        method: "subscribe",
        params: {
          cortexToken: authToken,
          session: sessionId,
          streams,
        },
        id: SUB_REQUEST_ID,
      };

      this.socket.send(JSON.stringify(req));

      const onMsg = (ev: MessageEvent) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        // The Cortex API will typically reply with {"id":6, "result": { ... }} once subscribe succeeds,
        // and then start sending real-time data on separate "stream" messages (without "id").
        if (parsed.id === SUB_REQUEST_ID) {
          if (parsed.error) {
            reject(new Error(`[Cortex] subscribe ERROR: ${parsed.error}`));
            return;
          }
          if (parsed.result?.failure && parsed.result.failure.length > 0) {
            for (const failure of parsed.result.failure) {
              reject(
                new Error(
                  `[Cortex] subscribe FAILURE for stream ${failure.streamName}: code ${failure.code} - ${failure.message}`
                )
              );
              return;
            }
          }

          // Cortex names each subscribed stream's columns here — the only
          // place the channel layout is reported — so capture it before the
          // data messages start arriving.
          for (const success of parsed.result?.success ?? []) {
            if (success.streamName && Array.isArray(success.cols)) {
              this.streamColumns[success.streamName] = success.cols;
            }
          }

          // Successfully subscribed
          resolve();

          // We do NOT remove this listener here because subsequent messages (actual EEG packets)
          // might not contain "id:6" but will still come over the same socket.
        }
      };
      this.socket.addEventListener("message", onMsg);
    });
  }

  public async checkGrantAccessAndQuerySessionInfo(): Promise<void> {
    console.log("[Cortex] Starting connection process");
    try {
      const accessResp = await this.requestAccess();
      console.log("[Cortex] Access response:", accessResp);

      if (accessResp.error) {
        console.error("[Cortex] Access request denied:", accessResp.error);
        throw new Error(
          "Access request denied: " + JSON.stringify(accessResp.error)
        );
      }
      if (!accessResp.result.accessGranted) {
        console.error("[Cortex] User denied access in Cortex UI");
        throw new Error("User did not grant access in Cortex UI");
      }

      console.log("[Cortex] Access granted, authorizing");
      const token = await this.authorize();
      this.authToken = token;
      console.log("[Cortex] Authorization complete");

      const qh = await this.queryHeadsetId();
      console.log("[Cortex] Available headsets:", qh.result);

      const anyHeadset =
        Array.isArray(qh.result) &&
        qh.result.length > 0 &&
        qh.result.some((h: any) => h.status === "connected");

      if (!anyHeadset) {
        console.error("[Cortex] No connected headset found");
        throw new Error("No connected headset found");
      }

      const chosenHeadsetId = qh.result.find(
        (h: any) => h.status === "connected"
      ).id;
      console.log("[Cortex] Selected headset:", chosenHeadsetId);
      this.deviceId = chosenHeadsetId;

      console.log("[Cortex] Controlling device");
      await this.controlDevice(chosenHeadsetId);

      console.log("[Cortex] Creating session");
      const session = await this.createSession(token, chosenHeadsetId);
      this.sessionId = session;
      console.log("[Cortex] Session established:", session);

      this.connectionStatus = true;
      console.log("[Cortex] Connection successful");
    } catch (error) {
      console.error("[Cortex] Connection process failed:", error);
      throw error;
    }
  }

  public sub(streams: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const doSubscribe = async () => {
        try {
          // Check if socket is closed and reopen if needed
          if (this.socket.readyState === WebSocket.CLOSED) {
            console.log(
              "[Cortex] WebSocket is closed, creating a new connection"
            );
            this.socket = new WebSocket(this.socket.url);

            // Wait for the socket to open
            await new Promise<void>((resolve) => {
              this.socket.addEventListener("open", () => resolve(), {
                once: true,
              });
            });
          }

          await this.checkGrantAccessAndQuerySessionInfo();
          await this.subRequest(streams, this.authToken!, this.sessionId!);
          resolve(); // Resolve the promise when subscription is successful
        } catch (e) {
          reject(e);
        }
      };

      if (this.socket.readyState === WebSocket.OPEN) {
        doSubscribe();
      } else if (this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.addEventListener(
          "open",
          () => {
            doSubscribe();
          },
          { once: true }
        );
      } else {
        this.socket = new WebSocket(this.socket.url);
        this.socket.addEventListener(
          "open",
          () => {
            doSubscribe();
          },
          { once: true }
        );
      }
    });
  }

  public stream(dataHandler: DataHandler): void {
    console.log("[Cortex] Starting data streaming");
    this.streamHandler = (message) => dataHandler(JSON.parse(message.data));
    this.socket.addEventListener("message", this.streamHandler);
  }

  private controlDevice(headsetId: string | number): Promise<void> {
    console.log("[Cortex] Sending control command to headset:", headsetId);
    return new Promise((resolve, reject) => {
      const CONTROL_DEVICE_ID = 3;
      const req = {
        jsonrpc: "2.0",
        id: CONTROL_DEVICE_ID,
        method: "controlDevice",
        params: {
          command: "connect",
          headset: headsetId,
        },
      };
      this.socket.send(JSON.stringify(req));

      const onMsg = (ev: MessageEvent) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.id === CONTROL_DEVICE_ID) {
          console.log("[Cortex] Received control device response:", parsed);
          this.socket.removeEventListener("message", onMsg);
          if (parsed.error) {
            console.error("[Cortex] Control device error:", parsed.error);
            return reject(parsed.error);
          }
          console.log("[Cortex] Successfully controlled device");
          resolve();
        }
      };
      this.socket.addEventListener("message", onMsg);
    });
  }

  public async disconnectDevice(): Promise<void> {
    console.log("[Cortex] Disconnecting device");
    if (this.connectionStatus) {
      console.log("[Cortex] Removing message listener and closing socket");
      this.socket.removeEventListener("message", this.streamHandler);
      this.socket.close();
      console.log("[Cortex] Device disconnected");
    } else {
      console.log("[Cortex] No active connection to disconnect");
    }
  }
}
