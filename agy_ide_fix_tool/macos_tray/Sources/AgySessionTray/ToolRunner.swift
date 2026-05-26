import AppKit
import Foundation

struct ToolOutput {
    let stdout: Data
    let stderr: String
}

enum ToolError: LocalizedError {
    case scriptNotFound
    case nodeNotFound(paths: [String])
    case failed(command: String, code: Int32, stderr: String)
    case invalidUTF8

    var errorDescription: String? {
        switch self {
        case .scriptNotFound:
            return "找不到 agy_ide_fix_tool/src/cli.js"
        case let .nodeNotFound(paths):
            return "找不到 node。已检查：\(paths.joined(separator: ", "))"
        case let .failed(command, code, stderr):
            return "\(command) 失败，退出码 \(code)：\(Self.readableError(from: stderr))"
        case .invalidUTF8:
            return "命令输出不是有效文本"
        }
    }

    private static func readableError(from stderr: String) -> String {
        if stderr.localizedCaseInsensitiveContains("database is locked") {
            return "数据库被占用。请确认 Antigravity 和 Antigravity IDE 已完全退出后再同步。"
        }
        let lines = stderr
            .split(separator: "\n")
            .map(String.init)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return lines.prefix(6).joined(separator: "\n")
    }
}

struct ToolRunner {
    let cliPath: URL
    let nodePath: URL

    init() throws {
        self.cliPath = try Self.findCliPath()
        self.nodePath = try Self.findNodePath()
    }

    func doctor() async throws -> DoctorReport {
        let output = try await run(arguments: ["doctor", "--all", "--json"], allowedExitCodes: [0, 1])
        return try JSONDecoder().decode(DoctorReport.self, from: output.stdout)
    }

    func syncPlan() async throws -> SyncPlan {
        let output = try await run(arguments: ["sync", "plan", "--json"])
        return try JSONDecoder().decode(SyncPlan.self, from: output.stdout)
    }

    func bidirectionalSync() async throws -> SyncResult {
        let output = try await run(arguments: ["sync", "apply", "--bidirectional", "--apply", "--json", "--force"])
        return try JSONDecoder().decode(SyncResult.self, from: output.stdout)
    }

    func repairState(area: String) async throws -> RepairResult {
        let output = try await run(arguments: ["repair", "state", "--area", area, "--mirror-agyhub", "--apply", "--json", "--force"])
        return try JSONDecoder().decode(RepairResult.self, from: output.stdout)
    }

    func repairMissingSummaries(area: String) async throws -> SummaryRepairResult {
        let output = try await run(arguments: ["repair", "summary", "--area", area, "--apply", "--json", "--force"])
        return try JSONDecoder().decode(SummaryRepairResult.self, from: output.stdout)
    }

    func repairProjects(area: String) async throws -> ProjectRepairResult {
        let output = try await run(arguments: ["repair", "projects", "--area", area, "--apply", "--json", "--force"])
        return try JSONDecoder().decode(ProjectRepairResult.self, from: output.stdout)
    }

    func projectRepairPlan(area: String) async throws -> ProjectRepairResult {
        let output = try await run(arguments: ["repair", "projects", "--area", area, "--json"])
        return try JSONDecoder().decode(ProjectRepairResult.self, from: output.stdout)
    }

    private func run(arguments: [String], allowedExitCodes: Set<Int32> = [0]) async throws -> ToolOutput {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = nodePath
            process.arguments = [cliPath.path] + arguments
            process.currentDirectoryURL = cliPath.deletingLastPathComponent().deletingLastPathComponent()
            process.environment = Self.processEnvironment()

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            process.terminationHandler = { process in
                let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
                let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
                if allowedExitCodes.contains(process.terminationStatus) {
                    continuation.resume(returning: ToolOutput(stdout: stdoutData, stderr: stderrText))
                } else {
                    let command = "\(nodePath.path) \(cliPath.path) \(arguments.joined(separator: " "))"
                    continuation.resume(throwing: ToolError.failed(command: command, code: process.terminationStatus, stderr: stderrText))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    private static func processEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let pathEntries = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin"
        ]
        let existing = env["PATH"] ?? ""
        env["PATH"] = (pathEntries + [existing]).filter { !$0.isEmpty }.joined(separator: ":")
        return env
    }

    private static func findNodePath() throws -> URL {
        let fm = FileManager.default
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(NSHomeDirectory())/.local/node/bin/node",
            "\(NSHomeDirectory())/.npm-global/bin/node"
        ]
        if let envNode = ProcessInfo.processInfo.environment["AGY_NODE_PATH"] {
            candidates.insert(envNode, at: 0)
        }
        for candidate in candidates {
            if fm.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        throw ToolError.nodeNotFound(paths: candidates)
    }

    private static func findCliPath() throws -> URL {
        let fm = FileManager.default
        var candidates: [URL] = []

        if let envRoot = ProcessInfo.processInfo.environment["AGY_FIX_TOOL_ROOT"] {
            candidates.append(URL(fileURLWithPath: envRoot))
        }

        candidates.append(URL(fileURLWithPath: fm.currentDirectoryPath))

        if let executable = Bundle.main.executableURL {
            var cursor = executable.deletingLastPathComponent()
            for _ in 0..<8 {
                candidates.append(cursor)
                cursor.deleteLastPathComponent()
            }
        }

        for root in candidates {
            let direct = root.appendingPathComponent("src/cli.js")
            if fm.fileExists(atPath: direct.path) {
                return direct
            }
            let nested = root.appendingPathComponent("agy_ide_fix_tool/src/cli.js")
            if fm.fileExists(atPath: nested.path) {
                return nested
            }
        }

        throw ToolError.scriptNotFound
    }
}

enum AppCloser {
    static let bundleIDs = [
        "com.google.antigravity",
        "com.google.antigravity-ide"
    ]

    static func runningApps() -> [NSRunningApplication] {
        bundleIDs.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
    }

    static func closeAndWait(timeout: TimeInterval = 20) async -> Bool {
        let apps = runningApps()
        if apps.isEmpty { return true }
        for app in apps {
            app.terminate()
        }

        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if runningApps().isEmpty { return true }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return runningApps().isEmpty
    }
}
