import AppKit
import Foundation

struct ToolOutput {
    let stdout: Data
    let stderr: String
}

enum ToolError: LocalizedError {
    case scriptNotFound
    case failed(command: String, code: Int32, stderr: String)
    case invalidUTF8

    var errorDescription: String? {
        switch self {
        case .scriptNotFound:
            return "找不到 agy_ide_fix_tool/src/cli.js"
        case let .failed(command, code, stderr):
            return "\(command) 失败，退出码 \(code)：\(stderr)"
        case .invalidUTF8:
            return "命令输出不是有效文本"
        }
    }
}

struct ToolRunner {
    let cliPath: URL

    init() throws {
        self.cliPath = try Self.findCliPath()
    }

    func doctor() async throws -> DoctorReport {
        let output = try await run(arguments: ["doctor", "--all", "--json"])
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

    private func run(arguments: [String]) async throws -> ToolOutput {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", cliPath.path] + arguments
            process.currentDirectoryURL = cliPath.deletingLastPathComponent().deletingLastPathComponent()

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            process.terminationHandler = { process in
                let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
                let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
                if process.terminationStatus == 0 {
                    continuation.resume(returning: ToolOutput(stdout: stdoutData, stderr: stderrText))
                } else {
                    let command = "node \(cliPath.path) \(arguments.joined(separator: " "))"
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
