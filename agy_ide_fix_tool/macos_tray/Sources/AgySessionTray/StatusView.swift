import AppKit
import SwiftUI
import UserNotifications

enum OverallStatus {
    case loading
    case healthy
    case warning
    case error

    var title: String {
        switch self {
        case .loading: return "读取中"
        case .healthy: return "健康"
        case .warning: return "需要处理"
        case .error: return "读取失败"
        }
    }

    var systemImage: String {
        switch self {
        case .loading: return "arrow.triangle.2.circlepath"
        case .healthy: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    var color: Color {
        switch self {
        case .loading: return .blue
        case .healthy: return .green
        case .warning: return .orange
        case .error: return .red
        }
    }
}

@MainActor
final class StatusViewModel: ObservableObject {
    @Published var doctor: DoctorReport?
    @Published var syncPlan: SyncPlan?
    @Published var persisted: PersistedState
    @Published var isBusy = false
    @Published var errorMessage: String?

    private let store = SyncStore()
    private let runner: ToolRunner?

    var statusIcon: String {
        if isBusy { return "arrow.triangle.2.circlepath" }
        return overallStatus.systemImage
    }

    var overallStatus: OverallStatus {
        if isBusy { return .loading }
        if errorMessage != nil { return .error }
        guard let doctor else { return .loading }
        if !doctor.areas.allSatisfy(\.healthy) { return .warning }
        if pendingOverwriteCount > 0 || pendingForkCount > 0 { return .warning }
        return .healthy
    }

    var agArea: AreaReport? { doctor?.areas.first { $0.area.id == "ag" } }
    var ideArea: AreaReport? { doctor?.areas.first { $0.area.id == "ide" } }
    var agSessionCount: Int { agArea?.counts.conversations ?? 0 }
    var ideSessionCount: Int { ideArea?.counts.conversations ?? 0 }
    var missingSessionCount: Int {
        (syncPlan?.counts.agConversationMissingInIde ?? 0) + (syncPlan?.counts.ideConversationMissingInAg ?? 0)
    }
    var missingSummaryCount: Int {
        (syncPlan?.counts.agSummaryMissingInIde ?? 0) + (syncPlan?.counts.ideSummaryMissingInAg ?? 0)
    }
    var pendingOverwriteCount: Int {
        (syncPlan?.counts.autoReplaceAgFromIde ?? 0) + (syncPlan?.counts.autoReplaceIdeFromAg ?? 0)
    }
    var pendingForkCount: Int { syncPlan?.counts.keepBothConflicts ?? 0 }
    var skippedSameSummaryCount: Int { syncPlan?.counts.skippedSameSummaryConflicts ?? 0 }
    var skippedStableMetadataCount: Int { syncPlan?.counts.skippedStableMetadataConflicts ?? 0 }
    var equivalentFileDifferenceCount: Int { syncPlan?.counts.equivalentFileDifferences ?? skippedSameSummaryCount + skippedStableMetadataCount }
    var contentConflictCount: Int { syncPlan?.counts.contentConflicts ?? 0 }
    var workspaceSyncCount: Int {
        (syncPlan?.counts.sidebarWorkspacesMissingInAg ?? 0) + (syncPlan?.counts.sidebarWorkspacesMissingInIde ?? 0)
    }
    var hasStateReadError: Bool {
        doctor?.areas.contains { area in
            if area.errors?.state != nil { return true }
            return area.errors?.stateRefs?.values.contains { $0 != nil } ?? false
        } ?? false
    }

    var syncDisabledReason: String? {
        if isBusy { return "正在处理当前任务" }
        if runner == nil { return "找不到命令行工具" }
        if errorMessage != nil { return "状态读取失败" }
        if doctor == nil || syncPlan == nil { return "还没有状态数据" }
        if hasStateReadError { return "状态库异常，先修复 Session" }
        return nil
    }

    var canSync: Bool { syncDisabledReason == nil }

    var repairDisabledReason: String? {
        if isBusy { return "正在处理当前任务" }
        if runner == nil { return "找不到命令行工具" }
        if errorMessage != nil { return "状态读取失败" }
        if doctor == nil { return "还没有状态数据" }
        return nil
    }

    var canRepair: Bool { repairDisabledReason == nil }

    var lastSyncText: String {
        guard let last = persisted.lastSyncAt else { return "无记录" }
        return last.formatted(date: .numeric, time: .standard)
    }

    var logURL: URL {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("AgySessionTray/sync.log")
    }

    var backupsURL: URL {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("AgySessionTray/backups", isDirectory: true)
    }

    var conflictsURL: URL {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("AgySessionTray/conflicts", isDirectory: true)
    }

    init() {
        persisted = store.load()
        do {
            runner = try ToolRunner()
        } catch {
            runner = nil
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            guard let runner else {
                throw NSError(domain: "AgySessionTray", code: 2, userInfo: [NSLocalizedDescriptionKey: "找不到 agy_ide_fix_tool/src/cli.js"])
            }
            async let doctorReport = runner.doctor()
            async let planReport = runner.syncPlan()
            doctor = try await doctorReport
            syncPlan = try await planReport
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func syncNow() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            guard let runner else {
                throw NSError(domain: "AgySessionTray", code: 2, userInfo: [NSLocalizedDescriptionKey: "找不到 agy_ide_fix_tool/src/cli.js"])
            }
            let closed = await AppCloser.closeAndWait()
            guard closed else {
                throw NSError(domain: "AgySessionTray", code: 1, userInfo: [NSLocalizedDescriptionKey: "Antigravity 或 Antigravity IDE 未能在 20 秒内退出，同步已取消。"])
            }

            let result = try await runner.bidirectionalSync()
            doctor = try await runner.doctor()
            syncPlan = try await runner.syncPlan()
            persisted.lastSyncAt = Date()
            persisted.lastSyncStatus = "success"
            if let conflicts = result.conflicts {
                persisted.lastSyncMessage = "同步完成；覆盖 \(conflicts.counts.autoReplaceAgFromIde + conflicts.counts.autoReplaceIdeFromAg)，保留两份 \(conflicts.counts.keepBoth)"
            } else {
                persisted.lastSyncMessage = "同步完成"
            }
            store.save(persisted)
            errorMessage = nil
            notifyIfUnhealthy()
        } catch {
            persisted.lastSyncAt = Date()
            persisted.lastSyncStatus = "failed"
            persisted.lastSyncMessage = error.localizedDescription
            store.save(persisted)
            errorMessage = error.localizedDescription
            notify(title: "同步失败", body: error.localizedDescription)
        }
    }

    func repairIndexes() async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            guard let runner else {
                throw NSError(domain: "AgySessionTray", code: 2, userInfo: [NSLocalizedDescriptionKey: "找不到 agy_ide_fix_tool/src/cli.js"])
            }
            let closed = await AppCloser.closeAndWait()
            guard closed else {
                throw NSError(domain: "AgySessionTray", code: 1, userInfo: [NSLocalizedDescriptionKey: "Antigravity 或 Antigravity IDE 未能在 20 秒内退出，修复已取消。"])
            }

            let agRepair = try await runner.repairState(area: "ag")
            let ideRepair = try await runner.repairState(area: "ide")
            let agSummaryRepair = try await runner.repairMissingSummaries(area: "ag")
            let ideSummaryRepair = try await runner.repairMissingSummaries(area: "ide")
            let agProjectRepair = try await runner.repairProjects(area: "ag")
            let ideProjectRepair = try await runner.repairProjects(area: "ide")
            doctor = try await runner.doctor()
            syncPlan = try await runner.syncPlan()
            persisted.lastSyncAt = Date()
            persisted.lastSyncStatus = "success"
            persisted.lastSyncMessage = repairMessage(
                ag: agRepair,
                ide: ideRepair,
                agSummary: agSummaryRepair,
                ideSummary: ideSummaryRepair,
                agProject: agProjectRepair,
                ideProject: ideProjectRepair
            )
            store.save(persisted)
            errorMessage = nil
            notifyIfUnhealthy()
        } catch {
            persisted.lastSyncAt = Date()
            persisted.lastSyncStatus = "failed"
            persisted.lastSyncMessage = error.localizedDescription
            store.save(persisted)
            errorMessage = error.localizedDescription
            notify(title: "修复失败", body: error.localizedDescription)
        }
    }

    func openLog() {
        openFileOrDirectory(logURL, fallbackDirectory: logURL.deletingLastPathComponent())
    }

    func openBackups() {
        openDirectory(backupsURL)
    }

    func openConflicts() {
        openDirectory(conflictsURL)
    }

    private func openDirectory(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    private func openFileOrDirectory(_ url: URL, fallbackDirectory: URL) {
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            try? FileManager.default.createDirectory(at: fallbackDirectory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(fallbackDirectory)
        }
    }

    private func notifyIfUnhealthy() {
        let unhealthy = doctor?.areas.filter { !$0.healthy } ?? []
        guard !unhealthy.isEmpty else { return }
        let details = unhealthy.map { area in
            "\(area.area.label)：未入历史索引 \(area.counts.conversationMissingFromAgyhub)，未入界面索引 \(area.counts.agyhubMissingFromState)"
        }.joined(separator: "；")
        notify(title: "仍有 Session 索引问题", body: details)
    }

    private func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func repairMessage(
        ag: RepairResult,
        ide: RepairResult,
        agSummary: SummaryRepairResult,
        ideSummary: SummaryRepairResult,
        agProject: ProjectRepairResult,
        ideProject: ProjectRepairResult
    ) -> String {
        let fixed = ag.missingCount + ag.staleCount + ide.missingCount + ide.staleCount
        let summaries = agSummary.repairedCount + ideSummary.repairedCount
        let projectSummaries = agProject.summariesUpdated + ideProject.summariesUpdated
        let projectsCreated = agProject.projectsCreated + ideProject.projectsCreated
        let projectFiles = agProject.projectFilesRepaired + ideProject.projectFilesRepaired
        let workspaceStorage = agProject.workspaceStorageCopied + ideProject.workspaceStorageCopied
        let skipped = agSummary.skippedCount + ideSummary.skippedCount
        let remaining = doctor?.areas.reduce(0) { total, area in
            total + area.counts.conversationMissingFromAgyhub + area.counts.agyhubMissingFromState + area.counts.stateMissingFromAgyhub
        } ?? 0
        let handled = fixed + summaries + projectSummaries + projectsCreated + projectFiles + workspaceStorage
        if handled == 0 {
            if skipped > 0 { return "索引检查完成；\(skipped) 条缺失 summary 缺少可用 brain 信息，未写入" }
            return remaining == 0 ? "索引检查完成，未发现需要修复的项目" : "索引检查完成；仍有 \(remaining) 个问题需要其他处理"
        }
        var parts = ["索引修复完成"]
        if fixed > 0 { parts.append("界面索引 \(fixed) 项") }
        if summaries > 0 { parts.append("历史 summary \(summaries) 条") }
        if projectSummaries > 0 { parts.append("项目归属 \(projectSummaries) 条") }
        if projectsCreated > 0 { parts.append("新建项目 \(projectsCreated) 个") }
        if projectFiles > 0 { parts.append("项目文件 \(projectFiles) 个") }
        if workspaceStorage > 0 { parts.append("工作区状态 \(workspaceStorage) 个") }
        if skipped > 0 { parts.append("跳过 \(skipped) 条") }
        if remaining > 0 { parts.append("仍有 \(remaining) 个问题") }
        return parts.joined(separator: "，")
    }
}

struct DashboardView: View {
    @EnvironmentObject private var viewModel: StatusViewModel
    @State private var showSyncConfirmation = false

    var body: some View {
        VStack(spacing: 0) {
            dashboardHeader

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    OverviewStrip()

                    HStack(alignment: .top, spacing: 14) {
                        ProductStatusPanel(title: "Antigravity", area: viewModel.agArea)
                        ProductStatusPanel(title: "Antigravity IDE", area: viewModel.ideArea)
                    }

                    SyncPlanPanel()

                    if let error = viewModel.errorMessage {
                        MessagePanel(title: "错误", message: error, color: .red)
                    } else if let message = viewModel.persisted.lastSyncMessage, !message.isEmpty {
                        MessagePanel(title: "最近结果", message: message, color: viewModel.persisted.lastSyncStatus == "failed" ? .red : .secondary)
                    }
                }
                .padding(16)
            }

            ActionBar(showSyncConfirmation: $showSyncConfirmation)
        }
        .background(.background)
        .alert("开始双向同步？", isPresented: $showSyncConfirmation) {
            Button("取消", role: .cancel) {}
            Button("关闭并同步", role: .destructive) {
                Task { await viewModel.syncNow() }
            }
        } message: {
            Text("将先关闭 Antigravity 和 Antigravity IDE。本次计划：补齐缺失 \(viewModel.missingSessionCount) 个，覆盖较旧会话 \(viewModel.pendingOverwriteCount) 个，保留无法判断的分叉 \(viewModel.pendingForkCount) 个。所有覆盖都会先备份。")
        }
        .task {
            await viewModel.refresh()
        }
    }

    private var dashboardHeader: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: viewModel.overallStatus.systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(viewModel.overallStatus.color)
                .frame(width: 34)

            VStack(alignment: .leading, spacing: 4) {
                Text("Antigravity Sessions")
                    .font(.title2.weight(.semibold))
                Text("最后同步：\(viewModel.lastSyncText)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            StatusPill(title: viewModel.overallStatus.title, color: viewModel.overallStatus.color)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(.bar)
    }
}

struct MenuStatusView: View {
    @EnvironmentObject private var viewModel: StatusViewModel
    @Environment(\.openWindow) private var openWindow
    @State private var showSyncConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Antigravity Sessions")
                        .font(.headline)
                    Text(viewModel.overallStatus.title)
                        .font(.caption)
                        .foregroundStyle(viewModel.overallStatus.color)
                }
                Spacer()
                Image(systemName: viewModel.overallStatus.systemImage)
                    .font(.title3)
                    .foregroundStyle(viewModel.overallStatus.color)
            }

            HStack(spacing: 10) {
                MiniMetric(title: "AG", value: viewModel.agSessionCount)
                MiniMetric(title: "IDE", value: viewModel.ideSessionCount)
                MiniMetric(title: "覆盖", value: viewModel.pendingOverwriteCount)
                MiniMetric(title: "分叉", value: viewModel.pendingForkCount)
            }

            Text("最后同步：\(viewModel.lastSyncText)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            HStack {
                Button {
                    Task { await viewModel.refresh() }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(viewModel.isBusy)

                Button {
                    Task { await viewModel.repairIndexes() }
                } label: {
                    Label("修复 Session", systemImage: "wrench.and.screwdriver")
                }
                .disabled(!viewModel.canRepair)

                Spacer()

                Button {
                    showSyncConfirmation = true
                } label: {
                    Label("同步", systemImage: "arrow.left.arrow.right")
                }
                .disabled(!viewModel.canSync)
            }

            HStack {
                Button("打开主界面") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "main")
                }
                Spacer()
                Button("退出") { NSApp.terminate(nil) }
            }
        }
        .padding(14)
        .frame(width: 320)
        .alert("开始双向同步？", isPresented: $showSyncConfirmation) {
            Button("取消", role: .cancel) {}
            Button("关闭并同步", role: .destructive) {
                Task { await viewModel.syncNow() }
            }
        } message: {
            Text("将先关闭 Antigravity 和 Antigravity IDE。覆盖 \(viewModel.pendingOverwriteCount) 个，保留分叉 \(viewModel.pendingForkCount) 个。")
        }
        .task {
            await viewModel.refresh()
        }
    }
}

struct OverviewStrip: View {
    @EnvironmentObject private var viewModel: StatusViewModel

    var body: some View {
        HStack(spacing: 12) {
            SummaryTile(title: "Antigravity", value: "\(viewModel.agSessionCount)", detail: "sessions", color: .primary)
            SummaryTile(title: "Antigravity IDE", value: "\(viewModel.ideSessionCount)", detail: "sessions", color: .primary)
            SummaryTile(title: "索引健康", value: healthValue, detail: "products", color: healthColor)
            SummaryTile(title: "待处理", value: "\(viewModel.pendingOverwriteCount + viewModel.pendingForkCount)", detail: "覆盖 \(viewModel.pendingOverwriteCount) / 分叉 \(viewModel.pendingForkCount)", color: pendingColor)
        }
    }

    private var healthyCount: Int { viewModel.doctor?.areas.filter(\.healthy).count ?? 0 }
    private var healthValue: String { "\(healthyCount)/\(viewModel.doctor?.areas.count ?? 2)" }
    private var healthColor: Color { healthyCount == (viewModel.doctor?.areas.count ?? 2) ? .green : .orange }
    private var pendingColor: Color { viewModel.pendingOverwriteCount + viewModel.pendingForkCount == 0 ? .green : .orange }
}

struct ProductStatusPanel: View {
    let title: String
    let area: AreaReport?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                StatusPill(title: area?.healthy == true ? "健康" : "异常", color: area?.healthy == true ? .green : .orange)
            }

            MetricsGrid(rows: [
                ("Session", area?.counts.conversations ?? 0),
                ("历史索引", area?.counts.agyhubSummaries ?? 0),
                ("界面索引", area?.counts.stateSummaries ?? 0),
                ("未入历史索引", area?.counts.conversationMissingFromAgyhub ?? 0),
                ("未入界面索引", area?.counts.agyhubMissingFromState ?? 0),
                ("界面残留", area?.counts.stateMissingFromAgyhub ?? 0)
            ], columns: 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct SyncPlanPanel: View {
    @EnvironmentObject private var viewModel: StatusViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("同步计划")
                        .font(.headline)
                    Text("覆盖前会备份；无法判断的分叉会复制到 conflicts 目录")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(title: syncStatusTitle, color: syncStatusColor)
            }

            HStack(alignment: .top, spacing: 16) {
                MetricsGrid(rows: [
                    ("AG 独有 Session", viewModel.syncPlan?.counts.agConversationMissingInIde ?? 0),
                    ("IDE 独有 Session", viewModel.syncPlan?.counts.ideConversationMissingInAg ?? 0),
                    ("AG 独有 summary", viewModel.syncPlan?.counts.agSummaryMissingInIde ?? 0),
                    ("IDE 独有 summary", viewModel.syncPlan?.counts.ideSummaryMissingInAg ?? 0),
                    ("项目列表待同步", viewModel.workspaceSyncCount)
                ], columns: 2)

                Divider()

                MetricsGrid(rows: [
                    ("原始文件差异", viewModel.syncPlan?.counts.rawFileDifferences ?? viewModel.syncPlan?.counts.fileShapeConflicts ?? 0),
                    ("等价稳定差异", viewModel.equivalentFileDifferenceCount),
                    ("需处理冲突", viewModel.contentConflictCount),
                    ("IDE 版本更新", viewModel.syncPlan?.counts.autoReplaceAgFromIde ?? 0),
                    ("AG 版本更新", viewModel.syncPlan?.counts.autoReplaceIdeFromAg ?? 0),
                    ("无法判断，保留副本", viewModel.pendingForkCount),
                    ("摘要完全相同", viewModel.skippedSameSummaryCount),
                    ("仅元信息不同", viewModel.skippedStableMetadataCount)
                ], columns: 2)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
    }

    private var syncStatusTitle: String {
        if viewModel.pendingOverwriteCount + viewModel.pendingForkCount > 0 { return "有风险项" }
        if viewModel.missingSessionCount + viewModel.missingSummaryCount > 0 { return "可补齐" }
        return "无缺失"
    }

    private var syncStatusColor: Color {
        if viewModel.pendingOverwriteCount + viewModel.pendingForkCount > 0 { return .orange }
        if viewModel.missingSessionCount + viewModel.missingSummaryCount > 0 { return .blue }
        return .green
    }
}

struct ActionBar: View {
    @EnvironmentObject private var viewModel: StatusViewModel
    @Binding var showSyncConfirmation: Bool

    var body: some View {
        HStack(spacing: 10) {
            Button {
                Task { await viewModel.refresh() }
            } label: {
                Label(viewModel.isBusy ? "刷新中" : "刷新", systemImage: "arrow.clockwise")
            }
            .disabled(viewModel.isBusy)

            Button {
                viewModel.openLog()
            } label: {
                Label("查看日志", systemImage: "doc.text.magnifyingglass")
            }

            Button {
                viewModel.openBackups()
            } label: {
                Label("备份", systemImage: "archivebox")
            }

            Button {
                viewModel.openConflicts()
            } label: {
                Label("分叉副本", systemImage: "square.stack.3d.up")
            }

            Button {
                Task { await viewModel.repairIndexes() }
            } label: {
                Label("修复 Session", systemImage: "wrench.and.screwdriver")
            }
            .disabled(!viewModel.canRepair)

            Spacer()

            if let reason = viewModel.syncDisabledReason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Button {
                showSyncConfirmation = true
            } label: {
                Label(viewModel.isBusy ? "同步中" : "双向同步", systemImage: "arrow.left.arrow.right")
                    .frame(minWidth: 112)
            }
            .keyboardShortcut("s", modifiers: [.command])
            .buttonStyle(.borderedProminent)
            .disabled(!viewModel.canSync)

            Button("退出") {
                NSApp.terminate(nil)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

struct MetricsGrid: View {
    let rows: [(String, Int)]
    let columns: Int

    init(rows: [(String, Int)], columns: Int = 1) {
        self.rows = rows
        self.columns = max(1, columns)
    }

    var body: some View {
        if columns == 1 {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 7) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        metricLabel(row.0)
                        metricValue(row.1)
                    }
                }
            }
            .font(.callout)
        } else {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: columns),
                alignment: .leading,
                spacing: 7
            ) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 8) {
                        metricLabel(row.0)
                        Spacer(minLength: 4)
                        metricValue(row.1)
                    }
                }
            }
            .font(.callout)
        }
    }

    private func metricLabel(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private func metricValue(_ value: Int) -> some View {
        Text("\(value)")
            .fontWeight(value == 0 ? .regular : .semibold)
            .monospacedDigit()
    }
}

struct SummaryTile: View {
    let title: String
    let value: String
    let detail: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.semibold))
                .foregroundStyle(color)
                .monospacedDigit()
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct MiniMetric: View {
    let title: String
    let value: Int

    var body: some View {
        VStack(spacing: 3) {
            Text("\(value)")
                .font(.headline)
                .monospacedDigit()
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct StatusPill: View {
    let title: String
    let color: Color

    var body: some View {
        Label(title, systemImage: "circle.fill")
            .font(.caption.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(color.opacity(0.12), in: Capsule())
    }
}

struct MessagePanel: View {
    let title: String
    let message: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            Text(message)
                .font(.callout)
                .foregroundStyle(color)
                .lineLimit(3)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
    }
}
