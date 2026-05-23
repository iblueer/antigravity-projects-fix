import Foundation

struct SyncStore {
    private let fileURL: URL

    init() {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("AgySessionTray", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("state.json")
    }

    func load() -> PersistedState {
        guard let data = try? Data(contentsOf: fileURL) else {
            return PersistedState(lastSyncAt: nil, lastSyncStatus: nil, lastSyncMessage: nil)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(PersistedState.self, from: data)) ?? PersistedState(lastSyncAt: nil, lastSyncStatus: nil, lastSyncMessage: nil)
    }

    func save(_ state: PersistedState) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(state) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}
