import Foundation
import Security

// A dedicated local-input item. Modes are argv; secret values never are.
guard CommandLine.arguments.count == 2 else { exit(1) }
let mode = CommandLine.arguments[1]
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "app.busybar.local-input",
    kSecAttrAccount as String: "busy-bar"
]

func failed() -> Never {
    fputs("Local BUSY input Keychain operation failed.\n", stderr)
    exit(1)
}

switch mode {
case "get":
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    // A background observer must fail instead of opening an authorization UI.
    lookup[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    var item: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &item)
    if status == errSecItemNotFound { exit(2) }
    guard status == errSecSuccess, let data = item as? Data else { failed() }
    FileHandle.standardOutput.write(data)
case "set":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard let input = String(data: secret, encoding: .utf8) else { failed() }
    let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.contains(where: { $0.isWhitespace }) else { failed() }
    let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var entry = query
        entry.merge(attributes) { _, new in new }
        status = SecItemAdd(entry as CFDictionary, nil)
    }
    guard status == errSecSuccess else { failed() }
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { failed() }
default:
    failed()
}
