import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listAndroidDevices, listAvds } from "../../utils/adb";
import { listIosSimulators, type IosSimulator } from "../../utils/ios-devices";
import { simctlListDevices } from "../../utils/sim-remote";
import { withRemotePrefix } from "../../utils/device-info";
import { discoverChromiumDevices, type ChromiumDevice } from "../../utils/chromium-discovery";

type IosDevice = IosSimulator & { platform: "ios" };

type IosRemoteDevice = {
  platform: "ios-remote";
  udid: string;
  name: string;
  state: string;
  runtime: string;
};

type AndroidDevice = {
  platform: "android";
  serial: string;
  state: string;
  isEmulator: boolean;
  // "emulator" for a local AVD, "device" for a physical phone (USB or wireless
  // adb). The two are driven by different simulator-server controllers, so the
  // kind is surfaced here for parity with iOS terminology and so consumers can
  // tell a connected phone apart from an emulator at a glance.
  kind: "emulator" | "device";
  model: string | null;
  avdName: string | null;
  sdkLevel: number | null;
};

type ListDevicesResult = {
  devices: Array<IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice>;
  avds: Array<{ name: string }>;
};

function sortIos(a: IosDevice, b: IosDevice): number {
  const aBooted = a.state === "Booted" ? 0 : 1;
  const bBooted = b.state === "Booted" ? 0 : 1;
  if (aBooted !== bBooted) return aBooted - bBooted;
  const aIpad = a.name.includes("iPad") ? 1 : 0;
  const bIpad = b.name.includes("iPad") ? 1 : 0;
  return aIpad - bIpad;
}

function sortAndroid(a: AndroidDevice, b: AndroidDevice): number {
  const aReady = a.state === "device" ? 0 : 1;
  const bReady = b.state === "device" ? 0 : 1;
  if (aReady !== bReady) return aReady - bReady;
  const aEmu = a.isEmulator ? 0 : 1;
  const bEmu = b.isEmulator ? 0 : 1;
  return aEmu - bEmu;
}

// Float booted/ready devices to the top of the merged list regardless of
// platform — without this, all iOS entries are emitted before any Android.
function readinessRank(d: IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice): number {
  if (d.platform === "android") return d.state === "device" ? 0 : 1;
  if (d.platform === "chromium") return 0; // Chromium entries are only listed when their CDP is responsive
  return d.state === "Booted" ? 0 : 1; // ios + ios-remote
}

/**
 * List remote iOS simulators via `sim-remote`. Returns [] (silently) if
 * sim-remote isn't installed or the user isn't logged in — list-devices
 * already treats CLI absence as "platform unavailable" rather than failing.
 */
async function listRemoteIosSimulators(): Promise<IosRemoteDevice[]> {
  try {
    const result = await simctlListDevices();
    const out: IosRemoteDevice[] = [];
    for (const [runtime, devices] of Object.entries(result.devices)) {
      for (const d of devices) {
        if (d.isAvailable === false) continue;
        out.push({
          platform: "ios-remote",
          udid: withRemotePrefix(d.udid),
          name: d.name,
          state: d.state,
          runtime,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function sortIosRemote(a: IosRemoteDevice, b: IosRemoteDevice): number {
  const aBooted = a.state === "Booted" ? 0 : 1;
  const bBooted = b.state === "Booted" ? 0 : 1;
  return aBooted - bBooted;
}

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition<Record<string, never>, ListDevicesResult> = {
  id: "list-devices",
  description: `List iOS simulators, Android emulators, connected physical Android devices, and running Chromium apps in one place.
Use at the start of a session to pick a target id ('udid' for iOS entries, 'serial' for Android, 'id' for Chromium) to pass to interaction tools, and to see which targets are already running.
Returns { devices, avds } where each device carries a 'platform' discriminator ('ios', 'android', or 'chromium'), and 'avds' lists Android AVDs that can be booted via boot-device.
Android entries also carry a 'kind' ('emulator' for a local AVD, 'device' for a physical phone connected over USB / wireless adb) — physical phones are detected from \`adb devices\` (any serial that is not an \`emulator-*\` one) and are driven through the same interaction tools as emulators; they do not need boot-device (just connect the phone with USB debugging authorised).
Chromium apps are discovered by probing CDP debugging ports (default 9222; extend via the ARGENT_CHROMIUM_PORTS=<comma-separated-ports> env var). They must already be running with --remote-debugging-port=<port> — use boot-device with chromiumAppPath to launch one.
Booted/ready devices are listed first. Platforms whose CLI is unavailable are silently omitted — an empty result usually means xcode-select or Android platform-tools is not installed.`,
  alwaysLoad: true,
  searchHint:
    "list devices simulators emulators avd serial udid ios android chromium app session start",
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const [ios, iosRemote, android, avds, chromium] = await Promise.all([
      listIosSimulators(),
      listRemoteIosSimulators(),
      listAndroidDevices().catch(() => []),
      listAvds(),
      discoverChromiumDevices().catch(() => []),
    ]);
    const iosTagged: IosDevice[] = ios.map((s) => ({ platform: "ios", ...s }));
    iosTagged.sort(sortIos);
    iosRemote.sort(sortIosRemote);
    const androidTagged: AndroidDevice[] = android.map((d) => ({
      platform: "android",
      serial: d.serial,
      state: d.state,
      isEmulator: d.isEmulator,
      kind: d.isEmulator ? "emulator" : "device",
      model: d.model,
      avdName: d.avdName,
      sdkLevel: d.sdkLevel,
    }));
    androidTagged.sort(sortAndroid);

    const devices: Array<IosDevice | IosRemoteDevice | AndroidDevice | ChromiumDevice> = [
      ...iosTagged,
      ...iosRemote,
      ...androidTagged,
      ...chromium,
    ];
    devices.sort((a, b) => readinessRank(a) - readinessRank(b));

    return { devices, avds };
  },
};
