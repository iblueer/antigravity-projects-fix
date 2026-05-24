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
    let rawFileDifferences: Int?
    let equivalentFileDifferences: Int?
    let contentConflicts: Int?
    let autoReplaceAgFromIde: Int?
    let autoReplaceIdeFromAg: Int?
    let keepBothConflicts: Int?
    let skippedSameSummaryConflicts: Int?
    let skippedStableMetadataConflicts: Int?
}

struct SyncResult: Decodable {
    let applied: Bool
    let generatedAt: String
    let directions: [SyncDirectionResult]
    let conflicts: SyncConflictApplyResult?
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
    let stateRepair: RepairResult?
}

struct SyncConflictApplyResult: Decodable {
    let logPath: String?
    let counts: SyncConflictCounts
    let operations: [SyncConflictOperation]
}

struct SyncConflictCounts: Decodable {
    let total: Int
    let autoReplaceAgFromIde: Int
    let autoReplaceIdeFromAg: Int
    let keepBoth: Int
    let skippedSameSummary: Int
    let skippedStableMetadata: Int?
}

struct SyncConflictOperation: Decodable {
    let cid: String
    let action: String
}

struct RepairResult: Decodable {
    let area: AreaIdentity?
    let applied: Bool?
    let beforeCount: Int
    let targetCount: Int
    let missingCount: Int
    let staleCount: Int
    let backup: String?
}

struct SummaryRepairResult: Decodable {
    let area: AreaIdentity
    let applied: Bool
    let missingCount: Int
    let repairableCount: Int
    let skippedCount: Int
    let repairedCount: Int
    let items: [SummaryRepairItem]
}

struct SummaryRepairItem: Decodable {
    let cid: String
    let canRepair: Bool
    let reasons: [String]
    let title: String?
    let workspaceUri: String?
    let project: String?
}

struct PersistedState: Codable {
    var lastSyncAt: Date?
    var lastSyncStatus: String?
    var lastSyncMessage: String?
}
