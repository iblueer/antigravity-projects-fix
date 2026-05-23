import Foundation

struct DoctorReport: Decodable {
    let ok: Bool
    let generatedAt: String
    let projects: ProjectReport
    let areas: [AreaReport]
}

struct ProjectReport: Decodable {
    let count: Int
    let duplicateGroups: Int
    let brokenFiles: Int
}

struct AreaReport: Decodable, Identifiable {
    let area: AreaIdentity
    let healthy: Bool
    let counts: AreaCounts

    var id: String { area.id }
}

struct AreaIdentity: Decodable {
    let id: String
    let label: String
}

struct AreaCounts: Decodable {
    let conversations: Int
    let agyhubSummaries: Int
    let stateSummaries: Int
    let conversationMissingFromAgyhub: Int
    let agyhubMissingConversation: Int
    let agyhubMissingFromState: Int
    let stateMissingFromAgyhub: Int
}

struct SyncPlan: Decodable {
    let generatedAt: String
    let counts: SyncCounts
}

struct SyncCounts: Decodable {
    let agConversationMissingInIde: Int
    let ideConversationMissingInAg: Int
    let agSummaryMissingInIde: Int
    let ideSummaryMissingInAg: Int
    let fileShapeConflicts: Int
}

struct SyncResult: Decodable {
    let applied: Bool
    let generatedAt: String
    let directions: [SyncDirectionResult]
}

struct SyncDirectionResult: Decodable {
    let plan: OneWayPlan?
    let result: OneWayResult?
}

struct OneWayPlan: Decodable {
    let source: AreaIdentity
    let target: AreaIdentity
}

struct OneWayResult: Decodable {
    let copied: Int
    let summaries: Int
}

struct PersistedState: Codable {
    var lastSyncAt: Date?
    var lastSyncStatus: String?
    var lastSyncMessage: String?
}
