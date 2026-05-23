import SwiftUI

@MainActor
final class StatusViewModel: ObservableObject {
    @Published var doctor: DoctorReport?
    @Published var syncPlan: SyncPlan?
    @Published var persisted: PersistedState
    @Published var isBusy = false
    @Published var errorMessage: String?
    @Published var showSyncConfirmation = false

    private let store = SyncStore()
    private let runner: ToolRunner?

    var statusIcon: String {
        if isBusy { return "arrow.triangle.2.circlepath" }
        if let doctor, doctor.areas.allSatisfy(\.healthy) { return "checkmark.circle" }
        return "exclamationmark.triangle"
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

            _ = try await runner.bidirectionalSync()
            doctor = try await runner.doctor()
            syncPlan = try await runner.syncPlan()
            persisted.lastSyncAt = Date()
            persisted.lastSyncStatus = "success"
            persisted.lastSyncMessage = "同步完成"
            store.save(persisted)
            errorMessage = nil
        } catch {
            persisted.lastSyncAt = Date()
            persisted.lastSyncStatus = "failed"
            persisted.lastSyncMessage = error.localizedDescription
            store.save(persisted)
            errorMessage = error.localizedDescription
        }
    }
}

struct StatusView: View {
    @EnvironmentObject private var viewModel: StatusViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            if let doctor = viewModel.doctor {
                ForEach(doctor.areas) { area in
                    AreaCard(area: area)
                }
            } else {
                Text("暂无状态")
                    .foregroundStyle(.secondary)
            }

            if let syncPlan = viewModel.syncPlan {
                SyncPlanView(plan: syncPlan)
            }

            if let last = viewModel.persisted.lastSyncAt {
                Text("最后同步：\(last.formatted(date: .numeric, time: .standard))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text("最后同步：无记录")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .lineLimit(4)
            }

            Divider()

            HStack {
                Button {
                    Task { await viewModel.refresh() }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(viewModel.isBusy)

                Spacer()

                Button(role: .destructive) {
                    viewModel.showSyncConfirmation = true
                } label: {
                    Label("双向同步", systemImage: "arrow.left.arrow.right")
                }
                .disabled(viewModel.isBusy)
            }

            Button("退出") {
                NSApp.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding(16)
        .alert("同步前需要关闭 Antigravity 和 Antigravity IDE", isPresented: $viewModel.showSyncConfirmation) {
            Button("取消", role: .cancel) {}
            Button("关闭并同步", role: .destructive) {
                Task { await viewModel.syncNow() }
            }
        } message: {
            Text("工具会先退出两个应用，确认退出后再写入会话索引和 state。")
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Antigravity Sessions")
                    .font(.headline)
                Text(viewModel.isBusy ? "处理中" : "手动同步")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: viewModel.statusIcon)
                .font(.title2)
                .foregroundStyle(viewModel.doctor?.areas.allSatisfy(\.healthy) == true ? .green : .orange)
        }
    }
}

struct AreaCard: View {
    let area: AreaReport

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(area.area.label)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Label(area.healthy ? "健康" : "异常", systemImage: area.healthy ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(area.healthy ? .green : .orange)
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                metric("Session", area.counts.conversations)
                metric("agyhub", area.counts.agyhubSummaries)
                metric("state", area.counts.stateSummaries)
                metric("缺 agyhub", area.counts.conversationMissingFromAgyhub)
                metric("缺 state", area.counts.agyhubMissingFromState)
                metric("多余 state", area.counts.stateMissingFromAgyhub)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
    }

    private func metric(_ name: String, _ value: Int) -> some View {
        GridRow {
            Text(name)
                .foregroundStyle(.secondary)
            Text("\(value)")
                .monospacedDigit()
        }
        .font(.caption)
    }
}

struct SyncPlanView: View {
    let plan: SyncPlan

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("同步差异")
                .font(.subheadline.weight(.semibold))
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                metric("AG 独有 Session", plan.counts.agConversationMissingInIde)
                metric("IDE 独有 Session", plan.counts.ideConversationMissingInAg)
                metric("AG 独有 summary", plan.counts.agSummaryMissingInIde)
                metric("IDE 独有 summary", plan.counts.ideSummaryMissingInAg)
                metric("同 ID 文件差异", plan.counts.fileShapeConflicts)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
    }

    private func metric(_ name: String, _ value: Int) -> some View {
        GridRow {
            Text(name)
                .foregroundStyle(.secondary)
            Text("\(value)")
                .monospacedDigit()
        }
        .font(.caption)
    }
}
