// A one-shot local sampler. No app control, accessibility, or network access.
import AppKit
import Darwin
import Foundation

let identifiers = Set(CommandLine.arguments.dropFirst())
guard !identifiers.isEmpty, identifiers.count <= 16,
      identifiers.allSatisfy({ $0.count <= 160 }) else { exit(2) }
var length = 0
guard sysctlbyname("kern.bootsessionuuid", nil, &length, nil, 0) == 0,
      length > 0, length < 256 else { exit(3) }
var boot = [CChar](repeating: 0, count: length)
guard sysctlbyname("kern.bootsessionuuid", &boot, &length, nil, 0) == 0 else { exit(3) }
var timebase = mach_timebase_info_data_t()
guard mach_timebase_info(&timebase) == KERN_SUCCESS else { exit(3) }
let continuous = Double(mach_continuous_time()) * Double(timebase.numer) / Double(timebase.denom) / 1e9
var apps: [[String: Any]] = []
for app in NSWorkspace.shared.runningApplications {
    guard !app.isTerminated, let identity = app.bundleIdentifier,
          identifiers.contains(identity) else { continue }
    // An incomplete matching app is unknown, never authoritative absence.
    guard let url = app.bundleURL, let launch = app.launchDate else { exit(4) }
    apps.append(["bundleId": identity, "bundle": url.resolvingSymlinksInPath().path,
                 "pid": Int(app.processIdentifier), "launchedAt": launch.timeIntervalSince1970])
}
guard apps.count <= 128,
      let data = try? JSONSerialization.data(withJSONObject: [
        "apps": apps, "wall": Date().timeIntervalSince1970,
        "continuous": continuous, "boot": String(cString: boot)
      ], options: [.sortedKeys]), data.count <= 65536 else { exit(5) }
FileHandle.standardOutput.write(data)
