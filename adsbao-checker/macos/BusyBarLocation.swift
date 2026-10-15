// The only coordinate sink is a private atomic location.json snapshot.
import AppKit
import CoreLocation
import Darwin
import Foundation

private let applicationID = "app.busybar.location"

// BEGIN AUTHORIZATION_LOCK_POLICY
func shouldReleaseAuthorizationLock(status: String, mayAuthorize: Bool) -> Bool {
    if status == "not_determined" { return !mayAuthorize }
    return ["denied", "restricted", "services_disabled"].contains(status)
}
func shouldRefreshLocationFix(fixAge: Double?, secondsSinceAttempt: Double) -> Bool {
    guard secondsSinceAttempt.isFinite && secondsSinceAttempt >= 60 else { return false }
    guard let age = fixAge else { return true }
    return age.isFinite && age >= 120
}
// END AUTHORIZATION_LOCK_POLICY

final class LocationApplication: NSObject, NSApplicationDelegate, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let runtime: URL
    private let mayAuthorize: Bool
    private let once: Bool
    private let timeout: TimeInterval
    private var attemptedAuthorization = false
    private var updating = false
    private var finishing = false
    private var lastFix: Date?
    private var beganAcquiring: Date?
    private var lastAcquisitionAttempt: Date?
    private var timer: Timer?
    private var signals: [DispatchSourceSignal] = []
    private var lockFD: Int32 = -1

    init(runtime: URL, mayAuthorize: Bool, once: Bool, timeout: TimeInterval) {
        self.runtime = runtime
        self.mayAuthorize = mayAuthorize
        self.once = once
        self.timeout = timeout
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard Bundle.main.bundleIdentifier == applicationID, prepareRuntime() else {
            NSApplication.shared.terminate(nil)
            return
        }
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = kCLDistanceFilterNone
        for signum in [SIGTERM, SIGINT] {
            signal(signum, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signum, queue: .main)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            signals.append(source)
        }
        applyAuthorization()
        guard !finishing else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func prepareRuntime() -> Bool {
        let expected = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/BusyBarAI", isDirectory: true)
        guard runtime.standardizedFileURL.path == expected.standardizedFileURL.path else { return false }
        do {
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true,
                                                   attributes: [.posixPermissions: 0o700])
        } catch { return false }
        var details = stat()
        guard lstat(runtime.path, &details) == 0,
              details.st_mode & S_IFMT == S_IFDIR,
              details.st_uid == getuid(), chmod(runtime.path, 0o700) == 0 else { return false }
        let path = runtime.appendingPathComponent(".location-helper.lock").path
        lockFD = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard lockFD >= 0, fstat(lockFD, &details) == 0,
              details.st_mode & S_IFMT == S_IFREG, details.st_uid == getuid(),
              fchmod(lockFD, 0o600) == 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { return false }
        return true
    }

    private func snapshot(status: String, fix: CLLocation? = nil) {
        var payload: [String: Any] = ["status": status, "updated_at": Date().timeIntervalSince1970]
        if let fix = fix {
            payload["latitude"] = fix.coordinate.latitude
            payload["longitude"] = fix.coordinate.longitude
            payload["accuracy"] = fix.horizontalAccuracy
            payload["timestamp"] = fix.timestamp.timeIntervalSince1970
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
        let temporary = runtime.appendingPathComponent(".location-\(UUID().uuidString).tmp").path
        let destination = runtime.appendingPathComponent("location.json").path
        let fd = open(temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return }
        guard fchmod(fd, 0o600) == 0 else { close(fd); unlink(temporary); return }
        var complete = true
        bytes.withUnsafeBytes { raw in
            guard let address = raw.baseAddress else { complete = false; return }
            var offset = 0
            while offset < raw.count {
                let count = write(fd, address.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { complete = false; break }
                offset += count
            }
        }
        if fsync(fd) != 0 { complete = false }
        close(fd)
        if complete { _ = rename(temporary, destination) }
        unlink(temporary)
    }

    private func report(_ status: String) {
        snapshot(status: status)
        if shouldReleaseAuthorizationLock(status: status, mayAuthorize: mayAuthorize) ||
            (once && status != "acquiring" && status != "not_determined") { finish() }
    }

    private func applyAuthorization() {
        guard !finishing else { return }
        guard CLLocationManager.locationServicesEnabled() else {
            manager.stopUpdatingLocation()
            updating = false
            report("services_disabled")
            return
        }
        switch manager.authorizationStatus {
        case .authorizedAlways:
            if !updating {
                updating = true
                beganAcquiring = Date()
                lastAcquisitionAttempt = beganAcquiring
                report("acquiring")
                manager.startUpdatingLocation()
            }
        case .notDetermined:
            report("not_determined")
            if mayAuthorize && !attemptedAuthorization {
                attemptedAuthorization = true
                beganAcquiring = Date()
                NSApplication.shared.activate(ignoringOtherApps: true)
                manager.requestWhenInUseAuthorization()
            }
        case .denied:
            manager.stopUpdatingLocation()
            updating = false
            report("denied")
        case .restricted:
            manager.stopUpdatingLocation()
            updating = false
            report("restricted")
        @unknown default:
            report("unavailable")
        }
    }

    private func tick() {
        applyAuthorization()
        guard !finishing else { return }
        let now = Date()
        if updating, let attempted = lastAcquisitionAttempt,
           shouldRefreshLocationFix(fixAge: lastFix.map { now.timeIntervalSince($0) },
                                    secondsSinceAttempt: now.timeIntervalSince(attempted)) {
            // Restart the authorized acquisition before its fix expires, even
            // when the Mac is stationary. Cached callbacks retain their actual
            // CLLocation timestamp and can never renew freshness by themselves.
            lastAcquisitionAttempt = now
            manager.stopUpdatingLocation()
            manager.startUpdatingLocation()
        }
        if let began = beganAcquiring, now.timeIntervalSince(began) >= timeout,
           lastFix == nil {
            if manager.authorizationStatus == .notDetermined { snapshot(status: "not_determined") }
            else if updating { snapshot(status: "timeout") }
            if once { finish() }
        }
        if let last = lastFix, now.timeIntervalSince(last) > 300 {
            snapshot(status: "timeout")
            lastFix = nil
            beganAcquiring = now
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { applyAuthorization() }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard !finishing else { return }
        // A late callback cannot restore a fix after permission was revoked.
        guard CLLocationManager.locationServicesEnabled(),
              manager.authorizationStatus == .authorizedAlways
        else { applyAuthorization(); return }
        let now = Date()
        guard let fix = locations.filter({
            CLLocationCoordinate2DIsValid($0.coordinate) &&
            $0.horizontalAccuracy.isFinite && $0.horizontalAccuracy >= 0 && $0.horizontalAccuracy <= 500 &&
            $0.timestamp.timeIntervalSince1970.isFinite &&
            now.timeIntervalSince($0.timestamp) >= 0 && now.timeIntervalSince($0.timestamp) <= 300
        }).max(by: { $0.timestamp < $1.timestamp }) else {
            if lastFix == nil { report("unavailable") }
            return
        }
        if let last = lastFix, fix.timestamp < last { return }
        lastFix = fix.timestamp
        snapshot(status: "ok", fix: fix)
        if once { finish() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard !finishing else { return }
        if let error = error as? CLError, error.code == .denied { applyAuthorization() }
        else { report("unavailable") }
    }

    private func finish() {
        guard !finishing else { return }
        finishing = true
        manager.stopUpdatingLocation()
        timer?.invalidate()
        if lockFD >= 0 { close(lockFD); lockFD = -1 }
        NSApplication.shared.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        manager.stopUpdatingLocation()
        if lockFD >= 0 { close(lockFD); lockFD = -1 }
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
let allowed = Set(["--runtime", "--request-authorization", "--once", "--timeout"])
var runtime = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/BusyBarAI", isDirectory: true)
var timeout: TimeInterval = 30
var index = 0
while index < arguments.count {
    let argument = arguments[index]
    guard allowed.contains(argument) else { exit(64) }
    if argument == "--runtime" || argument == "--timeout" {
        index += 1
        guard index < arguments.count else { exit(64) }
        if argument == "--runtime" { runtime = URL(fileURLWithPath: arguments[index], isDirectory: true) }
        else {
            guard let value = TimeInterval(arguments[index]), value.isFinite, value >= 5, value <= 120 else { exit(64) }
            timeout = value
        }
    }
    index += 1
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = LocationApplication(runtime: runtime,
                                   mayAuthorize: arguments.contains("--request-authorization"),
                                   once: arguments.contains("--once"), timeout: timeout)
application.delegate = delegate
application.run()
