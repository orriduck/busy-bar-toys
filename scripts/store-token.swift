import Foundation
import Security

// Secret arrives on stdin; neither argv nor stdout contains it.
let secret = FileHandle.standardInput.readDataToEndOfFile()
guard let input = String(data: secret, encoding: .utf8) else { exit(2) }
let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
guard !value.isEmpty, !value.contains(where: { $0.isWhitespace }) else { exit(2) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "app.busybar.ai-status",
    kSecAttrAccount as String: "busy-bar"
]
let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
if status == errSecItemNotFound {
    var item = query
    item.merge(attributes) { _, new in new }
    status = SecItemAdd(item as CFDictionary, nil)
}
guard status == errSecSuccess else {
    fputs("Keychain store failed (status \(status)).\n", stderr)
    exit(1)
}
print("BUSY token stored in macOS Keychain.")
